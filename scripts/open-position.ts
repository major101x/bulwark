/**
 * Open the Aave V3 position the keeper will defend.
 *
 * Supplies LINK as collateral and borrows USDC against it, leaving the position
 * healthy. Driving it into danger is a separate, deliberate step (`danger.ts`)
 * so the demo can trigger it on camera.
 *
 *   npm run pos:open
 *
 * Sizing is dictated by what the Sepolia market can actually do:
 *   - USDC supply is capped at 2,000 and the cap is reached, so USDC cannot be
 *     supplied as collateral. LINK has no caps, so LINK is the collateral.
 *   - Only ~867 USDC of borrowable liquidity exists in the reserve, which caps
 *     how large the debt can get, and therefore how much collateral is worth
 *     posting.
 *
 * With 28 LINK at $30 and a 75% liquidation threshold:
 *   350 USDC debt -> HF 1.80    (healthy start)
 *   606 USDC debt -> HF 1.04    (critical, reachable within liquidity)
 */

import { parseUnits } from 'ethers';

import {
  AAVE,
  RATE_MODE,
  TOKENS,
  ensureAllowance,
  erc20,
  pool,
  positionSigner,
  printAccount,
  readAccount,
} from './lib.ts';

const SUPPLY_LINK = parseUnits('28', TOKENS.LINK.decimals);
const BORROW_USDC = parseUnits('350', TOKENS.USDC.decimals);

const signer = positionSigner();
console.log(`Position wallet: ${signer.address}\n`);

const linkBalance = await erc20(TOKENS.LINK.address, signer).balanceOf(
  signer.address,
);
if (linkBalance < SUPPLY_LINK) {
  throw new Error(
    `Need ${SUPPLY_LINK} LINK base units, wallet holds ${linkBalance}. ` +
      `Mint more from the Aave faucet first.`,
  );
}

const before = await readAccount(signer.address);
printAccount('Before', before);

console.log('\n1/3 approve LINK to the Aave pool');
await ensureAllowance(TOKENS.LINK.address, SUPPLY_LINK, signer);

console.log('\n2/3 supply LINK as collateral');
{
  const tx = await pool(signer).supply(
    TOKENS.LINK.address,
    SUPPLY_LINK,
    signer.address, // onBehalfOf: the position stays with this wallet
    0,
  );
  const receipt = await tx.wait();
  console.log(`  supplied in ${receipt?.hash}`);
}

// Aave enables collateral automatically on a first supply, but not if the user
// previously disabled this reserve. Setting it explicitly is idempotent and
// cheap insurance against a silently uncollateralised position.
const mid = await readAccount(signer.address);
if (mid.totalCollateralUsd === 0) {
  console.log('  collateral not counted, enabling reserve as collateral');
  const tx = await pool(signer).setUserUseReserveAsCollateral(TOKENS.LINK.address, true);
  await tx.wait();
}

console.log('\n3/3 borrow USDC against it');
{
  const tx = await pool(signer).borrow(
    TOKENS.USDC.address,
    BORROW_USDC,
    RATE_MODE.variable,
    0,
    signer.address,
  );
  const receipt = await tx.wait();
  console.log(`  borrowed in ${receipt?.hash}`);
}

const after = await readAccount(signer.address);
printAccount('\nAfter', after);
console.log(`\nAave pool: ${AAVE.pool}`);
console.log('Next: npm run pos:fund-keeper');
