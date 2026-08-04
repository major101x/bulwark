/**
 * Local append-only record of every attestation the agent has written.
 *
 * Why this exists rather than reading the chain: free RPC tiers cap
 * `eth_getLogs` lookback at well under 200 blocks, roughly 25 minutes. Any
 * history older than that is simply unreadable without a paid archive endpoint
 * or an indexer, so a dashboard that relies on scanning logs shows an empty
 * timeline within half an hour of the events it is meant to display.
 *
 * The agent already knows every hash it wrote, so it records them as it goes.
 * The ledger is the index; the chain remains the authority. Every row carries
 * its transaction hash, so any reader can verify a claim here against Etherscan
 * independently, and a tampered ledger is caught by checking the chain rather
 * than by trusting this file.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface LedgerEntry {
  /** ISO timestamp the agent wrote the attestation. */
  at: string;
  chainId: number;
  txHash: string;
  watchedWallet: string;
  action: string;
  tier: string;
  healthFactor: number;
  expectedLossUsd: number;
  rescueCostUsd: number;
  gasPriceGwei: number;
  /** The Sepolia rescue this decision produced, if it acted. */
  remediationTxHash: string | null;
}

const DEFAULT_PATH = process.env.LEDGER_PATH ?? 'data/attestations.jsonl';

export function append(entry: LedgerEntry, path = DEFAULT_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
}

/**
 * Read the ledger, newest first.
 *
 * Malformed lines are skipped rather than throwing: a half-written line from a
 * process killed mid-append must not take down the dashboard, and losing one
 * row is better than losing the view of all of them.
 */
export function read(path = DEFAULT_PATH): LedgerEntry[] {
  if (!existsSync(path)) return [];
  const entries: LedgerEntry[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      entries.push(JSON.parse(trimmed) as LedgerEntry);
    } catch {
      // Skip and keep going.
    }
  }
  return entries.reverse();
}

/** True when this transaction is already recorded, so replays stay idempotent. */
export function has(txHash: string, path = DEFAULT_PATH): boolean {
  return read(path).some((e) => e.txHash.toLowerCase() === txHash.toLowerCase());
}
