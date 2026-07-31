/**
 * Drive the position into danger, on demand. This is the demo trigger.
 *
 *   npm run pos:danger            # target HF 1.04 (CRITICAL)
 *   npm run pos:danger -- 1.12    # target a specific health factor
 *
 * We cannot manipulate oracle prices on a shared testnet, so we change the
 * position instead. The mechanism matters, and the obvious choice is wrong:
 *
 *   Borrowing more is capped by the collateral's LTV (70% for LINK), not by its
 *   liquidation threshold (75%). The best you can reach is HF = LT / LTV =
 *   1.0714, and past that Aave reverts with error 36,
 *   COLLATERAL_CANNOT_COVER_NEW_BORROW. You cannot borrow yourself into
 *   liquidation, which is the protocol working as intended.
 *
 *   Withdrawing collateral is validated against health factor >= 1 instead of
 *   against LTV, so it reaches any target above 1.0.
 *
 * Withdrawing is also the better analogue: removing collateral is economically
 * what a price drop does to the position.
 *
 *   HF = (collateral * LT) / debt
 *   collateral_target = (HF_target * debt) / LT
 *   withdraw = collateral_current - collateral_target
 */

import { Contract, formatUnits, parseUnits } from 'ethers';

import {
  AAVE,
  TOKENS,
  explainAaveError,
  pool,
  positionSigner,
  printAccount,
  provider,
  readAccount,
} from './lib.ts';

const TARGET_HF = Number(process.argv[2] ?? '1.04');
if (!Number.isFinite(TARGET_HF) || TARGET_HF <= 1) {
  throw new Error(
    `Target health factor must be a number above 1, got "${process.argv[2]}"`,
  );
}

const signer = positionSigner();
const before = await readAccount(signer.address);
printAccount(`Before (target HF ${TARGET_HF})`, before);

if (before.totalDebtUsd === 0) {
  throw new Error('No debt yet. Run `npm run pos:open` first.');
}
if (before.healthFactor <= TARGET_HF) {
  console.log(`\nAlready at or below target (HF ${before.healthFactor.toFixed(4)}).`);
  process.exit(0);
}

const targetCollateralUsd =
  (TARGET_HF * before.totalDebtUsd) / before.liquidationThreshold;
const withdrawUsd = before.totalCollateralUsd - targetCollateralUsd;

const oracle = new Contract(
  AAVE.oracle,
  ['function getAssetPrice(address asset) view returns (uint256)'],
  provider(),
);
const linkPriceUsd = Number(
  formatUnits(await oracle.getAssetPrice!(TOKENS.LINK.address), 8),
);

// Round down so we always land slightly above the target rather than below it.
const withdrawLink = Math.floor((withdrawUsd / linkPriceUsd) * 1e6) / 1e6;
const withdrawUnits = parseUnits(withdrawLink.toString(), TOKENS.LINK.decimals);

console.log(
  `\nWithdrawing ${withdrawLink} LINK ($${withdrawUsd.toFixed(2)} at ` +
    `$${linkPriceUsd.toFixed(2)}) to move collateral ` +
    `$${before.totalCollateralUsd.toFixed(2)} -> $${targetCollateralUsd.toFixed(2)}`,
);

try {
  const tx = await pool(signer).withdraw(
    TOKENS.LINK.address,
    withdrawUnits,
    signer.address,
  );
  const receipt = await tx.wait();
  console.log(`  withdrawn in ${receipt?.hash}`);
} catch (err) {
  console.error(`\n  failed: ${explainAaveError(err)}`);
  process.exit(1);
}

const after = await readAccount(signer.address);
printAccount('\nAfter', after);
console.log('\nRun `npm run pos:evaluate` to see what the agent decides.');
