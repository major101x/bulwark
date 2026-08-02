import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderScorecard, score, type TrialOutcome } from './harness.ts';

const outcome = (over: Partial<TrialOutcome> = {}): TrialOutcome => ({
  backend: 'naive',
  scenario: 'gas-underpricing',
  attempt: 0,
  ok: true,
  latencyMs: 1000,
  bumps: 0,
  ...over,
});

test('success rate counts only transactions that landed', () => {
  const card = score([
    outcome({ ok: true }),
    outcome({ ok: false, stuck: true }),
    outcome({ ok: false, error: 'reverted' }),
    outcome({ ok: true }),
  ]);
  assert.equal(card.trials, 4);
  assert.equal(card.executed, 2);
  assert.equal(card.successRate, 0.5);
  assert.equal(card.stuck, 1);
  assert.equal(card.failed, 1);
});

test('median latency excludes failures, so timeouts cannot flatter a backend', () => {
  const card = score([
    outcome({ ok: true, latencyMs: 10 }),
    outcome({ ok: true, latencyMs: 30 }),
    // A stuck trial sat for the full 5 minute deadline. Including it would drag
    // the median of a *failing* backend upward in a way that reads as slow but
    // honest, when in fact the transaction never landed at all.
    outcome({ ok: false, stuck: true, latencyMs: 300_000 }),
  ]);
  assert.equal(card.medianLatencyMs, 20);
});

test('median handles odd and even counts', () => {
  const odd = score([
    outcome({ latencyMs: 10 }),
    outcome({ latencyMs: 50 }),
    outcome({ latencyMs: 30 }),
  ]);
  assert.equal(odd.medianLatencyMs, 30);
});

test('wasted gas sums only failed transactions', () => {
  const card = score([
    outcome({ ok: true, gasUsed: 100_000n }),
    outcome({ ok: false, error: 'reverted', gasUsed: 46_000n }),
    outcome({ ok: false, error: 'reverted', gasUsed: 21_000n }),
  ]);
  assert.equal(card.wastedGas, 67_000n);
});

test('unmeasurable wasted gas is null, never zero', () => {
  // A backend that reports no receipts must not appear to have wasted no gas.
  // Zero is a claim; null is the absence of one.
  const card = score([outcome({ ok: false, error: 'boom' })]);
  assert.equal(card.wastedGas, null);
  assert.match(renderScorecard([card]), /n\/a/);
});

test('a prevented call is counted apart from a failure', () => {
  // Refusing to submit a doomed call is the defence working, not an outage.
  const card = score([
    outcome({ ok: false, prevented: true }),
    outcome({ ok: false, error: 'reverted' }),
  ]);
  assert.equal(card.prevented, 1);
  assert.equal(card.failed, 1);
});

test('scoring an empty run is an error, not a silent zero', () => {
  assert.throws(() => score([]), /empty run/);
});

test('scorecard renders both backends under each scenario', () => {
  const table = renderScorecard([
    score([outcome({ backend: 'keeperhub', ok: true })]),
    score([outcome({ backend: 'naive', ok: false, stuck: true })]),
  ]);
  assert.match(table, /keeperhub/);
  assert.match(table, /naive/);
  assert.match(table, /gas-underpricing/);
});

test('an RPC that merely fails to estimate is not counted as a save', () => {
  // "missing revert data" means the node could not estimate, which happens on
  // rate limits and outages. Crediting that as a prevented call would score an
  // infrastructure failure as a reliability feature.
  const card = score([
    outcome({ ok: false, prevented: false, error: 'missing revert data (action="estimateGas")' }),
  ]);
  assert.equal(card.prevented, 0);
  assert.equal(card.failed, 1);
});
