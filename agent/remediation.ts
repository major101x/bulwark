/**
 * Remediation option construction and final decision assembly.
 *
 * Given a position in danger, there is more than one way out. Repaying debt and
 * topping up collateral both raise the health factor; which one is cheaper
 * depends on what the wallet is actually holding. If it holds neither, we have
 * to swap first, which costs a second transaction plus slippage.
 */

import {
  DEFAULT_LOSS_PARAMS,
  TARGET_HEALTH_FACTOR,
  classify,
  expectedLiquidationLoss,
  gasCostUsd,
  type LossParams,
} from './risk.ts';
import type {
  Decision,
  GasSnapshot,
  PositionSnapshot,
  RemediationOption,
  WalletBalances,
} from './types.ts';

/**
 * Gas estimates in units. Deliberately conservative — underestimating gas is
 * how a rescue reverts halfway through.
 *
 * TODO(day-3): replace with live estimates from KeeperHub's simulation step
 * rather than these constants.
 */
export const GAS_UNITS = {
  erc20Approve: 46_000,
  aaveRepay: 250_000,
  aaveSupply: 240_000,
  dexSwap: 180_000,
} as const;

/** Assumed slippage on a swap leg, as a fraction. */
export const SWAP_SLIPPAGE = 0.005;

/** Below this dollar value a remedy is not worth a transaction. */
export const MIN_REMEDIATION_USD = 1;

/**
 * How much debt must be repaid to reach the target health factor.
 *
 * HF = (C * LT) / D, so repaying x gives (C * LT) / (D - x) = target,
 * hence x = D - (C * LT) / target.
 */
export function repayAmountUsd(
  position: PositionSnapshot,
  target = TARGET_HEALTH_FACTOR,
): number {
  const { totalCollateralUsd, totalDebtUsd, liquidationThreshold } = position;
  const x = totalDebtUsd - (totalCollateralUsd * liquidationThreshold) / target;
  return Math.max(0, x);
}

/**
 * How much collateral must be added to reach the target health factor.
 *
 * ((C + y) * LT) / D = target, hence y = (target * D) / LT - C.
 */
export function addCollateralAmountUsd(
  position: PositionSnapshot,
  target = TARGET_HEALTH_FACTOR,
): number {
  const { totalCollateralUsd, totalDebtUsd, liquidationThreshold } = position;
  if (liquidationThreshold <= 0) return Infinity;
  const y = (target * totalDebtUsd) / liquidationThreshold - totalCollateralUsd;
  return Math.max(0, y);
}

/** Convert a dollar amount into base units of a token. */
export function usdToBaseUnits(usd: number, priceUsd: number, decimals: number): bigint {
  if (priceUsd <= 0) return 0n;
  const tokens = usd / priceUsd;
  // Round up: undershooting leaves the position below target.
  return BigInt(Math.ceil(tokens * 10 ** decimals));
}

/**
 * Build every remedy we could attempt, feasible or not. Infeasible options are
 * retained with a reason so the audit trail records what we considered and why
 * we ruled it out.
 */
export function buildOptions(
  position: PositionSnapshot,
  balances: WalletBalances,
  gas: GasSnapshot,
  target = TARGET_HEALTH_FACTOR,
): RemediationOption[] {
  const options: RemediationOption[] = [];

  // --- Option 1: repay debt -----------------------------------------------
  const repayUsd = repayAmountUsd(position, target);
  if (repayUsd >= MIN_REMEDIATION_USD) {
    const needed = usdToBaseUnits(
      repayUsd,
      balances.debtAssetPriceUsd,
      balances.debtAssetDecimals,
    );
    const have = balances.debtAsset;
    options.push({
      kind: 'REPAY',
      amount: needed,
      amountUsd: repayUsd,
      costUsd: gasCostUsd(GAS_UNITS.erc20Approve + GAS_UNITS.aaveRepay, gas),
      projectedHealthFactor: target,
      feasible: have >= needed,
      blockedReason:
        have >= needed
          ? undefined
          : `holds ${have} base units of debt asset, needs ${needed}`,
    });
  }

  // --- Option 2: add collateral -------------------------------------------
  const collateralUsd = addCollateralAmountUsd(position, target);
  if (collateralUsd >= MIN_REMEDIATION_USD && Number.isFinite(collateralUsd)) {
    const needed = usdToBaseUnits(
      collateralUsd,
      balances.collateralAssetPriceUsd,
      balances.collateralAssetDecimals,
    );
    const have = balances.collateralAsset;
    options.push({
      kind: 'ADD_COLLATERAL',
      amount: needed,
      amountUsd: collateralUsd,
      costUsd: gasCostUsd(GAS_UNITS.erc20Approve + GAS_UNITS.aaveSupply, gas),
      projectedHealthFactor: target,
      feasible: have >= needed,
      blockedReason:
        have >= needed
          ? undefined
          : `holds ${have} base units of collateral asset, needs ${needed}`,
    });
  }

  // --- Option 3: swap, then repay -----------------------------------------
  // Last resort. Two transactions plus slippage, and the swap itself is
  // front-runnable, which is why private routing is not optional here.
  if (repayUsd >= MIN_REMEDIATION_USD) {
    const swapGas = gasCostUsd(
      GAS_UNITS.dexSwap + GAS_UNITS.erc20Approve + GAS_UNITS.aaveRepay,
      gas,
    );
    options.push({
      kind: 'SWAP_THEN_REPAY',
      amount: usdToBaseUnits(
        repayUsd,
        balances.debtAssetPriceUsd,
        balances.debtAssetDecimals,
      ),
      amountUsd: repayUsd,
      costUsd: swapGas + repayUsd * SWAP_SLIPPAGE,
      projectedHealthFactor: target,
      // Feasibility depends on holding *something* swappable. Refined once the
      // CoW Swap / Curve plugin wiring lands.
      feasible: balances.collateralAsset > 0n || balances.debtAsset > 0n,
      blockedReason:
        balances.collateralAsset > 0n || balances.debtAsset > 0n
          ? undefined
          : 'wallet holds nothing to swap',
    });
  }

  return options;
}

