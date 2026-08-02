import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_LOSS_PARAMS,
  TIER_BOUNDS,
  classify,
  expectedLiquidationLoss,
  gasCostUsd,
  gasPolicyFor,
  horizonHours,
  liquidationProbability,
  pollIntervalBlocks,
  priceHeadroom,
} from './risk.ts';
import type { PositionSnapshot } from './types.ts';

const position = (healthFactor: number, debtUsd = 10_000): PositionSnapshot => ({
  wallet: '0x0000000000000000000000000000000000000001',
  healthFactor,
  totalDebtUsd: debtUsd,
  totalCollateralUsd: (debtUsd * healthFactor) / 0.82,
  liquidationThreshold: 0.82,
  observedAt: 1_770_000_000,
});

test('classify maps health factors to tiers', () => {
  assert.equal(classify(2.0), 'IDLE');
  assert.equal(classify(1.25), 'WATCH');
  assert.equal(classify(1.1), 'ARMED');
  assert.equal(classify(1.04), 'CRITICAL');
  assert.equal(classify(0.98), 'CRITICAL');
});

test('classify treats tier bounds as inclusive of the more urgent tier', () => {
  assert.equal(classify(TIER_BOUNDS.critical), 'CRITICAL');
  assert.equal(classify(TIER_BOUNDS.armed), 'ARMED');
  assert.equal(classify(TIER_BOUNDS.watch), 'WATCH');
});

test('a position with no debt has infinite HF and is idle', () => {
  assert.equal(classify(Infinity), 'IDLE');
  assert.equal(liquidationProbability(Infinity, 0.04, 1), 0);
});

test('poll interval tightens as risk rises', () => {
  const intervals = (['IDLE', 'WATCH', 'ARMED', 'CRITICAL'] as const).map(
    pollIntervalBlocks,
  );
  for (let i = 1; i < intervals.length; i++) {
    assert.ok(
      intervals[i]! <= intervals[i - 1]!,
      `expected non-increasing intervals, got ${intervals.join(',')}`,
    );
  }
});

test('price headroom is the drop that takes HF to 1', () => {
  // HF 1.25 survives a 20% collateral drop: 1.25 * 0.8 = 1.0
  assert.ok(Math.abs(priceHeadroom(1.25) - 0.2) < 1e-9);
  assert.equal(priceHeadroom(1.0), 0);
  assert.equal(priceHeadroom(0.9), 0);
});

test('liquidation probability rises as health factor falls', () => {
  const hfs = [1.5, 1.25, 1.1, 1.04];
  const probs = hfs.map((hf) => liquidationProbability(hf, 0.04, 24));
  for (let i = 1; i < probs.length; i++) {
    assert.ok(
      probs[i]! > probs[i - 1]!,
      `expected increasing risk, got ${probs.map((p) => p.toFixed(5)).join(',')}`,
    );
  }
  assert.ok(probs.at(-1)! > 0.3, 'HF 1.04 should be alarming over a day');
});

test('far-tail probabilities floor at zero rather than going negative', () => {
  // The erf approximation loses resolution past about 5 sigma. Clamping keeps
  // that harmless: such probabilities are negligible either way.
  const p = liquidationProbability(2.0, 0.04, 1);
  assert.ok(p >= 0 && p < 1e-6, `expected a negligible non-negative value, got ${p}`);
});

test('liquidation probability is bounded to [0, 1]', () => {
  assert.equal(liquidationProbability(1.0, 0.04, 1), 1);
  assert.equal(liquidationProbability(0.5, 0.04, 1), 1);
  for (const hf of [1.001, 1.01, 1.2, 3, 100]) {
    const p = liquidationProbability(hf, 0.5, 24);
    assert.ok(p >= 0 && p <= 1, `p out of range for HF ${hf}: ${p}`);
  }
});

test('longer horizons and higher volatility both raise risk', () => {
  const short = liquidationProbability(1.15, 0.04, 1);
  const long = liquidationProbability(1.15, 0.04, 24);
  assert.ok(long > short);

  const calm = liquidationProbability(1.15, 0.02, 6);
  const wild = liquidationProbability(1.15, 0.08, 6);
  assert.ok(wild > calm);
});

