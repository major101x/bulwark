import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addCollateralAmountUsd,
  buildOptions,
  cheapestFeasible,
  decide,
  repayAmountUsd,
  usdToBaseUnits,
} from './remediation.ts';
import { TARGET_HEALTH_FACTOR } from './risk.ts';
import type { GasSnapshot, PositionSnapshot, WalletBalances } from './types.ts';

const LT = 0.82;

/** Build a position with an exact health factor at the given debt level. */
const position = (healthFactor: number, debtUsd = 10_000): PositionSnapshot => ({
  wallet: '0x0000000000000000000000000000000000000001',
  healthFactor,
  totalDebtUsd: debtUsd,
  totalCollateralUsd: (debtUsd * healthFactor) / LT,
  liquidationThreshold: LT,
  observedAt: 1_770_000_000,
});

/** Wallet holding plenty of both assets. USDC-like debt, ETH-like collateral. */
const richWallet = (): WalletBalances => ({
  debtAsset: 1_000_000_000_000n, // 1,000,000 USDC at 6 dp
  collateralAsset: 1_000_000_000_000_000_000_000n, // 1000 ETH at 18 dp
  debtAssetDecimals: 6,
  collateralAssetDecimals: 18,
  debtAssetPriceUsd: 1,
  collateralAssetPriceUsd: 3000,
});

const emptyWallet = (): WalletBalances => ({
  ...richWallet(),
  debtAsset: 0n,
  collateralAsset: 0n,
});

const cheapGas: GasSnapshot = { baseFeeGwei: 5, ethPriceUsd: 3000 };
const spikyGas: GasSnapshot = { baseFeeGwei: 400, ethPriceUsd: 3000 };

// --- amount math -----------------------------------------------------------

test('repaying the computed amount lands exactly on the target health factor', () => {
  const p = position(1.1);
  const repay = repayAmountUsd(p);
  const newHf = (p.totalCollateralUsd * LT) / (p.totalDebtUsd - repay);
  assert.ok(
    Math.abs(newHf - TARGET_HEALTH_FACTOR) < 1e-9,
    `expected HF ${TARGET_HEALTH_FACTOR}, got ${newHf}`,
  );
});

test('adding the computed collateral lands exactly on the target health factor', () => {
  const p = position(1.1);
  const add = addCollateralAmountUsd(p);
  const newHf = ((p.totalCollateralUsd + add) * LT) / p.totalDebtUsd;
  assert.ok(
    Math.abs(newHf - TARGET_HEALTH_FACTOR) < 1e-9,
    `expected HF ${TARGET_HEALTH_FACTOR}, got ${newHf}`,
  );
});

test('a position already above target needs no remediation', () => {
  assert.equal(repayAmountUsd(position(1.5)), 0);
  assert.equal(addCollateralAmountUsd(position(1.5)), 0);
});

test('a more distressed position needs a larger repayment', () => {
  assert.ok(repayAmountUsd(position(1.04)) > repayAmountUsd(position(1.2)));
});

test('usd converts to base units without float drift, rounding up', () => {
  assert.equal(usdToBaseUnits(100, 1, 6), 100_000_000n); // 100 USDC
  assert.equal(usdToBaseUnits(3000, 3000, 18), 10n ** 18n); // 1 ETH
  // Rounding up matters: undershooting leaves the position below target.
  assert.ok(usdToBaseUnits(1.0000001, 1, 6) >= 1_000_000n);
});

test('zero-priced asset cannot be sized and yields no amount', () => {
  assert.equal(usdToBaseUnits(100, 0, 18), 0n);
});

// --- option construction ---------------------------------------------------

test('a rich wallet gets both direct remedies, and they are feasible', () => {
  const opts = buildOptions(position(1.1), richWallet(), cheapGas);
  const kinds = opts.filter((o) => o.feasible).map((o) => o.kind);
  assert.ok(kinds.includes('REPAY'));
  assert.ok(kinds.includes('ADD_COLLATERAL'));
});

