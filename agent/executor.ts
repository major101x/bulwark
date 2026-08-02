/**
 * Execution backends.
 *
 * Everything that touches a chain goes through `ExecutionBackend`. There are
 * two implementations and the chaos harness runs identical workloads against
 * both:
 *
 *   KeeperHubBackend: simulation, gas escalation, nonce management, private
 *                     routing, and gas sponsorship. Keys stay in enclaves.
 *   NaiveBackend:     plain ethers.js with a static gas price and no retry.
 *                     What most agents actually ship, and the baseline whose
 *                     failure rate we are trying to measure.
 *
 * Response parsing follows the shapes in `keeperhub-types.ts`, which were
 * transcribed from real executions rather than from the docs. The REST paths
 * below are still the documented ones and remain unconfirmed: our verified
 * executions went through the MCP tools. See `TO VERIFY` markers.
 */

import type { GasPolicy } from './risk.ts';

export interface ExecutionRequest {
  /** Human label for logs and the chaos scorecard. */
  label: string;
  chainId: number;
  to: string;
  /** Solidity function to call. */
  functionName: string;
  /** Arguments, in the order the ABI declares them. */
  functionArgs?: unknown[];
  /** ABI fragment array. Omitted for verified contracts, which auto-resolve. */
  abi?: unknown[];
  /** Native value in wei. Usually zero; we move ERC20s. */
  value?: bigint;
  gasPolicy?: GasPolicy;
  /**
   * Stable key so a retried rescue cannot execute twice. KeeperHub returns the
   * original result for a repeat of the same key within 24h, which is the
   * difference between a retry and a double spend when our process restarts
   * mid-rescue.
   */
  idempotencyKey?: string;
}

export interface ExecutionResult {
  ok: boolean;
  txHash?: string;
  /** Wall-clock milliseconds from submit to confirmed. */
  latencyMs: number;
  /** How many times the gas price was bumped before inclusion. */
  bumps: number;
  gasUsed?: bigint;
  effectiveGasPriceGwei?: number;
  /** Populated when ok is false. */
  error?: string;
  /** KeeperHub execution id, for cross-referencing the audit trail. */
  executionId?: string;
  /** Set when the transaction never mined within the deadline. */
  stuck?: boolean;
  /** Whether KeeperHub covered the gas. Observed true on Sepolia as well. */
  sponsored?: boolean;
  /**
   * The call was refused before submission, typically by simulation. Distinct
   * from a failure: nothing was broadcast and no gas was burned.
   */
  prevented?: boolean;
}

export interface ExecutionBackend {
  readonly name: 'keeperhub' | 'naive' | 'naive-blind';
  execute(req: ExecutionRequest): Promise<ExecutionResult>;
}

// --- KeeperHub -------------------------------------------------------------

export interface KeeperHubConfig {
  apiKey: string;
  apiUrl: string;
}

/** Sepolia and mainnet both target ~12s blocks. */
const ONE_BLOCK_MS = 12_000;

export class KeeperHubBackend implements ExecutionBackend {
  readonly name = 'keeperhub' as const;

  constructor(private readonly config: KeeperHubConfig) {}