test('probability model is pinned to a hand-checked value', () => {
  // HF 1.10 => 9.09% headroom; over 24h at 4% daily vol that is z = 2.273,
  // a one-sided tail of 0.01152, doubled by the reflection principle.
  const p = liquidationProbability(1.1, 0.04, 24);
  assert.ok(Math.abs(p - 0.02303) < 0.0015, `expected ~0.0230, got ${p}`);
  // An endpoint-only model would return 0.0115 here. This bound fails if the
  // reflection factor is ever dropped.
  assert.ok(p > 0.02, 'first-passage model must not collapse to the endpoint model');
});

test('armed-tier probabilities do not underflow to zero', () => {
  // Regression guard: an exposure horizon short enough to zero these out makes
  // the entire cost/benefit branch unreachable.
  for (const hf of [1.06, 1.1, 1.14]) {
    const p = liquidationProbability(hf, 0.04, horizonHours('ARMED'));
    assert.ok(p > 0, `HF ${hf} underflowed to zero probability`);
  }
});

test('expected loss is penalty on the liquidatable slice, not the whole debt', () => {
  const { lossIfLiquidated } = expectedLiquidationLoss(
    position(1.1),
    'ARMED',
    DEFAULT_LOSS_PARAMS,
  );
  // $10,000 debt * 50% close factor * 5% penalty = $250
  assert.ok(Math.abs(lossIfLiquidated - 250) < 1e-6);
});

test('expected loss scales with debt size', () => {
  const small = expectedLiquidationLoss(position(1.1, 1_000), 'ARMED');
  const large = expectedLiquidationLoss(position(1.1, 100_000), 'ARMED');
  assert.ok(large.expectedLoss > small.expectedLoss * 50);
});

test('gas cost converts units and gwei into dollars', () => {
  // 300k units at 20 gwei = 0.006 ETH; at $3000 = $18
  const usd = gasCostUsd(300_000, { baseFeeGwei: 20, ethPriceUsd: 3000 });
  assert.ok(Math.abs(usd - 18) < 1e-9);
});

test('gas cost respects the escalation multiplier', () => {
  const gas = { baseFeeGwei: 20, ethPriceUsd: 3000 };
  assert.ok(
    Math.abs(gasCostUsd(300_000, gas, 3) - gasCostUsd(300_000, gas) * 3) < 1e-9,
  );
});

test('critical tier escalates harder and faster than armed', () => {
  const critical = gasPolicyFor('CRITICAL', 250);
  const armed = gasPolicyFor('ARMED', 250);
  assert.ok(Math.max(...critical.multipliers) > Math.max(...armed.multipliers));
  assert.ok(critical.blocksBetweenBumps < armed.blocksBetweenBumps);
  assert.ok(critical.privateRouting && armed.privateRouting);
});

test('gas budget never exceeds the loss being avoided', () => {
  const policy = gasPolicyFor('CRITICAL', 40);
  assert.ok(
    policy.maxCostUsd <= 40,
    'spending more than the loss is worth is never rational',
  );
});

test('gas budget is hard-capped against a bad oracle read', () => {
  const policy = gasPolicyFor('CRITICAL', 10_000_000, 250);
  assert.equal(policy.maxCostUsd, 250);
});

test('critical-tier expected loss is a usable number, not a rounding artefact', () => {
  // The audit trail records expectedLoss alongside the rescue we paid for.
  // A horizon short enough to zero it out makes that record incoherent.
  const critical = expectedLiquidationLoss(position(1.04), 'CRITICAL');
  assert.ok(
    critical.probability > 0.2,
    `HF 1.04 over a day should be alarming, got ${critical.probability}`,
  );
  assert.ok(critical.expectedLoss > 1, 'expected loss must survive rounding to cents');
});

test('risk is monotonic across tiers at a fixed horizon', () => {
  const probs = [1.25, 1.12, 1.04].map(
    (hf) => liquidationProbability(hf, 0.04, 24),
  );
  for (let i = 1; i < probs.length; i++) {
    assert.ok(probs[i]! > probs[i - 1]!, `not monotonic: ${probs.join(',')}`);
  }
});
