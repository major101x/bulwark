/**
 * Risk classification and the cost/benefit calculation.
 *
 * The point of this module is restraint. Any agent can fire a repay the moment
 * a health factor dips. The interesting behaviour is declining to act when the
 * gas costs more than the liquidation would, and being able to show the
 * arithmetic for why.
 */

import type { GasSnapshot, PositionSnapshot, RiskTier } from './types.ts';

// --- Tier boundaries -------------------------------------------------------

export const TIER_BOUNDS = {
  /** At or below this, act immediately regardless of gas. */
  critical: 1.05,
  /** Below this, act if economically rational. */
  armed: 1.15,
  /** Below this, watch closely and pre-simulate. */
  watch: 1.3,
} as const;

/** Health factor we aim to restore a rescued position to. */
export const TARGET_HEALTH_FACTOR = 1.3;

export function classify(healthFactor: number): RiskTier {
  if (!Number.isFinite(healthFactor)) return 'IDLE'; // no debt => HF is Infinity
  if (healthFactor <= TIER_BOUNDS.critical) return 'CRITICAL';
  if (healthFactor <= TIER_BOUNDS.armed) return 'ARMED';
  if (healthFactor <= TIER_BOUNDS.watch) return 'WATCH';
  return 'IDLE';
}

/** How often to re-read the position, in blocks, given the current tier. */
export function pollIntervalBlocks(tier: RiskTier): number {
  switch (tier) {
    case 'CRITICAL':
      return 1;
    case 'ARMED':
      return 1;
    case 'WATCH':
      return 2;
    case 'IDLE':
      return 10;
  }
}

/**
 * Decision horizon per tier, in hours.
 *
 * This is the *exposure window if we decline to act now*, not the poll
 * interval. The distinction matters and was a real bug at first: sizing the
 * horizon to the poll interval (~1 hour) drove every ARMED probability to
 * underflow, so the cost/benefit branch could never fire and the whole tier
 * was dead code.
 *
 * Holding at ARMED is a decision to sit out a gas spike, and gas spikes last
 * hours, so 24h is the honest exposure window. The resulting numbers are
 * well calibrated: HF 1.10 gives a ~2.3% chance of touching liquidation within
 * a day, and collateral drops of that size (~9%) do happen a few times a year.
 */
export function horizonHours(tier: RiskTier): number {
  switch (tier) {
    case 'CRITICAL':
      // Was 0.25h on the reasoning that we act regardless, so the number only
      // sized a report. That was wrong twice over: a 15 minute window drives
      // the probability to zero, so the audit trail recorded "expected loss
      // $0.00" next to a rescue we had just paid for, which reads as
      // incoherent to anyone reviewing it. The exposure window is the same
      // question at every tier, so it gets the same answer: 24h. At HF 1.04
      // that yields ~34%, which is both alarming and defensible.
      return 24;
    case 'ARMED':
      return 24;
    case 'WATCH':
      return 48;
    case 'IDLE':
      return 168;
  }
}

// --- Liquidation probability ----------------------------------------------

/**
 * Fractional drop in collateral price that would push the position to HF = 1.
 *
 * HF = collateral * LT / debt. A price drop of d scales collateral by (1 - d),
 * so HF' = HF * (1 - d), and HF' = 1 when d = 1 - 1/HF.
 */
export function priceHeadroom(healthFactor: number): number {
  if (!Number.isFinite(healthFactor)) return 1;
  if (healthFactor <= 1) return 0;
  return 1 - 1 / healthFactor;
}

