/**
 * Clear stuck transactions from the chaos baseline wallet.
 *
 *   npm run chaos:unstick
 *
 * The harness now clears between backends on its own, so this is the manual
 * escape hatch for when a run was killed part-way and left the wallet wedged.
 * The logic lives in chaos/mempool.ts so both callers stay in step.
 */

import 'dotenv/config';

import { clearStuckNonces } from '../chaos/mempool.ts';

const rpc =
  process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const key = process.env.CHAOS_BASELINE_PRIVATE_KEY;
if (!key) throw new Error('Set CHAOS_BASELINE_PRIVATE_KEY in .env');

const report = await clearStuckNonces(rpc, key, (line) => console.log(line));

console.log(
  `\n${report.address}\n` +
    `  confirmed ${report.confirmedNonce}, pending ${report.pendingNonce}\n` +
    `  stuck ${report.stuck}, cleared ${report.cleared}, failed ${report.failed}`,
);