/** Cheapest option we can actually execute, or undefined if we are stuck. */
export function cheapestFeasible(
  options: RemediationOption[],
): RemediationOption | undefined {
  return options
    .filter((o) => o.feasible)
    .reduce<RemediationOption | undefined>(
      (best, o) => (best === undefined || o.costUsd < best.costUsd ? o : best),
      undefined,
    );
}

/** Multiple of rescue cost the expected loss must clear before we act. */
export const SAFETY_MARGIN = 3;

/**
 * The full decision. This is the function whose output gets read aloud in the
 * demo video, so the rationale string is written to be legible to a human.
 */
export function decide(
  position: PositionSnapshot,
  balances: WalletBalances,
  gas: GasSnapshot,
  params: LossParams = DEFAULT_LOSS_PARAMS,
): Decision {
  const tier = classify(position.healthFactor);
  const { lossIfLiquidated, probability, expectedLoss } = expectedLiquidationLoss(
    position,
    tier,
    params,
  );
  const options = buildOptions(position, balances, gas);
  const best = cheapestFeasible(options);

  const base = {
    tier,
    expectedLossUsd: expectedLoss,
    liquidationProbability: probability,
    rescueCostUsd: best?.costUsd ?? 0,
    benefitRatio: best && best.costUsd > 0 ? expectedLoss / best.costUsd : 0,
  };

  if (tier === 'IDLE' || tier === 'WATCH') {
    return {
      ...base,
      action: 'HOLD',
      rationale: `HF ${position.healthFactor.toFixed(3)} → ${tier}. No action needed.`,
    };
  }

  if (!best) {
    const reasons = options.map((o) => `${o.kind}: ${o.blockedReason}`).join('; ');
    return {
      ...base,
      action: 'HOLD',
      rationale:
        `HF ${position.healthFactor.toFixed(3)} → ${tier}, but no feasible remedy. ` +
        `${reasons || 'no options constructed'}. Alerting operator.`,
    };
  }

  // CRITICAL overrides the economics. At this health factor a passing gas spike
  // is not a reason to let a position liquidate.
  if (tier === 'CRITICAL') {
    return {
      ...base,
      action: 'RESCUE',
      remediation: best,
      rationale:
        `HF ${position.healthFactor.toFixed(3)} → CRITICAL. ` +
        `Loss if liquidated $${lossIfLiquidated.toFixed(2)}. ` +
        `Rescue cost $${best.costUsd.toFixed(2)}. ` +
        `${best.kind} $${best.amountUsd.toFixed(2)}. Private routing enabled.`,
    };
  }

  // ARMED: act only when the arithmetic justifies it.
  const worthIt = expectedLoss > best.costUsd * SAFETY_MARGIN;
  return {
    ...base,
    action: worthIt ? 'RESCUE' : 'HOLD',
    remediation: worthIt ? best : undefined,
    rationale:
      `HF ${position.healthFactor.toFixed(3)} → ARMED. ` +
      `P(liquidation) ${(probability * 100).toFixed(1)}% over next hour, ` +
      `loss if it happens $${lossIfLiquidated.toFixed(2)}, ` +
      `expected loss $${expectedLoss.toFixed(2)}. ` +
      `Cheapest rescue ${best.kind} at $${best.costUsd.toFixed(2)}. ` +
      `Ratio ${base.benefitRatio.toFixed(1)}× vs ${SAFETY_MARGIN}× margin — ` +
      `${worthIt ? 'rescuing' : 'holding, gas not justified yet'}.`,
  };
}
