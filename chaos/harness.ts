/**
 * Chaos harness.
 *
 * Runs identical workloads through KeeperHub and through a naive ethers.js
 * baseline while injecting the failure modes that actually kill onchain agents,
 * then prints a scorecard.
 *
 * The output of this file is the centrepiece of the submission (SPEC.md §7).
 * Most entries will demo a happy path; this measures what happens when the
 * chain does not cooperate.
 *
 * Usage:
 *   npm run chaos -- --scenario gas-underpricing --n 20
 *   npm run chaos -- --all
 */

import { writeFileSync, mkdirSync } from 'node:fs';

import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from '../agent/executor.ts';
import { SCENARIOS, type Scenario } from './injectors.ts';

export interface TrialOutcome extends ExecutionResult {
  backend: string;
  scenario: string;
  attempt: number;
}

export interface Scorecard {
  scenario: string;
  backend: string;
  trials: number;
  executed: number;
  successRate: number;
  medianLatencyMs: number;
  stuck: number;
  reverted: number;
  wastedGasWei: bigint;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

export function score(outcomes: TrialOutcome[]): Scorecard {
  const first = outcomes[0];
  if (!first) throw new Error('cannot score an empty run');

  const executed = outcomes.filter((o) => o.ok);
  // Latency is only meaningful for transactions that actually landed. Averaging
  // in the timeouts would flatter the slow backend by capping its worst cases.
  const latencies = executed.map((o) => o.latencyMs);
  const reverted = outcomes.filter((o) => !o.ok && !o.stuck && o.error === 'reverted');

  return {
    scenario: first.scenario,
    backend: first.backend,
    trials: outcomes.length,
    executed: executed.length,
    successRate: executed.length / outcomes.length,
    medianLatencyMs: median(latencies),
    stuck: outcomes.filter((o) => o.stuck).length,
    reverted: reverted.length,
    // Gas burned on transactions that achieved nothing.
    wastedGasWei: outcomes
      .filter((o) => !o.ok && o.gasUsed)
      .reduce((sum, o) => sum + (o.gasUsed ?? 0n), 0n),
  };
}

export async function runScenario(
  backend: ExecutionBackend,
  scenario: Scenario,
  trials: number,
  baseRequest: ExecutionRequest,
): Promise<TrialOutcome[]> {
  const outcomes: TrialOutcome[] = [];

  for (let attempt = 0; attempt < trials; attempt++) {
    const request = scenario.mutate(baseRequest, attempt);
    let result: ExecutionResult;
    try {
      result = await backend.execute(request);
    } catch (err) {
      result = {
        ok: false,
        latencyMs: 0,
        bumps: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    outcomes.push({
      ...result,
      backend: backend.name,
      scenario: scenario.name,
      attempt,
    });
    process.stdout.write(result.ok ? '.' : result.stuck ? 'T' : 'x');
  }

  process.stdout.write('\n');
  return outcomes;
}

/** Render the markdown table that goes at the top of the README. */
export function renderScorecard(cards: Scorecard[]): string {
  const byScenario = new Map<string, Scorecard[]>();
  for (const card of cards) {
    const list = byScenario.get(card.scenario) ?? [];
    list.push(card);
    byScenario.set(card.scenario, list);
  }

  const lines = [
    '| Scenario | Backend | Executed | Median latency | Stuck | Reverted |',
    '|---|---|---|---|---|---|',
  ];
  for (const [scenario, group] of byScenario) {
    for (const c of group) {
      lines.push(
        `| ${scenario} | ${c.backend} | ${c.executed}/${c.trials} ` +
          `(${(c.successRate * 100).toFixed(0)}%) | ${c.medianLatencyMs}ms ` +
          `| ${c.stuck} | ${c.reverted} |`,
      );
    }
  }
  return lines.join('\n');
}

// --- CLI -------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const nIndex = args.indexOf('--n');
  const trials = nIndex >= 0 ? Number(args[nIndex + 1]) : 10;
  const scenarioIndex = args.indexOf('--scenario');
  const selected = scenarioIndex >= 0 ? args[scenarioIndex + 1] : undefined;

  const chosen = all
    ? SCENARIOS
    : SCENARIOS.filter((s) => s.name === selected);

  if (chosen.length === 0) {
    console.error(
      `No scenario selected. Use --all, or --scenario <name>.\n` +
        `Available: ${SCENARIOS.map((s) => s.name).join(', ')}`,
    );
    process.exit(1);
  }

  console.error(
    'The harness is wired but not yet pointed at live backends.\n' +
      'Before running: fill KEEPERHUB_API_KEY and CHAOS_BASELINE_PRIVATE_KEY in .env,\n' +
      'and set baseRequest below to a real Sepolia target (SPEC.md §7, day 7-8).',
  );
  process.exit(1);

  // Reached once the above guard is removed on day 7.
  mkdirSync('chaos/runs', { recursive: true });
  const cards: Scorecard[] = [];
  writeFileSync(
    `chaos/runs/latest.json`,
    JSON.stringify(cards, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
  );
  console.log(renderScorecard(cards));
  void trials;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