test('an empty wallet has no feasible remedy and records why', () => {
  const opts = buildOptions(position(1.1), emptyWallet(), cheapGas);
  assert.equal(cheapestFeasible(opts), undefined);
  for (const o of opts) {
    assert.ok(o.blockedReason, `${o.kind} should explain why it is blocked`);
  }
});

test('swapping is priced above repaying, because of the extra leg and slippage', () => {
  const opts = buildOptions(position(1.1), richWallet(), cheapGas);
  const repay = opts.find((o) => o.kind === 'REPAY')!;
  const swap = opts.find((o) => o.kind === 'SWAP_THEN_REPAY')!;
  assert.ok(swap.costUsd > repay.costUsd);
});

test('the cheapest feasible option is selected', () => {
  const opts = buildOptions(position(1.1), richWallet(), cheapGas);
  const best = cheapestFeasible(opts)!;
  for (const o of opts.filter((x) => x.feasible)) {
    assert.ok(best.costUsd <= o.costUsd);
  }
});

test('an infeasible cheap option never beats a feasible dearer one', () => {
  // Holds ETH but no USDC, so REPAY is out even though it is cheapest.
  const wallet: WalletBalances = { ...richWallet(), debtAsset: 0n };
  const best = cheapestFeasible(buildOptions(position(1.1), wallet, cheapGas))!;
  assert.notEqual(best.kind, 'REPAY');
  assert.ok(best.feasible);
});

// --- decisions -------------------------------------------------------------

test('a healthy position is left alone', () => {
  const d = decide(position(2.0), richWallet(), cheapGas);
  assert.equal(d.action, 'HOLD');
  assert.equal(d.tier, 'IDLE');
});

test('a watched position is not acted on yet', () => {
  const d = decide(position(1.25), richWallet(), cheapGas);
  assert.equal(d.action, 'HOLD');
  assert.equal(d.tier, 'WATCH');
});

test('a critical position is rescued even when gas has spiked', () => {
  const d = decide(position(1.03), richWallet(), spikyGas);
  assert.equal(d.tier, 'CRITICAL');
  assert.equal(d.action, 'RESCUE');
  assert.ok(d.remediation);
  assert.match(d.rationale, /CRITICAL/);
});

test('an armed position holds when gas swamps the expected loss', () => {
  // Small debt, huge gas: rescuing costs more than the liquidation would.
  const d = decide(position(1.14, 200), richWallet(), spikyGas);
  assert.equal(d.tier, 'ARMED');
  assert.equal(d.action, 'HOLD');
  assert.match(d.rationale, /holding, gas not justified/);
});

test('an armed position rescues when the loss dwarfs the gas', () => {
  const d = decide(position(1.08, 500_000), richWallet(), cheapGas);
  assert.equal(d.tier, 'ARMED');
  assert.equal(d.action, 'RESCUE');
  assert.ok(d.benefitRatio > 3);
});

test('the armed threshold is the safety margin, not a coin flip', () => {
  // Sweep debt upward; the decision must flip exactly once, from HOLD to RESCUE.
  const flips: string[] = [];
  let previous = '';
  for (let debt = 100; debt <= 2_000_000; debt *= 1.5) {
    const action = decide(position(1.12, debt), richWallet(), cheapGas).action;
    if (action !== previous) {
      flips.push(action);
      previous = action;
    }
  }
  assert.deepEqual(flips, ['HOLD', 'RESCUE']);
});

test('a rescue is declined gracefully when the wallet cannot fund it', () => {
  const d = decide(position(1.02), emptyWallet(), cheapGas);
  assert.equal(d.tier, 'CRITICAL');
  assert.equal(d.action, 'HOLD');
  assert.match(d.rationale, /no feasible remedy/);
  assert.match(d.rationale, /Alerting operator/);
});

test('rationale carries the numbers a human needs to audit the call', () => {
  const d = decide(position(1.08, 100_000), richWallet(), cheapGas);
  assert.match(d.rationale, /HF 1\.080/);
  assert.match(d.rationale, /\$/);
  assert.ok(d.rationale.length < 400, 'rationale must stay readable on screen');
});