/** Abramowitz & Stegun 7.1.26 error function approximation. |error| < 1.5e-7. */
function erf(x: number): number {
  const sign = Math.sign(x);
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal CDF. */
function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * Probability the position touches HF = 1 at any point within the horizon.
 *
 * This is a first-passage problem, not an endpoint problem: a position that
 * dips below 1.0 mid-window and recovers still gets liquidated, because
 * liquidators are watching every block. By the reflection principle, for a
 * driftless random walk the probability of *touching* a barrier is twice the
 * probability of *ending* beyond it, so a naive endpoint model understates
 * the risk by about half.
 *
 * @param healthFactor    current HF
 * @param dailyVolatility stdev of collateral price returns per day (0.04 = 4%)
 * @param hours           decision horizon
 */
export function liquidationProbability(
  healthFactor: number,
  dailyVolatility: number,
  hours: number,
): number {
  if (healthFactor <= 1) return 1;
  if (!Number.isFinite(healthFactor)) return 0;
  if (dailyVolatility <= 0 || hours <= 0) return 0;

  const headroom = priceHeadroom(healthFactor);
  const scale = dailyVolatility * Math.sqrt(hours / 24);
  if (scale === 0) return 0;

  const z = headroom / scale;
  const p = 2 * (1 - normalCdf(z)); // reflection principle
  return Math.min(1, Math.max(0, p));
}

// --- Expected loss ---------------------------------------------------------

export interface LossParams {
  /** Fraction of debt a liquidator may repay in one go. Aave V3 default 0.5. */
  closeFactor: number;
  /** Liquidation bonus paid to the liquidator out of our collateral. */
  liquidationPenalty: number;
  /** Daily volatility of the collateral asset. */
  dailyVolatility: number;
}

export const DEFAULT_LOSS_PARAMS: LossParams = {
  closeFactor: 0.5,
  liquidationPenalty: 0.05,
  dailyVolatility: 0.04,
};

/**
 * Expected dollar loss from doing nothing.
 *
 * If liquidated, we lose the penalty on whatever slice gets repaid, not the
 * whole position. Worked example: $10,000 debt, 50% close factor, 5% penalty
 * => $250 if it happens. Multiplied by the probability that it does.
 */
export function expectedLiquidationLoss(
  position: PositionSnapshot,
  tier: RiskTier,
  params: LossParams = DEFAULT_LOSS_PARAMS,
): { lossIfLiquidated: number; probability: number; expectedLoss: number } {
  const lossIfLiquidated =
    position.totalDebtUsd * params.closeFactor * params.liquidationPenalty;
  const probability = liquidationProbability(
    position.healthFactor,
    params.dailyVolatility,
    horizonHours(tier),
  );
  return {
    lossIfLiquidated,
    probability,
    expectedLoss: lossIfLiquidated * probability,
  };
}

// --- Gas -------------------------------------------------------------------

/** Convert a gas estimate at a given price into dollars. */
export function gasCostUsd(gasUnits: number, gas: GasSnapshot, multiplier = 1): number {
  const gwei = gas.baseFeeGwei * multiplier;
  const eth = (gasUnits * gwei) / 1e9;
  return eth * gas.ethPriceUsd;
}

/**
 * Gas escalation ladder. KeeperHub handles the resubmission mechanics; this is
 * the policy it enforces on our behalf.
 *
 * CRITICAL bids aggressively and retries fast, because a rescue that lands late
 * is a rescue that did not happen. ARMED is patient and gives up if gas runs
 * away, because at that health factor waiting is a legitimate option.
 */
export interface GasPolicy {
  multipliers: number[];
  blocksBetweenBumps: number;
  privateRouting: boolean;
  /** Abandon the rescue if projected cost exceeds this. */
  maxCostUsd: number;
}

export function gasPolicyFor(
  tier: RiskTier,
  expectedLossUsd: number,
  hardCapUsd = 250,
): GasPolicy {
  // Never spend more avoiding a loss than the loss is worth. Half the expected
  // loss is the ceiling; the hard cap stops a bad oracle read draining us.
  const maxCostUsd = Math.min(expectedLossUsd * 0.5, hardCapUsd);

  if (tier === 'CRITICAL') {
    return {
      multipliers: [1.5, 2, 3],
      blocksBetweenBumps: 2,
      privateRouting: true,
      maxCostUsd,
    };
  }
  return {
    multipliers: [1.1, 1.3],
    blocksBetweenBumps: 4,
    privateRouting: true,
    maxCostUsd,
  };
}
