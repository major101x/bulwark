/**
 * Rebuild the attestation ledger from known transaction hashes.
 *
 *   npm run ledger:backfill -- 0xhash1 0xhash2 ...
 *   npm run ledger:backfill                      # uses the recorded hashes below
 *
 * Receipts stay available on free RPC tiers long after `eth_getLogs` refuses to
 * look that far back, so given a hash we can always recover the full decision.
 * That asymmetry is the whole reason the agent records hashes as it writes them.
 */

import 'dotenv/config';
import { Interface, JsonRpcProvider } from 'ethers';

import { append, has, type LedgerEntry } from '../agent/ledger.ts';

/** Attestations written before the ledger existed. */
const KNOWN_HASHES = [
  '0x2d60efde2ceb3f14cbe150e59fb992aaa588738e3816f33f7b29c38cddcf48c9',
  '0xf6059979fa5f5e3bb657591ede328abb48740d572ca65333a078ed9767f7c02f',
  '0xcf9fff6662355e9cb1fa508b111a8e9a1e8889108246f0e807893c966da256b5',
  '0xc9d6540bccbe914ebaf19de03829e48e9ac5dc5c1af9a22c6435ef2da116902e',
];

const ABI = [
  'event Decision(address indexed agent, address indexed watchedWallet, uint8 indexed action, uint256 healthFactorE18, uint256 expectedLossUsdE8, uint256 rescueCostUsdE8, uint256 gasPriceGwei, bytes32 remediationTxHash, uint256 timestamp)',
];
const iface = new Interface(ABI);
const ACTIONS = ['HOLD', 'REPAY', 'ADD_COLLATERAL', 'SWAP_THEN_REPAY'];

/** Tier is not in the event; infer the band the health factor was in. */
function tierOf(hf: number): string {
  if (hf <= 1.05) return 'CRITICAL';
  if (hf <= 1.15) return 'ARMED';
  if (hf <= 1.3) return 'WATCH';
  return 'IDLE';
}

const rpcUrl = process.env.MAINNET_RPC_URL ?? 'https://ethereum-rpc.publicnode.com';
const provider = new JsonRpcProvider(rpcUrl, 1, {
  staticNetwork: true,
  batchMaxCount: 1,
});

const hashes = process.argv.slice(2).filter((a) => a.startsWith('0x'));
const targets = hashes.length > 0 ? hashes : KNOWN_HASHES;

console.log(`Backfilling ${targets.length} attestation(s) from ${new URL(rpcUrl).host}\n`);

let added = 0;
let skipped = 0;

for (const txHash of targets) {
  if (has(txHash)) {
    console.log(`  ${txHash.slice(0, 12)}… already recorded`);
    skipped++;
    continue;
  }
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      console.error(`  ${txHash.slice(0, 12)}… no receipt found`);
      continue;
    }
    // Only used for a log line. Free tiers refuse older blocks, and a cosmetic
    // timestamp must not cost us the entry: the event carries its own.
    const block = await provider.getBlock(receipt.blockNumber).catch(() => null);

    let wrote = false;
    for (const log of receipt.logs) {
      // parseLog throws on logs that do not match the ABI rather than returning
      // null, so a receipt containing any unrelated event would abort the whole
      // backfill without this.
      let parsed;
      try {
        parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      } catch {
        continue;
      }
      if (!parsed) continue;
      const a = parsed.args;
      const remediation = a.remediationTxHash as string;
      const hf = Number(a.healthFactorE18) / 1e18;
      const entry: LedgerEntry = {
        at: new Date(Number(a.timestamp) * 1000).toISOString(),
        chainId: 1,
        txHash,
        watchedWallet: a.watchedWallet as string,
        action: ACTIONS[Number(a.action)] ?? `#${a.action}`,
        tier: tierOf(hf),
        healthFactor: hf,
        expectedLossUsd: Number(a.expectedLossUsdE8) / 1e8,
        rescueCostUsd: Number(a.rescueCostUsdE8) / 1e8,
        gasPriceGwei: Number(a.gasPriceGwei),
        remediationTxHash: /^0x0+$/.test(remediation) ? null : remediation,
      };
      append(entry);
      wrote = true;
      added++;
      console.log(
        `  ${txHash.slice(0, 12)}… block ${receipt.blockNumber} ` +
          `${entry.action} HF=${hf.toFixed(4)} ` +
          `(${block ? new Date(block.timestamp * 1000).toISOString() : 'unknown time'})`,
      );
    }
    if (!wrote) console.error(`  ${txHash.slice(0, 12)}… no Decision event in receipt`);
  } catch (err) {
    console.error(
      `  ${txHash.slice(0, 12)}… failed: ` +
        (err instanceof Error ? err.message || err.name || String(err) : String(err)),
    );
  }
}

console.log(`\nAdded ${added}, skipped ${skipped} already present.`);
