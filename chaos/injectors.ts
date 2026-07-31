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
    description:
      'Submit below the prevailing base fee, as any agent with a hardcoded gas ' +
      'price does the moment the network gets busy.',
    expectedDefence: 'exponential backoff bumps the price until it lands',
    mutate: (base) => ({
      ...base,
      label: `${base.label}:underpriced`,
      gasPolicy: base.gasPolicy && {
        ...base.gasPolicy,
        // Bid deliberately under the market.
        multipliers: [0.6],
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
      // TODO(day-7): encode a repay for (debt + 1) against the Sepolia pool.
      data: base.data,
    }),
  },
  {
    name: 'rpc-flakiness',
    description:
      'The RPC endpoint rate-limits or drops mid-submission, so the agent never ' +
      'learns whether its transaction was accepted.',
    expectedDefence: 'managed infrastructure retries against healthy endpoints',
    mutate: (base) => ({ ...base, label: `${base.label}:flaky-rpc` }),
  },
  {
    name: 'cold-start',
    description:
      'A wallet that has never transacted. Nonce starts at zero and several ' +
      'clients mishandle the first submission.',
    expectedDefence: 'correct nonce derivation from chain state',
    mutate: (base) => ({ ...base, label: `${base.label}:cold-start` }),
  },
];
