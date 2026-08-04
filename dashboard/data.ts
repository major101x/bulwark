/**
 * Dashboard data aggregation.
 *
 * Pulls the three records that matter and merges them:
 *
 *   1. Live position state, from Sepolia over RPC.
 *   2. The public decision trail, from GuardianLog events on mainnet.
 *   3. KeeperHub's own audit trail, from the workflow executions listing.
 *
 * Everything runs server-side because the KeeperHub API key must not reach a
 * browser. Partial failures are collected into `warnings` and rendered rather
 * than swallowed: a monitoring page that silently shows less than it should is
 * worse than one that says what is missing.
 */

import 'dotenv/config';
import { Interface } from 'ethers';

import { decide } from '../agent/remediation.ts';
import { classify } from '../agent/risk.ts';
import { read as readLedger } from '../agent/ledger.ts';
import { observe } from '../scripts/lib.ts';

const GUARDIAN_LOG = process.env.GUARDIAN_LOG_ADDRESS ?? '';
const WATCHED = process.env.WATCHED_WALLET ?? '';
const KEEPER = process.env.KEEPERHUB_WALLET ?? '';
const WF_HF_WATCH = process.env.WF_HF_WATCH ?? '';
const KH_KEY = process.env.KEEPERHUB_API_KEY ?? '';
const KH_URL = process.env.KEEPERHUB_API_URL ?? 'https://app.keeperhub.com';

/**
 * Block GuardianLog was deployed. Scanning from genesis would be pointless and
 * slow; there are no events before this.
 */
const DEPLOY_BLOCK = 25_667_081;

/**
 * Mainnet endpoints for the event scan.
 *
 * Free tiers disagree about history: one refuses any archive range, another
 * allows 10,000 blocks per call. We chunk to the smaller limit and try each
 * endpoint in turn.
 */
const MAINNET_RPCS = [
  process.env.MAINNET_RPC_URL,
  'https://eth.drpc.org',
  'https://ethereum-rpc.publicnode.com',
].filter((u): u is string => typeof u === 'string' && u.length > 0);

/**
 * Chunk size for eth_getLogs.
 *
 * One free endpoint caps ranges at 10,000 blocks, the other times out well
 * before that. 2,000 keeps every individual request inside the per-request
 * timeout, at the cost of more of them.
 */
const MAX_LOG_RANGE = 2_000;

/**
 * Workflow runs shown. The block trigger fires every ~10 minutes, so this grows
 * without bound; 15 is enough to show the watcher running continuously without
 * burying the rest of the page. The total is reported alongside.
 */
const RUN_LIMIT = 15;

/** Per-request ceiling. An endpoint that hangs must not hang the page. */
const RPC_TIMEOUT_MS = 8_000;

/** Total budget for the whole event scan across all endpoints and chunks. */
const SCAN_BUDGET_MS = 20_000;

const GUARDIAN_LOG_EVENT_ABI = [
  'event Decision(address indexed agent, address indexed watchedWallet, uint8 indexed action, uint256 healthFactorE18, uint256 expectedLossUsdE8, uint256 rescueCostUsdE8, uint256 gasPriceGwei, bytes32 remediationTxHash, uint256 timestamp)',
];
const guardianIface = new Interface(GUARDIAN_LOG_EVENT_ABI);

const ACTION_NAMES = ['HOLD', 'REPAY', 'ADD_COLLATERAL', 'SWAP_THEN_REPAY'] as const;

export interface Attestation {
  blockNumber: number;
  txHash: string;
  action: string;
  healthFactor: number;
  expectedLossUsd: number;
  rescueCostUsd: number;
  gasPriceGwei: number;
  remediationTxHash: string | null;
  timestamp: number;
  /** Where this row came from: the agent's ledger, or a live chain scan. */
  source: 'ledger' | 'chain';
}

export interface WorkflowRun {
  id: string;
  status: string;
  triggerSource: string;
  startedAt: string;
  completedSteps: number;
  txHashes: string[];
  gasUsedWei: string | null;
}

