/**
 * Shared domain types.
 *
 * All USD amounts are plain JS numbers (dollars, not wei). Token amounts that
 * cross a chain boundary are bigint in base units. Keep that split strict —
 * mixing float dollars with base-unit integers is the classic way to send a
 * transaction that is off by 10^18.
 */

/** Where a position lives and what it currently looks like. */
export interface PositionSnapshot {
  /** Wallet whose position we defend. */
  wallet: string;
  /** Aave-style health factor. Below 1.0 the position is liquidatable. */
  healthFactor: number;
  /** Total debt, USD. */
  totalDebtUsd: number;
  /** Total collateral, USD. */
  totalCollateralUsd: number;
  /**
   * Weighted average liquidation threshold, as a fraction (0.82 = 82%).
   * HF = (totalCollateralUsd * liquidationThreshold) / totalDebtUsd
   */
  liquidationThreshold: number;
  /** Unix seconds when this snapshot was read. */
  observedAt: number;
}

/** Network conditions at decision time. */
export interface GasSnapshot {
  baseFeeGwei: number;
  /** Native token price in USD, for converting gas into dollars. */
  ethPriceUsd: number;
}

/** What the defended wallet is holding, so we know which remedies are open. */
export interface WalletBalances {
  /** Base units of the borrowed asset available to repay with. */
  debtAsset: bigint;
  /** Base units of the collateral asset available to top up with. */
  collateralAsset: bigint;
  debtAssetDecimals: number;
  collateralAssetDecimals: number;
  debtAssetPriceUsd: number;
  collateralAssetPriceUsd: number;
}

export type RiskTier = 'IDLE' | 'WATCH' | 'ARMED' | 'CRITICAL';

export type RemediationKind = 'REPAY' | 'ADD_COLLATERAL' | 'SWAP_THEN_REPAY';

export interface RemediationOption {
  kind: RemediationKind;
  /** Amount to move, in base units of the relevant asset. */
  amount: bigint;
  /** Human-readable amount for logs and the demo video. */
  amountUsd: number;
  /** All-in cost of performing this remedy, USD (gas + slippage). */
  costUsd: number;
  /** Health factor we expect once this lands. */
  projectedHealthFactor: number;
  /** Whether the wallet can actually afford this today. */
  feasible: boolean;
  /** Why it is not feasible, when it is not. */
  blockedReason?: string;
}

export type DecisionAction = 'HOLD' | 'RESCUE';

export interface Decision {
  action: DecisionAction;
  tier: RiskTier;
  /** Chosen remedy. Present only when action is RESCUE. */
  remediation?: RemediationOption;
  /** Expected dollar loss if we do nothing. */
  expectedLossUsd: number;
  /** Probability the position is liquidated within the decision horizon. */
  liquidationProbability: number;
  /** Cost of the cheapest feasible remedy, USD. */
  rescueCostUsd: number;
  /** expectedLossUsd / rescueCostUsd. Compared against the safety margin. */
  benefitRatio: number;
  /** One-line explanation, printed verbatim in the demo. */
  rationale: string;
}