  /**
   * Retry transient transport failures only.
   *
   * `fetch failed` is a connection-level error, not an answer from the API, and
   * treating it as a KeeperHub failure would put network flakiness on
   * KeeperHub's side of the scorecard. Anything that got an HTTP response is
   * left alone, since retrying a real rejection would be measuring nothing.
   */
  private async withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        last = err;
        const transport = /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(
          err instanceof Error ? err.message : String(err),
        );
        if (!transport) throw err;
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
    throw last;
  }

  /**
   * REST transport. Paths and field casing verified against a live account on
   * 2026-08-02 by probing; they are NOT what the docs implied.
   *
   *   POST /api/execute/:actionType     e.g. /api/execute/contract-call
   *   POST /api/workflows/:id/execute
   *   GET  /api/workflows/:id/executions
   *
   * Note there is no `v1` segment, the body is camelCase (the MCP tool takes
   * snake_case for the same fields), and `functionArgs` and `abi` must be JSON
   * *strings* rather than JSON values.
   */
  private async request<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
    const res = await fetch(`${this.config.apiUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      // bigint is the natural type for token amounts but JSON.stringify throws
      // on it, so encode as decimal strings, which is what the API wants.
      body:
        body === undefined
          ? undefined
          : JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`KeeperHub ${method} ${path} -> ${res.status} ${text}`);
    }
    return JSON.parse(text) as T;
  }

  /**
   * Run a workflow and wait for it to settle. Workflow executions are the only
   * path that exposes transaction hashes and gas over REST, via the executions
   * listing, so anything needing a receipt goes through here.
   */
  async runWorkflow(
    workflowId: string,
    inputs: Record<string, unknown> = {},
  ): Promise<ExecutionResult> {
    const started = Date.now();
    const { executionId } = await this.request<{ executionId: string }>(
      `/api/workflows/${workflowId}/execute`,
      { input: inputs },
    );
    return this.pollWorkflow(workflowId, executionId, started);
  }

  /**
   * Direct contract call.
   *
   * The POST blocks until the execution reaches a terminal state and returns
   * only `{ executionId, status }`. There is no REST route for direct-execution
   * detail (the MCP server has `get_direct_execution_status`, but nothing
   * equivalent is reachable over HTTP), so gas and transaction hash are simply
   * not available on this path. We report them as undefined rather than
   * guessing, and the chaos scorecard marks the cell unavailable instead of
   * printing a zero that would read as "no gas wasted".
   */
  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    const started = Date.now();
    try {
      const res = await this.withRetry(() =>
        this.request<{ executionId: string; status: string }>(
        '/api/execute/contract-call',
        {
          contractAddress: req.to,
          chainId: String(req.chainId),
          functionName: req.functionName,
          functionArgs: JSON.stringify(req.functionArgs ?? [], (_k, v) =>
            typeof v === 'bigint' ? v.toString() : v,
          ),
          abi: req.abi === undefined ? undefined : JSON.stringify(req.abi),
          idempotencyKey: req.idempotencyKey,
          ...(req.gasPolicy?.multipliers.at(-1) !== undefined
            ? { priorityFeeGwei: String(req.gasPolicy.multipliers.at(-1)) }
            : {}),
        },
        ),
      );
      const latencyMs = Date.now() - started;
      const ok = res.status === 'completed';
      return {
        ok,
        latencyMs,
        bumps: 0,
        executionId: res.executionId,
        // A failure returned faster than one block cannot have been mined, so
        // nothing was broadcast and no gas was burned: KeeperHub refused it at
        // simulation. This is an inference from latency, not a field the API
        // returns, because there is no REST route for execution detail. It is
        // labelled as inferred wherever it is reported.
        prevented: !ok && latencyMs < ONE_BLOCK_MS,
        error: ok ? undefined : res.status,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        latencyMs: Date.now() - started,
        bumps: 0,
        // A pre-flight rejection is KeeperHub refusing to submit a call it
        // knows will fail. That is a success for reliability purposes even
        // though the request errored, so the harness counts it separately.
        prevented: /revert|simulat|estimate/i.test(message),
        error: message,
      };
    }
  }

  /** Poll a workflow execution through the executions listing. */
  private async pollWorkflow(
    workflowId: string,
    executionId: string,
    startedAt: number,
    timeoutMs = 5 * 60_000,
  ): Promise<ExecutionResult> {
    while (Date.now() - startedAt < timeoutMs) {
      const list = await this.request<WorkflowExecutionSummary[]>(
        `/api/workflows/${workflowId}/executions`,
        undefined,
        'GET',
      );
      const run = list.find((e) => e.id === executionId);

      if (run && run.status !== 'running' && run.status !== 'pending') {
        const hashes = run.transactionHashes ?? [];
        return {
          ok: run.status === 'success',
          txHash: hashes.at(-1)?.hash,
          latencyMs: Date.now() - startedAt,
          bumps: 0,
          gasUsed: run.gasUsedWei ? BigInt(run.gasUsedWei) : undefined,
          error: run.status === 'success' ? undefined : (run.error ?? run.status),
        };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      bumps: 0,
      stuck: true,
      error: 'timed out waiting for inclusion',
    };
  }
}

interface WorkflowExecutionSummary {
  id: string;
  status: string;
  error: string | null;
  gasUsedWei: string | null;
  transactionHashes?: Array<{ hash: string; nodeId: string; nodeName: string }>;
}

// --- Naive baseline --------------------------------------------------------

/**
 * The control group for the chaos harness. Static gas price, single attempt,
 * no simulation, no nonce reconciliation. Every shortcoming here is
 * deliberate: this is the baseline we are measuring against, and making it
 * artificially competent would flatter our own numbers.
 */
export class NaiveBackend implements ExecutionBackend {
  get name(): 'naive' | 'naive-blind' {
    return this.label;
  }

  constructor(
    private readonly rpcUrl: string,
    private readonly privateKey: string,
    /** Fixed gas price in gwei. Never adjusted, which is the whole point. */
    private readonly staticGasGwei = 10,
    private readonly deadlineMs = 5 * 60_000,
    /**
     * When set, the transaction carries this gas limit and ethers skips
     * `estimateGas` entirely.
     *
     * This matters more than it looks. ethers estimates by default, and that
     * estimate reverts before anything is broadcast, so a plain ethers agent is
     * already protected against doomed calls. Agents defeat that protection on
     * purpose: hardcoding a limit saves an RPC round trip and stops estimation
     * failures from blocking sends. That is when reverts start costing real gas.
     */
    private readonly fixedGasLimit?: bigint,
    private readonly label: 'naive' | 'naive-blind' = 'naive',
  ) {}

  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    const started = Date.now();
    const { Interface, JsonRpcProvider, Wallet, parseUnits } = await import('ethers');
    const provider = new JsonRpcProvider(this.rpcUrl);
    const wallet = new Wallet(this.privateKey, provider);

    try {
      // The naive path encodes calldata itself and submits it blind: no
      // simulation, so a call that will revert is broadcast anyway and burns
      // gas. That is the behaviour under measurement, not an oversight.
      const data = new Interface(
        (req.abi ?? []) as never,
      ).encodeFunctionData(req.functionName, req.functionArgs ?? []);

      const sent = await wallet.sendTransaction({
        to: req.to,
        data,
        value: req.value ?? 0n,
        gasPrice: parseUnits(String(this.staticGasGwei), 'gwei'),
        ...(this.fixedGasLimit === undefined ? {} : { gasLimit: this.fixedGasLimit }),
      });

      const receipt = await Promise.race([
        sent.wait(),
        new Promise<null>((r) => setTimeout(() => r(null), this.deadlineMs)),
      ]);

      if (receipt === null) {
        return {
          ok: false,
          txHash: sent.hash,
          latencyMs: Date.now() - started,
          bumps: 0,
          stuck: true,
          error: 'not mined before deadline',
        };
      }

      return {
        ok: receipt.status === 1,
        txHash: sent.hash,
        latencyMs: Date.now() - started,
        bumps: 0,
        gasUsed: receipt.gasUsed,
        effectiveGasPriceGwei: this.staticGasGwei,
        error: receipt.status === 1 ? undefined : 'reverted',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        latencyMs: Date.now() - started,
        bumps: 0,
        // "Prevented" means the call was refused BECAUSE it would revert, which
        // is the defence working. An estimateGas error on its own does not
        // qualify: a rate-limited or unavailable RPC also fails to estimate,
        // and counting that as a save would credit the baseline for an outage.
        // Require evidence the node actually decoded a revert.
        prevented:
          /execution reverted|revert=|CALL_EXCEPTION/i.test(message) &&
          !/missing revert data/i.test(message),
        error: message,
      };
    }
  }
}
