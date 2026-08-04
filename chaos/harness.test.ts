import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderScorecard, score, withDeadline, type TrialOutcome } from './harness.ts';

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

// --- hard trial deadline ---------------------------------------------------

test('a trial that resolves in time is returned untouched', async () => {
  const r = await withDeadline(async () => 'done', 1000, () => 'timeout');
  assert.equal(r, 'done');
});

test('a hung trial is abandoned at the deadline instead of wedging the run', async () => {
  // The regression this exists for: two runs had to be killed because a stuck
  // baseline transaction made ethers block forever inside backend.execute.
  const started = Date.now();
  const r = await withDeadline(
    () => new Promise<string>(() => {}), // never settles
    120,
    () => 'abandoned',
  );
  assert.equal(r, 'abandoned');
  assert.ok(Date.now() - started < 2000, 'deadline must actually fire');
});

test('a rejecting trial still propagates, so real errors are not masked', async () => {
  await assert.rejects(
    () => withDeadline(async () => { throw new Error('boom'); }, 1000, () => 'x'),
    /boom/,
  );
});

test('abandoned trials are scored apart from observed non-inclusion', () => {
  // "Stuck" is an observation: we watched it not get mined. "Abandoned" means
  // we stopped waiting and cannot say what happened, which is weaker and must
  // not be reported as though we measured it.
  const card = score([
    outcome({ ok: false, stuck: true, abandoned: true }),
    outcome({ ok: false, stuck: true }),
  ]);
  assert.equal(card.stuck, 2);
  assert.equal(card.abandoned, 1);
});

// --- apparatus failures ----------------------------------------------------

test('our own network failing does not count against the backend', () => {
  // The regression: two KeeperHub trials failed with "fetch failed" from our
  // side and were scored 1/3, which reads as a KeeperHub reliability problem.
  const card = score([
    outcome({ ok: true }),
    outcome({ ok: false, excluded: true, error: 'fetch failed' }),
    outcome({ ok: false, excluded: true, error: 'fetch failed' }),
  ]);
  assert.equal(card.trials, 3);
  assert.equal(card.excluded, 2);
  assert.equal(card.valid, 1);
  assert.equal(card.executed, 1);
  assert.equal(card.successRate, 1, 'rate is over valid trials, not all trials');
});

test('a cell with no valid trials reports no data rather than 0%', () => {
  const card = score([
    outcome({ ok: false, excluded: true, error: 'missing revert data' }),
    outcome({ ok: false, excluded: true, error: 'missing revert data' }),
  ]);
  assert.equal(card.valid, 0);
  assert.match(renderScorecard([card]), /no data/);
});

test('excluded trials are not also counted as failures or stuck', () => {
  const card = score([
    outcome({ ok: false, excluded: true, stuck: true, error: 'fetch failed' }),
    outcome({ ok: false, stuck: true }),
  ]);
  assert.equal(card.stuck, 1, 'only the genuine non-inclusion counts');
  assert.equal(card.failed, 0);
});
