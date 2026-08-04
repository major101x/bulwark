/**
 * Chaos harness.
 *
 * Runs identical workloads through KeeperHub and through a naive ethers.js
 * baseline while injecting the failure modes that actually kill onchain agents,
 * then prints a scorecard.
 *
 *   npm run chaos -- --all
 *   npm run chaos -- --scenario revert --n 3
 *
 * Honest limits, stated up front because a scorecard nobody can trust is worse
 * than none:
 *
 *   - Gas used is unavailable on the KeeperHub side. The direct-execution REST
 *     endpoint returns only { executionId, status }, and there is no REST route
 *     for execution detail. Cells that cannot be measured print "n/a", never 0.
 *   - Latency for KeeperHub includes its queueing and confirmation wait, since
 *     the POST blocks until the execution is terminal. That is the number a
 *     caller actually experiences, so it is the fair one to compare.
 *   - The naive baseline is deliberately unsophisticated: static gas price, one
 *     attempt, no simulation. That is what it is measuring.
 */

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';

import {
  KeeperHubBackend,
  NaiveBackend,
  type ExecutionBackend,
  type ExecutionRequest,
  type ExecutionResult,
} from '../agent/executor.ts';
import { SCENARIOS, type Scenario } from './injectors.ts';
import { clearStuckNonces } from './mempool.ts';

/**
 * Hard ceiling on a single trial, above the backend's own deadline.
 *
 * The backend deadlines only bound the wait for a receipt. They do not bound
 * everything else a call can block on: ethers will happily sit forever
 * resolving a nonce against a wallet whose earlier transactions are stuck, and
 * that wedged two runs before this existed. A trial that blows this budget is
 * recorded as stuck and the run keeps going, because one hung trial must not
 * cost the whole matrix.
 */
const TRIAL_DEADLINE_MS = Number(process.env.CHAOS_TRIAL_DEADLINE_MS ?? '120000');

/**
 * Race a promise against a deadline.
 *
 * The loser is abandoned, not cancelled: there is no way to cancel an in-flight
 * ethers call. It keeps running in the background and may still broadcast, so
 * anything downstream must treat a timed-out trial as "outcome unknown, a
 * transaction may exist" rather than "nothing happened". That is exactly why
 * the harness clears stuck nonces afterwards instead of assuming it is clean.
 */
