/**
 * Clear stuck transactions from the chaos baseline wallet.
 *
 *   npm run chaos:unstick
 *
 * The underpricing scenario leaves transactions sitting in the mempool, and
 * every later transaction from that address queues behind them by nonce. That
 * is the failure being measured, but it has to be cleared before the next run
 * or the following scenario inherits a wedged wallet and its numbers are
 * meaningless.
 *
 * Clearing works by replacing each pending nonce with a zero-value self-send at
 * a gas price high enough to actually mine.
 */

import { JsonRpcProvider, Wallet, formatUnits, parseUnits } from 'ethers';
import 'dotenv/config';

const rpc =
  process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const key = process.env.CHAOS_BASELINE_PRIVATE_KEY;
if (!key) throw new Error('Set CHAOS_BASELINE_PRIVATE_KEY in .env');

const provider = new JsonRpcProvider(rpc);
const wallet = new Wallet(key, provider);

const confirmed = await provider.getTransactionCount(wallet.address, 'latest');
const pending = await provider.getTransactionCount(wallet.address, 'pending');

console.log(`Baseline ${wallet.address}`);
console.log(`  confirmed nonce ${confirmed}, pending nonce ${pending}`);

if (pending === confirmed) {
  console.log('  nothing stuck');
  process.exit(0);
}

const market = (await provider.getFeeData()).gasPrice ?? parseUnits('1', 'gwei');
// Replacement needs a meaningful bump over the original, and the originals were
// deliberately underpriced, so go well above market rather than nudging.
const replacementPrice = market * 5n;
console.log(
  `  replacing ${pending - confirmed} stuck tx at ` +
    `${formatUnits(replacementPrice, 'gwei')} gwei`,
);

for (let nonce = confirmed; nonce < pending; nonce++) {
  try {
    const tx = await wallet.sendTransaction({
      to: wallet.address,
      value: 0n,
      nonce,
      gasPrice: replacementPrice,
    });
    const receipt = await tx.wait();
    console.log(`  nonce ${nonce} cleared in ${receipt?.hash}`);
  } catch (err) {
    console.error(
      `  nonce ${nonce} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

console.log(
  `\nFinal: confirmed ${await provider.getTransactionCount(wallet.address, 'latest')}, ` +
    `pending ${await provider.getTransactionCount(wallet.address, 'pending')}`,
);
