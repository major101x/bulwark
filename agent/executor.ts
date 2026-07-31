/**
 * Execution backends.
 *
 * Everything that touches a chain goes through `ExecutionBackend`. There are
 * two implementations and the chaos harness runs identical workloads against
 * both:
 *
 *   KeeperHubBackend: simulation, gas escalation, nonce management, private
 *                      routing. Keys stay in Turnkey enclaves.
 *   NaiveBackend:     plain ethers.js with a static gas price and no retry.
 *                      What most agents actually ship, and the baseline whose
 *                      failure rate we are trying to measure.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * VERIFY BEFORE RELYING ON THIS FILE (SPEC.md §14)
 * The KeeperHub request/response shapes below are written from the published
 * docs but have NOT been exercised against a live account yet. Confirm the
 * endpoint paths and payload field names on day one, either by calling the
 * MCP tools (`execute_workflow`, `execute_protocol_action`) and inspecting the
 * wire format, or from the REST reference at docs.keeperhub.com.
 * ─────────────────────────────────────────────────────────────────────────
 */

import type { GasPolicy } from './risk.ts';

export interface ExecutionRequest {
  /** Human label for logs and the chaos scorecard. */
  label: string;
  chainId: number;
  to: string;
  /** ABI-encoded calldata. */
  data: string;
  /** Native value in wei. Usually zero; we move ERC20s. */
  value?: bigint;
  gasPolicy?: GasPolicy;
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
  /** Set when the transaction never mined within the deadline. */
  stuck?: boolean;
}

export interface ExecutionBackend {
  readonly name: 'keeperhub' | 'naive';
  execute(req: ExecutionRequest): Promise<ExecutionResult>;
}

// --- KeeperHub -------------------------------------------------------------

export interface KeeperHubConfig {
  apiKey: string;
  apiUrl: string;
}

export class KeeperHubBackend implements ExecutionBackend {
  readonly name = 'keeperhub' as const;

  constructor(private readonly config: KeeperHubConfig) {}

  private async request<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.config.apiUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`KeeperHub ${path} -> ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  /**
   * Run a workflow built in the visual editor and wait for it to settle.
   * Used for the rescue paths, which are multi-step (approve, act, re-read the
   * health factor, branch on whether the fix actually worked).
   */
  async runWorkflow(
    workflowId: string,
    inputs: Record<string, unknown>,
  ): Promise<ExecutionResult> {
    const started = Date.now();
    // TO VERIFY: path and payload shape.
    const { executionId } = await this.request<{ executionId: string }>(
      '/api/v1/workflows/execute',
      { workflowId, inputs },
    );
    return this.poll(executionId, started);
  }

  /**
   * Direct contract call, for single-step actions like a mainnet attestation.
   */
  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    const started = Date.now();
    // TO VERIFY: path and payload shape.
    const { executionId } = await this.request<{ executionId: string }>(
      '/api/v1/execute/contract-call',
      {
        chainId: req.chainId,
        to: req.to,
        data: req.data,
        value: (req.value ?? 0n).toString(),
        gas: req.gasPolicy
          ? {
              multipliers: req.gasPolicy.multipliers,
              blocksBetweenBumps: req.gasPolicy.blocksBetweenBumps,
              privateRouting: req.gasPolicy.privateRouting,
            }
          : undefined,
      },
    );
    return this.poll(executionId, started);
  }

  /** Poll until the execution reaches a terminal state or we give up. */
  private async poll(
    executionId: string,
    startedAt: number,
    timeoutMs = 5 * 60_000,
  ): Promise<ExecutionResult> {
    let bumps = 0;
    while (Date.now() - startedAt < timeoutMs) {
      // TO VERIFY: path, and the field names on the status payload.
      const status = await this.request<{
        state: 'pending' | 'submitted' | 'confirmed' | 'failed';
        txHash?: string;
        gasUsed?: string;
        effectiveGasPriceGwei?: number;
        attempts?: number;
        error?: string;
      }>('/api/v1/executions/get', { executionId });

      bumps = Math.max(bumps, (status.attempts ?? 1) - 1);

      if (status.state === 'confirmed') {
        return {
          ok: true,
          txHash: status.txHash,
          latencyMs: Date.now() - startedAt,
          bumps,
          gasUsed: status.gasUsed ? BigInt(status.gasUsed) : undefined,
          effectiveGasPriceGwei: status.effectiveGasPriceGwei,
        };
      }
      if (status.state === 'failed') {
        return {
          ok: false,
          txHash: status.txHash,
          latencyMs: Date.now() - startedAt,
          bumps,
          error: status.error ?? 'execution failed',
        };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      bumps,
      stuck: true,
      error: 'timed out waiting for inclusion',
    };
  }
}

// --- Naive baseline --------------------------------------------------------

/**
 * The control group for the chaos harness. Static gas price, single attempt,
 * no simulation, no nonce reconciliation. Every shortcoming here is
 * deliberate: this is the baseline we are measuring against, and making it
 * artificially competent would flatter our own numbers.
 */
export class NaiveBackend implements ExecutionBackend {
  readonly name = 'naive' as const;

  constructor(
    private readonly rpcUrl: string,
    private readonly privateKey: string,
    /** Fixed gas price in gwei. Never adjusted, which is the whole point. */
    private readonly staticGasGwei = 10,
    private readonly deadlineMs = 5 * 60_000,
  ) {}

  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    const started = Date.now();
    const { JsonRpcProvider, Wallet, parseUnits } = await import('ethers');
    const provider = new JsonRpcProvider(this.rpcUrl);
    const wallet = new Wallet(this.privateKey, provider);

    try {
      const sent = await wallet.sendTransaction({
        to: req.to,
        data: req.data,
        value: req.value ?? 0n,
        gasPrice: parseUnits(String(this.staticGasGwei), 'gwei'),
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
      return {
        ok: false,
        latencyMs: Date.now() - started,
        bumps: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
