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
  assert.equal(card.reverted, 1);
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
  assert.equal(card.wastedGasWei, 67_000n);
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
