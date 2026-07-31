/**
 * Stock the keeper wallet with rescue ammunition.
 *
 *   npm run pos:fund-keeper
 *
 * The keeper is a separate address from the position. It rescues using Aave's
 * `onBehalfOf` parameter, which means it spends its *own* tokens on the
 * position owner's behalf. An unfunded keeper is inert: every remedy is marked
 * infeasible and the agent logs "no feasible remedy" rather than executing.
 *
 * It gets both assets on purpose, so the agent has a genuine choice between
 * repaying debt and topping up collateral rather than one forced option.
 *
 * This transfer-in step exists because the KeeperHub wallet lives in a Turnkey
 * enclave and cannot be connected to a faucet UI. See docs/FRICTION-LOG.md.
 */

import { formatUnits, parseUnits } from 'ethers';

import { TOKENS, erc20, positionSigner } from './lib.ts';

const KEEPER =
  process.env.KEEPERHUB_WALLET ?? '0x2Ac0C346502571c8Ef320e2768702589800b14F8';

/**
 * Sized well above what any single rescue needs. Repaying from HF 1.04 back to
 * 1.30 costs about 121 USDC, and topping up collateral instead costs about 7
 * LINK, so this covers many rescues plus the whole chaos harness.
 */
const TRANSFERS = [
  { token: TOKENS.USDC, amount: '1000', why: 'repay ammunition' },
  { token: TOKENS.LINK, amount: '100', why: 'add-collateral ammunition' },
] as const;

const signer = positionSigner();
console.log(`From position wallet: ${signer.address}`);
console.log(`To keeper wallet:     ${KEEPER}\n`);

for (const { token, amount, why } of TRANSFERS) {
  const units = parseUnits(amount, token.decimals);
  const c = erc20(token.address, signer);

  const held = await c.balanceOf(signer.address);
  if (held < units) {
    throw new Error(
      `Need ${amount} of ${token.address} but wallet holds ` +
        `${formatUnits(held, token.decimals)}.`,
    );
  }

  const tx = await c.transfer(KEEPER, units);
  const receipt = await tx.wait();
  console.log(`  sent ${amount} (${why}) in ${receipt?.hash}`);
}

console.log('\nKeeper balances now:');
for (const { token } of TRANSFERS) {
  const bal = await erc20(token.address, signer).balanceOf(KEEPER);
  console.log(`  ${token.address} ${formatUnits(bal, token.decimals)}`);
}
console.log('\nNext: npm run pos:status to confirm, then npm run pos:danger for the demo.');
