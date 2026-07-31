/**
 * Run the decision engine against live chain state, without executing anything.
 *
 *   npm run pos:evaluate
 *
 * This is the read path of the agent, exercised end to end: real health factor,
 * real keeper balances, real gas, real oracle prices. It prints the rationale
 * the agent would log and the option table it considered.
 */

import { Contract, formatUnits } from 'ethers';

import { decide } from '../agent/remediation.ts';
import { buildOptions } from '../agent/remediation.ts';
import { classify, expectedLiquidationLoss, horizonHours } from '../agent/risk.ts';
import type { GasSnapshot, PositionSnapshot, WalletBalances } from '../agent/types.ts';
import { AAVE, TOKENS, erc20, printAccount, provider, readAccount } from './lib.ts';

const POSITION =
  process.env.WATCHED_WALLET ?? '0x5Fd5a59693CFC88CC65692751bE547a3fc66992b';
const KEEPER =
  process.env.KEEPERHUB_WALLET ?? '0x2Ac0C346502571c8Ef320e2768702589800b14F8';

const ORACLE_ABI = ['function getAssetPrice(address asset) view returns (uint256)'];

const p = provider();
const oracle = new Contract(AAVE.oracle, ORACLE_ABI, p);

/** Aave oracle quotes in USD with 8 decimals. */
async function priceUsd(asset: string): Promise<number> {
  const raw: bigint = await oracle.getAssetPrice!(asset);
  return Number(formatUnits(raw, 8));
}

const account = await readAccount(POSITION);
printAccount(`Position ${POSITION}`, account);

const position: PositionSnapshot = {
  wallet: POSITION,
  healthFactor: account.healthFactor,
  totalDebtUsd: account.totalDebtUsd,
  totalCollateralUsd: account.totalCollateralUsd,
  liquidationThreshold: account.liquidationThreshold,
  observedAt: Math.floor(Date.now() / 1000),
};

const balances: WalletBalances = {
  debtAsset: await erc20(TOKENS.USDC.address, p).balanceOf(KEEPER),
  collateralAsset: await erc20(TOKENS.LINK.address, p).balanceOf(KEEPER),
  debtAssetDecimals: TOKENS.USDC.decimals,
  collateralAssetDecimals: TOKENS.LINK.decimals,
  debtAssetPriceUsd: await priceUsd(TOKENS.USDC.address),
  collateralAssetPriceUsd: await priceUsd(TOKENS.LINK.address),
};

const feeData = await p.getFeeData();
const baseFeeGwei = Number(formatUnits(feeData.gasPrice ?? 1_000_000_000n, 'gwei'));
const gas: GasSnapshot = {
  baseFeeGwei,
  // Gas is denominated in the chain's native token, so price ETH, not LINK.
  ethPriceUsd: await priceUsd(TOKENS.WETH.address),
};

console.log(
  `\nKeeper ${KEEPER}` +
    `\n  USDC ${formatUnits(balances.debtAsset, 6)}` +
    `  LINK ${formatUnits(balances.collateralAsset, 18)}` +
    `\nGas   ${baseFeeGwei.toFixed(3)} gwei, ETH $${gas.ethPriceUsd.toFixed(2)}`,
);

const tier = classify(position.healthFactor);
const loss = expectedLiquidationLoss(position, tier);
console.log(
  `\nRisk` +
    `\n  tier              ${tier}` +
    `\n  horizon           ${horizonHours(tier)}h` +
    `\n  P(liquidation)    ${(loss.probability * 100).toFixed(3)}%` +
    `\n  loss if it happens $${loss.lossIfLiquidated.toFixed(2)}` +
    `\n  expected loss     $${loss.expectedLoss.toFixed(4)}`,
);

console.log('\nOptions considered');
for (const o of buildOptions(position, balances, gas)) {
  const mark = o.feasible ? 'ok  ' : 'x   ';
  console.log(
    `  ${mark}${o.kind.padEnd(17)} $${o.amountUsd.toFixed(2).padStart(9)} ` +
      `cost $${o.costUsd.toFixed(4)}${o.blockedReason ? `  (${o.blockedReason})` : ''}`,
  );
}

const decision = decide(position, balances, gas);
console.log(`\nDecision: ${decision.action}`);
console.log(`  ${decision.rationale}`);