export async function withDeadline<T>(
  work: () => Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const SEPOLIA = 11155111;
const LINK = '0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5';
const BURN = '0x000000000000000000000000000000000000dEaD';

const ERC20_ABI = [
  {
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'transfer',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];

/**
 * The control workload: approve zero LINK to the burn address. Cheap, safe to
 * repeat, and changes no balance, so thousands of runs are harmless. Scenarios
 * mutate this into whatever failure they are testing.
 */
const BASE_REQUEST: ExecutionRequest = {
  label: 'approve-zero',
  chainId: SEPOLIA,
  to: LINK,
  functionName: 'approve',
  functionArgs: [BURN, 0n],
  abi: ERC20_ABI,
};

export interface TrialOutcome extends ExecutionResult {
  backend: string;
  scenario: string;
  attempt: number;
}

export interface Scorecard {
  scenario: string;
  backend: string;
  trials: number;
  /** Trials discarded because our own network or RPC failed, not the backend. */
  excluded: number;
  /** Trials that actually measured something: trials minus excluded. */
  valid: number;
  executed: number;
  prevented: number;
  successRate: number;
  medianLatencyMs: number;
  stuck: number;
  /** Subset of `stuck` where we stopped waiting rather than observed a miss. */
  abandoned: number;
  failed: number;
  wastedGas: bigint | null;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function score(outcomes: TrialOutcome[]): Scorecard {
  const first = outcomes[0];
  if (!first) throw new Error('cannot score an empty run');

  const excluded = outcomes.filter((o) => o.excluded);
  const valid = outcomes.filter((o) => !o.excluded);
  const executed = valid.filter((o) => o.ok);
  // Latency only from trials that landed. Averaging in timeouts would flatter
  // the slower backend by capping its worst cases at the deadline.
  const latencies = executed.map((o) => o.latencyMs);
  const prevented = valid.filter((o) => o.prevented);
  const withGas = valid.filter((o) => !o.ok && o.gasUsed !== undefined);

  return {
    scenario: first.scenario,
    backend: first.backend,
    trials: outcomes.length,
    excluded: excluded.length,
    valid: valid.length,
    executed: executed.length,
    prevented: prevented.length,
    // Denominator is valid trials. A run where the network died must not read
    // as a backend that failed.
    successRate: valid.length === 0 ? 0 : executed.length / valid.length,
    medianLatencyMs: Math.round(median(latencies)),
    stuck: valid.filter((o) => o.stuck).length,
    abandoned: valid.filter((o) => o.abandoned).length,
    failed: valid.filter((o) => !o.ok && !o.stuck && !o.prevented).length,
    // Only meaningful when the backend reports receipts at all. Null means
    // "not measurable", which is different from zero.
    wastedGas: withGas.length > 0 ? withGas.reduce((s, o) => s + o.gasUsed!, 0n) : null,
  };
}

export async function runScenario(
  backend: ExecutionBackend,
  scenario: Scenario,
  trials: number,
): Promise<TrialOutcome[]> {
  const run = async (attempt: number): Promise<TrialOutcome> => {
    const request = scenario.mutate(BASE_REQUEST, attempt);
    const startedAt = Date.now();
    let result: ExecutionResult;
    try {
      result = await withDeadline(
        () => backend.execute(request),
        TRIAL_DEADLINE_MS,
        () => ({
          ok: false,
          latencyMs: Date.now() - startedAt,
          bumps: 0,
          stuck: true,
          abandoned: true,
          error: `trial exceeded ${TRIAL_DEADLINE_MS}ms and was abandoned`,
        }),
      );
    } catch (err) {
      result = {
        ok: false,
        latencyMs: Date.now() - startedAt,
        bumps: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    process.stdout.write(
        result.excluded
        ? '-'
        : result.ok
          ? '.'
          : result.prevented
            ? 'P'
            : result.abandoned
              ? 'A'
              : result.stuck
                ? 'T'
                : 'x',
    );
    return { ...result, backend: backend.name, scenario: scenario.name, attempt };
  };

  // Congestion is the whole point of that scenario, so it fires concurrently.
  // Everything else runs sequentially so nonce effects stay attributable.
  const outcomes =
    scenario.name === 'congestion'
      ? await Promise.all(Array.from({ length: trials }, (_, i) => run(i)))
      : await (async () => {
          const acc: TrialOutcome[] = [];
          for (let i = 0; i < trials; i++) acc.push(await run(i));
          return acc;
        })();

  process.stdout.write('\n');
  return outcomes;
}

export function renderScorecard(cards: Scorecard[]): string {
  const lines = [
    '| Scenario | Backend | Landed | Prevented | Stuck | Abandoned | Failed | Excluded | Median latency | Wasted gas |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const c of cards) {
    lines.push(
      `| ${c.scenario} | ${c.backend} | ${c.executed}/${c.valid} ` +
        `(${c.valid === 0 ? 'no data' : (c.successRate * 100).toFixed(0) + '%'}) ` +
        `| ${c.prevented} | ${c.stuck} ` +
        `| ${c.abandoned} | ${c.failed} | ${c.excluded} | ${c.medianLatencyMs}ms | ` +
        `${c.wastedGas === null ? 'n/a' : c.wastedGas.toString()} |`,
    );
  }
  return lines.join('\n');
}

// --- CLI -------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const nIndex = args.indexOf('--n');
  const trials = nIndex >= 0 ? Number(args[nIndex + 1]) : 3;
  const scenarioIndex = args.indexOf('--scenario');
  const selected = scenarioIndex >= 0 ? args[scenarioIndex + 1] : undefined;

  const runnable = SCENARIOS.filter((s) => s.runnable !== false);
  const chosen = all ? runnable : runnable.filter((s) => s.name === selected);

  if (chosen.length === 0) {
    console.error(
      `No runnable scenario selected. Use --all, or --scenario <name>.\n` +
        `Available: ${runnable.map((s) => s.name).join(', ')}`,
    );
    process.exit(1);
  }

  const skipped = SCENARIOS.filter((s) => s.runnable === false);
  if (skipped.length > 0) {
    // Silent truncation reads as full coverage. Say what was left out.
    console.log(
      `Not run (${skipped.length}): ` +
        skipped.map((s) => `${s.name} (${s.skipReason})`).join(', ') +
        '\n',
    );
  }

  const keeperhub = new KeeperHubBackend({
    apiKey: process.env.KEEPERHUB_API_KEY ?? '',
    apiUrl: process.env.KEEPERHUB_API_URL ?? 'https://app.keeperhub.com',
  });
  const rpc =
    process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
  const key = process.env.CHAOS_BASELINE_PRIVATE_KEY ?? '';
  // A plausible static gas price chosen once and never revisited, which is what
  // a hardcoded agent looks like once the network moves.
  // Sepolia sits near 1 gwei. A stale-but-plausible 1.5 keeps the baseline
  // competitive in every scenario except the one that deliberately underprices,
  // otherwise every naive transaction is stuck and the comparison says nothing.
  const staticGwei = Number(process.env.CHAOS_STATIC_GAS_GWEI ?? '1.5');
  const deadline = Number(process.env.CHAOS_DEADLINE_MS ?? '90000');

  const baselines = (gwei: number) => [
    new NaiveBackend(rpc, key, gwei, deadline),
    // Same code path with estimation defeated by a hardcoded gas limit.
    new NaiveBackend(rpc, key, gwei, deadline, 120_000n, 'naive-blind'),
  ];

  const cards: Scorecard[] = [];
  const raw: TrialOutcome[] = [];

  for (const scenario of chosen) {
    console.log(`\n## ${scenario.name}`);
    console.log(`   ${scenario.description}`);
    console.log(`   expect: ${scenario.expectedDefence}`);
    for (const backend of [
      keeperhub,
      ...baselines(scenario.baselineGasGwei ?? staticGwei),
    ]) {
      process.stdout.write(`   ${backend.name.padEnd(12)} `);
      const outcomes = await runScenario(backend, scenario, trials);
      raw.push(...outcomes);
      cards.push(score(outcomes));

      // Leaving stuck transactions behind is how a previous run produced a cell
      // that measured nothing. Clear before the next backend rather than after
      // the whole matrix, so no two cells can share a wedged wallet.
      if (backend.name !== 'keeperhub') {
        const report = await clearStuckNonces(rpc, key, (line) => console.log(line));
        if (report.stuck > 0) {
          console.log(
            `   cleaned up ${report.cleared}/${report.stuck} stuck` +
              (report.failed > 0 ? `, ${report.failed} still wedged` : ''),
          );
        }
      }
    }
  }

  mkdirSync('chaos/runs', { recursive: true });
  const stamp = raw.length > 0 ? String(raw.length) : 'empty';
  writeFileSync(
    `chaos/runs/latest-${stamp}.json`,
    JSON.stringify({ cards, raw }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
  );

  console.log(`\n\n${renderScorecard(cards)}\n`);
  console.log(
    'Legend: . landed   P prevented pre-flight   T stuck   ' +
      'A abandoned at trial deadline   x failed   - excluded (our network/RPC)',
  );

  const abandoned = raw.filter((r) => r.abandoned).length;
  if (abandoned > 0) {
    console.log(
      `\n${abandoned} trial(s) hit the ${TRIAL_DEADLINE_MS}ms hard deadline. ` +
        'Their transactions may still have been broadcast, so treat those ' +
        'cells as "outcome unknown" rather than as failures.',
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