export interface DashboardState {
  fetchedAt: string;
  warnings: string[];
  config: {
    watchedWallet: string;
    keeperWallet: string;
    guardianLog: string;
    workflowId: string;
    listingSlug: string;
  };
  position: {
    healthFactor: number | null;
    tier: string;
    collateralUsd: number;
    debtUsd: number;
    liquidationThreshold: number;
  } | null;
  decision: {
    action: string;
    tier: string;
    rationale: string;
    expectedLossUsd: number;
    rescueCostUsd: number;
    liquidationProbability: number;
  } | null;
  keeper: { usdc: string; link: string } | null;
  attestations: Attestation[];
  workflowRuns: WorkflowRun[];
  /** Total runs recorded, of which workflowRuns holds the most recent slice. */
  totalWorkflowRuns: number;
}

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

/**
 * Attestation history comes from the agent's own ledger, not from a log scan.
 *
 * Free RPC tiers cap `eth_getLogs` lookback at under 200 blocks, about 25
 * minutes, so a scan-based timeline goes blank shortly after the events it
 * exists to show. The agent records every hash it writes, and receipts stay
 * fetchable by hash long after logs stop being queryable, so the ledger is the
 * index and the chain stays the authority. Every row links to Etherscan, so a
 * reader verifies against the chain rather than trusting this file.
 *
 * We still tail the most recent blocks, which free tiers do serve, to catch
 * attestations written by something other than this agent.
 */
const LIVE_TAIL_BLOCKS = 40;

async function scanLiveTail(warnings: string[]): Promise<Attestation[]> {
  if (!GUARDIAN_LOG) return [];
  for (const url of MAINNET_RPCS) {
    try {
      const latest = Number(BigInt((await rpc(url, 'eth_blockNumber', [])) as string));
      const from = Math.max(DEPLOY_BLOCK, latest - LIVE_TAIL_BLOCKS);
      const logs = (await rpc(url, 'eth_getLogs', [
        {
          address: GUARDIAN_LOG,
          fromBlock: `0x${from.toString(16)}`,
          toBlock: 'latest',
        },
      ])) as Array<{ topics: string[]; data: string; blockNumber: string; transactionHash: string }>;

      const out: Attestation[] = [];
      for (const log of logs) {
        let parsed;
        try {
          parsed = guardianIface.parseLog({ topics: log.topics, data: log.data });
        } catch {
          continue;
        }
        if (!parsed) continue;
        const a = parsed.args;
        const remediation = a.remediationTxHash as string;
        out.push({
          blockNumber: Number(BigInt(log.blockNumber)),
          txHash: log.transactionHash,
          action: ACTION_NAMES[Number(a.action)] ?? `#${a.action}`,
          healthFactor: Number(a.healthFactorE18) / 1e18,
          expectedLossUsd: Number(a.expectedLossUsdE8) / 1e8,
          rescueCostUsd: Number(a.rescueCostUsdE8) / 1e8,
          gasPriceGwei: Number(a.gasPriceGwei),
          remediationTxHash: /^0x0+$/.test(remediation) ? null : remediation,
          timestamp: Number(a.timestamp),
          source: 'chain',
        });
      }
      return out;
    } catch {
      // Tail is a bonus, not the source of truth. Try the next endpoint.
    }
  }
  warnings.push(
    `live tail unavailable, showing ledger only (last ${LIVE_TAIL_BLOCKS} blocks unchecked)`,
  );
  return [];
}

