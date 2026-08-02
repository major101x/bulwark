/**
 * Failure injectors.
 *
 * Each scenario deliberately breaks one thing that kills onchain agents in
 * production. The naive backend has no defence against any of them; KeeperHub
 * claims a defence for most. The harness measures the gap.
 *
 * See SPEC.md §7 for the table these implement.
 */

import type { ExecutionRequest } from '../agent/executor.ts';

export interface Scenario {
  name: string;
  /** False when the scenario cannot run against the current setup. */
  runnable?: boolean;
  /** Why it cannot run. Printed so skipped coverage is never silent. */
  skipReason?: string;
  /**
   * Static gas price, in gwei, for the ethers baselines in this scenario.
   * The baseline's price is fixed when it is constructed, so a scenario that
   * wants to underprice has to say so here. Omitted means "stale but plausible".
   */
  baselineGasGwei?: number;
  /** What real-world failure this stands in for. */
  description: string;
  /** What we expect KeeperHub to do about it. */
  expectedDefence: string;
  /** Transform the base request for trial `attempt`. */
  mutate(base: ExecutionRequest, attempt: number): ExecutionRequest;
}

export const SCENARIOS: Scenario[] = [
  {
    name: 'gas-underpricing',
    // Well under the ~1 gwei Sepolia market, which is what a hardcoded price
    // becomes the moment the network moves.
    baselineGasGwei: 0.05,
    description:
      'Submit below the prevailing base fee, as any agent with a hardcoded gas ' +
      'price does the moment the network gets busy.',
    expectedDefence: 'exponential backoff bumps the price until it lands',
    mutate: (base) => ({
      ...base,
      label: `${base.label}:underpriced`,
      // The naive backend is already pinned to a static gas price below market;
      // this asks KeeperHub for the same underbid so both are given the same
      // bad instruction and we see which one still lands.
      gasPolicy: {
        multipliers: [0.6],
        blocksBetweenBumps: 2,
        privateRouting: false,
        maxCostUsd: 5,
      },
    }),
  },
  {
    name: 'congestion',
    description:
      'Fire many rescues at once, as happens when a price move puts a whole ' +
      'cohort of positions in danger simultaneously.',
    expectedDefence: 'nonce sequencing keeps the queue moving instead of colliding',
    mutate: (base, attempt) => ({
      ...base,
      label: `${base.label}:concurrent-${attempt}`,
    }),
  },
  {
    name: 'nonce-collision',
    runnable: false,
    skipReason: 'neither backend exposes an explicit nonce to collide',
    description:
      'Two transactions claim the same nonce. One is silently dropped, and the ' +
      'agent believes both succeeded.',
    expectedDefence: 'managed nonce allocation makes the collision impossible',
    mutate: (base, attempt) => ({
      ...base,
      label: `${base.label}:nonce-dup-${Math.floor(attempt / 2)}`,
    }),
  },
  {
    name: 'revert',
    description:
      'Repay more than is outstanding. The transaction mines, fails, and burns ' +
      'the gas anyway.',
    expectedDefence: 'pre-flight simulation catches it before submission',
    mutate: (base) => ({
      ...base,
      label: `${base.label}:will-revert`,
      // Transfer far more LINK than the wallet holds. Reverts on chain, and a
      // simulating backend should refuse to submit it at all.
      functionName: 'transfer',
      functionArgs: ['0x000000000000000000000000000000000000dEaD', 10n ** 30n],
    }),
  },
  {
    name: 'rpc-flakiness',
    runnable: false,
    skipReason: 'needs a proxy that can drop connections mid-submit',
    description:
      'The RPC endpoint rate-limits or drops mid-submission, so the agent never ' +
      'learns whether its transaction was accepted.',
    expectedDefence: 'managed infrastructure retries against healthy endpoints',
    mutate: (base) => ({ ...base, label: `${base.label}:flaky-rpc` }),
  },
  {
    name: 'cold-start',
    runnable: false,
    skipReason: 'needs a freshly funded wallet per trial',
    description:
      'A wallet that has never transacted. Nonce starts at zero and several ' +
      'clients mishandle the first submission.',
    expectedDefence: 'correct nonce derivation from chain state',
    mutate: (base) => ({ ...base, label: `${base.label}:cold-start` }),
  },
];
