/**
 * Fund the chaos harness baseline wallet.
 *
 *   npm run chaos:fund
 *
 * The naive backend gets its own throwaway wallet rather than reusing the
 * position wallet, because the harness deliberately gets transactions stuck at
 * an underpriced gas price. A stuck transaction blocks every later one from the
 * same address behind its nonce, which is exactly the failure we want to
 * measure and exactly what we do not want happening to the live position.
 */

import { formatEther, parseEther, parseUnits } from 'ethers';

import { TOKENS, erc20, positionSigner, provider } from './lib.ts';

const BASELINE = process.env.CHAOS_BASELINE_ADDRESS;
if (!BASELINE) {
  throw new Error('Set CHAOS_BASELINE_ADDRESS in .env (see scripts/fund-chaos.ts).');
}

const ETH_TO_SEND = parseEther('0.03');
const LINK_TO_SEND = parseUnits('10', TOKENS.LINK.decimals);

const signer = positionSigner();
const p = provider();

const existing = await p.getBalance(BASELINE);
console.log(`Baseline wallet ${BASELINE}`);
console.log(`  current ETH ${formatEther(existing)}`);

if (existing < ETH_TO_SEND / 2n) {
  const tx = await signer.sendTransaction({ to: BASELINE, value: ETH_TO_SEND });
  console.log(`  funded ETH in ${(await tx.wait())?.hash}`);
} else {
  console.log('  ETH balance already sufficient');
}

const link = erc20(TOKENS.LINK.address, signer);
const heldLink = await link.balanceOf(BASELINE);
if (heldLink < LINK_TO_SEND / 2n) {
  const tx = await link.transfer(BASELINE, LINK_TO_SEND);
  console.log(`  funded LINK in ${(await tx.wait())?.hash}`);
} else {
  console.log('  LINK balance already sufficient');
}

console.log(
  `\nFinal: ETH ${formatEther(await p.getBalance(BASELINE))}, ` +
    `LINK ${await link.balanceOf(BASELINE)}`,
);