async function fetchAttestations(warnings: string[]): Promise<Attestation[]> {
  const fromLedger: Attestation[] = readLedger().map((e) => ({
    blockNumber: 0,
    txHash: e.txHash,
    action: e.action,
    healthFactor: e.healthFactor,
    expectedLossUsd: e.expectedLossUsd,
    rescueCostUsd: e.rescueCostUsd,
    gasPriceGwei: e.gasPriceGwei,
    remediationTxHash: e.remediationTxHash,
    timestamp: Math.floor(new Date(e.at).getTime() / 1000),
    source: 'ledger' as const,
  }));

  const seen = new Set(fromLedger.map((a) => a.txHash.toLowerCase()));
  const tail = (await scanLiveTail(warnings)).filter(
    (a) => !seen.has(a.txHash.toLowerCase()),
  );
  if (tail.length > 0) {
    warnings.push(
      `${tail.length} attestation(s) found on chain but missing from the ledger, ` +
        `run: npm run ledger:backfill -- ${tail.map((a) => a.txHash).join(' ')}`,
    );
  }

  return [...tail, ...fromLedger].sort((x, y) => y.timestamp - x.timestamp);
}

/** Set as a side effect of fetchWorkflowRuns, so the page can show N of M. */
let totalRuns = 0;

async function fetchWorkflowRuns(warnings: string[]): Promise<WorkflowRun[]> {
  if (!WF_HF_WATCH || !KH_KEY) {
    warnings.push('WF_HF_WATCH or KEEPERHUB_API_KEY unset, no workflow history');
    return [];
  }
  try {
    const res = await fetch(`${KH_URL}/api/workflows/${WF_HF_WATCH}/executions`, {
      headers: { authorization: `Bearer ${KH_KEY}` },
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    totalRuns = rows.length;
    return rows.slice(0, RUN_LIMIT).map((r) => ({
      id: String(r.id),
      status: String(r.status),
      triggerSource: String(r.triggerSource ?? 'unknown'),
      startedAt: String(r.startedAt),
      completedSteps: Number(r.completedSteps ?? 0),
      txHashes: Array.isArray(r.transactionHashes)
        ? (r.transactionHashes as Array<{ hash: string }>).map((h) => h.hash)
        : [],
      gasUsedWei: r.gasUsedWei === null ? null : String(r.gasUsedWei),
    }));
  } catch (err) {
    warnings.push(
      `workflow history failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

export async function getState(): Promise<DashboardState> {
  const warnings: string[] = [];

  const [live, attestations, workflowRuns] = await Promise.all([
    (async () => {
      if (!WATCHED || !KEEPER) {
        warnings.push('WATCHED_WALLET or KEEPERHUB_WALLET unset');
        return null;
      }
      try {
        return await observe(WATCHED, KEEPER);
      } catch (err) {
        warnings.push(
          `position read failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    })(),
    fetchAttestations(warnings),
    fetchWorkflowRuns(warnings),
  ]);

  const decision = live ? decide(live.position, live.balances, live.gas) : null;

  return {
    fetchedAt: new Date().toISOString(),
    warnings,
    config: {
      watchedWallet: WATCHED,
      keeperWallet: KEEPER,
      guardianLog: GUARDIAN_LOG,
      workflowId: WF_HF_WATCH,
      listingSlug: process.env.MARKETPLACE_SLUG ?? '',
    },
    position: live
      ? {
          healthFactor: Number.isFinite(live.position.healthFactor)
            ? live.position.healthFactor
            : null,
          tier: classify(live.position.healthFactor),
          collateralUsd: live.position.totalCollateralUsd,
          debtUsd: live.position.totalDebtUsd,
          liquidationThreshold: live.position.liquidationThreshold,
        }
      : null,
    decision: decision
      ? {
          action: decision.action,
          tier: decision.tier,
          rationale: decision.rationale,
          expectedLossUsd: decision.expectedLossUsd,
          rescueCostUsd: decision.rescueCostUsd,
          liquidationProbability: decision.liquidationProbability,
        }
      : null,
    keeper: live
      ? {
          usdc: (Number(live.balances.debtAsset) / 1e6).toFixed(2),
          link: (Number(live.balances.collateralAsset) / 1e18).toFixed(4),
        }
      : null,
    attestations,
    workflowRuns,
    totalWorkflowRuns: totalRuns,
  };
}
