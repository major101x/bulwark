/**
 * GasGuard entry point.
 *
 * Exposes POST /evaluate, which the `hf-watch` KeeperHub workflow calls when a
 * position drops below the watch threshold. The workflow owns the schedule and
 * the alerting; this process owns the judgment.
 *
 * Flow:
 *   hf-watch (KeeperHub, every N blocks)
 *     -> POST /evaluate { wallet, healthFactor, ... }
 *       -> decide()
 *         -> RESCUE: run rescue workflow, then attest the outcome
 *         -> HOLD:   attest the hold, with the reasoning
 */

import { createServer } from 'node:http';

import { attestDecision } from './attest.ts';
import { KeeperHubBackend } from './executor.ts';
import { config } from './config.ts';
import { decide } from './remediation.ts';
import { classify, gasPolicyFor } from './risk.ts';
import type { GasSnapshot, PositionSnapshot, WalletBalances } from './types.ts';

interface EvaluateBody {
  position: PositionSnapshot;
  balances: WalletBalances;
  gas: GasSnapshot;
}

/**
 * JSON.parse cannot produce bigints, so balances arrive as decimal strings.
 * Converting here keeps the base-unit/float split enforced at the boundary.
 */
function parseBalances(raw: Record<string, unknown>): WalletBalances {
  return {
    debtAsset: BigInt(String(raw.debtAsset ?? '0')),
    collateralAsset: BigInt(String(raw.collateralAsset ?? '0')),
    debtAssetDecimals: Number(raw.debtAssetDecimals ?? 6),
    collateralAssetDecimals: Number(raw.collateralAssetDecimals ?? 18),
    debtAssetPriceUsd: Number(raw.debtAssetPriceUsd ?? 1),
    collateralAssetPriceUsd: Number(raw.collateralAssetPriceUsd ?? 0),
  };
}

async function handleEvaluate(body: EvaluateBody) {
  const { position, gas } = body;
  const balances = parseBalances(body.balances as unknown as Record<string, unknown>);

  const decision = decide(position, balances, gas);
  const tier = classify(position.healthFactor);

  // The rationale is the line read aloud in the demo. Keep it on one line.
  console.log(`[${new Date().toISOString()}] ${decision.rationale}`);

  if (config.dryRun) {
    console.log('  DRY_RUN=1: computed only, nothing executed.');
    return { ...decision, executed: false, dryRun: true };
  }

  const backend = new KeeperHubBackend({
    apiKey: config.keeperhub.apiKey(),
    apiUrl: config.keeperhub.apiUrl,
  });

  let remediationTxHash: string | undefined;

  if (decision.action === 'RESCUE' && decision.remediation) {
    const policy = gasPolicyFor(tier, decision.expectedLossUsd);
    const workflowId =
      decision.remediation.kind === 'ADD_COLLATERAL'
        ? config.keeperhub.workflows.rescueCollateral()
        : config.keeperhub.workflows.rescueRepay();

    const result = await backend.runWorkflow(workflowId, {
      wallet: position.wallet,
      amount: decision.remediation.amount.toString(),
      asset:
        decision.remediation.kind === 'ADD_COLLATERAL'
          ? config.position.collateralAsset()
          : config.position.debtAsset(),
      gasPolicy: policy,
    });

    remediationTxHash = result.txHash;
    console.log(
      `  ${result.ok ? '✅' : '❌'} ${decision.remediation.kind} ` +
        `tx=${result.txHash ?? 'none'} bumps=${result.bumps} ` +
        `latency=${result.latencyMs}ms${result.error ? ` error=${result.error}` : ''}`,
    );
  }

  // Attest regardless of outcome. A keeper that only records its successes is
  // not an audit trail, and a failed rescue is the most important thing to log.
  try {
    const attestation = await attestDecision(
      backend,
      config.guardianLogAddress(),
      decision,
      position.wallet,
      position.healthFactor,
      gas.baseFeeGwei,
      remediationTxHash,
    );
    console.log(`  📝 attested on mainnet: ${attestation.txHash ?? 'pending'}`);
  } catch (err) {
    // Never let a failed attestation mask a successful rescue.
    console.error(`  ⚠️  attestation failed: ${err}`);
  }

  return { ...decision, executed: decision.action === 'RESCUE', remediationTxHash };
}

const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/evaluate') {
    res.writeHead(404).end('not found');
    return;
  }

  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', async () => {
    try {
      const result = await handleEvaluate(JSON.parse(raw) as EvaluateBody);
      res.writeHead(200, { 'content-type': 'application/json' });
      // bigints in the remediation cannot be serialised directly.
      res.end(JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    } catch (err) {
      console.error(err);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });
});

server.listen(config.agentPort, () => {
  console.log(`GasGuard listening on :${config.agentPort}`);
  console.log(config.dryRun ? 'DRY_RUN is ON, nothing will execute.' : '⚠️  LIVE MODE');
});
