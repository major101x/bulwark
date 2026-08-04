/**
 * GasGuard agent loop.
 *
 *   npm run agent              # DRY_RUN=1 by default, decides but executes nothing
 *   DRY_RUN=0 npm run agent    # live
 *
 * Division of labour with the `hf-watch-critical` workflow:
 *
 *   The workflow owns CRITICAL. It runs inside KeeperHub on a block trigger, so
 *   the position stays defended even when this process is not running. It acts
 *   on a fixed-size top-up and deliberately ignores economics, because at
 *   HF <= 1.05 a passing gas spike is not a reason to let a position liquidate.
 *
 *   This loop owns ARMED, where the interesting behaviour is *declining* to
 *   act. That judgment needs the first-passage probability model and a
 *   cost/benefit comparison, neither of which fits in a condition node.
 *
 * Both write to GuardianLog on mainnet, so the public record covers holds as
 * well as rescues. A keeper that only records its successes is not an audit
 * trail, and the declined rescues are the interesting judgment calls.
 */

import 'dotenv/config';

import { attestDecision } from './attest.ts';
import { KeeperHubBackend } from './executor.ts';
import { decide } from './remediation.ts';
import { classify, gasPolicyFor, pollIntervalBlocks } from './risk.ts';
import type { Decision, RiskTier } from './types.ts';
import { AAVE, RATE_MODE, TOKENS, observe } from '../scripts/lib.ts';

const WATCHED = process.env.WATCHED_WALLET;
const KEEPER = process.env.KEEPERHUB_WALLET;
const GUARDIAN_LOG = process.env.GUARDIAN_LOG_ADDRESS;
const DRY_RUN = (process.env.DRY_RUN ?? '1') !== '0';

if (!WATCHED || !KEEPER) {
  throw new Error('Set WATCHED_WALLET and KEEPERHUB_WALLET in .env');
}

/** ~12s blocks on Sepolia. The tier decides how many blocks we skip. */
const BLOCK_MS = 12_000;

const backend = new KeeperHubBackend({
  apiKey: process.env.KEEPERHUB_API_KEY ?? '',
  apiUrl: process.env.KEEPERHUB_API_URL ?? 'https://app.keeperhub.com',
});

/**
 * What we last wrote to the audit trail.
 *
 * Attesting every tick would put a mainnet transaction on chain every few
 * minutes to say nothing changed, which is noise and burns the execution quota
 * for no information. We attest when the *decision* changes: a new tier, or an
 * action taken. That keeps the record complete without making it worthless.
 */
interface LastAttested {
  tier: RiskTier;
  action: Decision['action'];
}
let lastAttested: LastAttested | undefined;

function shouldAttest(decision: Decision): boolean {
  if (decision.action === 'RESCUE') return true; // always record acting
  if (lastAttested === undefined) return true; // first observation
  return lastAttested.tier !== decision.tier;
}

async function executeRescue(decision: Decision): Promise<string | undefined> {
  const remediation = decision.remediation;
  if (!remediation) return undefined;

  const policy = gasPolicyFor(decision.tier, decision.expectedLossUsd);
  const isCollateral = remediation.kind === 'ADD_COLLATERAL';
  const asset = isCollateral ? TOKENS.LINK.address : TOKENS.USDC.address;

  // Approve first. The pool moves the keeper's tokens, so without an allowance
  // the action below reverts, and the allowance is consumed by each rescue.
  const approve = await backend.execute({
    label: 'rescue:approve',
    chainId: 11155111,
    to: asset,
    functionName: 'approve',
    functionArgs: [AAVE.pool, remediation.amount],
    abi: [
      {
        inputs: [
          { name: 'spender', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        name: 'approve',
        outputs: [{ name: '', type: 'bool' }],
        stateMutability: 'nonpayable',
        type: 'function',
      },
    ],
    gasPolicy: policy,
    idempotencyKey: `rescue-approve-${WATCHED}-${remediation.amount}-${decision.tier}`,
  });

  if (!approve.ok) {
    console.error(`  approve failed: ${approve.error}`);
    return undefined;
  }

  // onBehalfOf is the watched position, not the keeper. The keeper spends its
  // own tokens to defend somebody else's position.
  const result = await backend.executeProtocolAction(
    isCollateral ? 'aave-v3/supply' : 'aave-v3/repay',
    isCollateral
      ? {
          chainId: '11155111',
          asset,
          amount: remediation.amount.toString(),
          onBehalfOf: WATCHED!,
          // Required despite the schema listing it optional.
          referralCode: '0',
        }
      : {
          chainId: '11155111',
          asset,
          amount: remediation.amount.toString(),
          onBehalfOf: WATCHED!,
          interestRateMode: String(RATE_MODE.variable),
        },
  );

  console.log(
    `  ${result.ok ? 'rescued' : 'rescue failed'}: ${remediation.kind} ` +
      `${result.txHash ?? result.error ?? ''}`,
  );
  return result.txHash;
}

async function tick(): Promise<number> {
  const { position, balances, gas } = await observe(WATCHED!, KEEPER!);
  const decision = decide(position, balances, gas);
  const tier = classify(position.healthFactor);

  console.log(`[${new Date().toISOString()}] ${decision.rationale}`);

  if (DRY_RUN) {
    console.log('  DRY_RUN=1, nothing executed');
    lastAttested = { tier: decision.tier, action: decision.action };
    return pollIntervalBlocks(tier) * BLOCK_MS;
  }

  let remediationTxHash: string | undefined;
  if (decision.action === 'RESCUE') {
    remediationTxHash = await executeRescue(decision);
  }

  if (shouldAttest(decision)) {
    if (!GUARDIAN_LOG) {
      console.error('  GUARDIAN_LOG_ADDRESS unset, skipping attestation');
    } else {
      try {
        const attestation = await attestDecision(
          backend,
          GUARDIAN_LOG,
          decision,
          position.wallet,
          position.healthFactor,
          gas.baseFeeGwei,
          remediationTxHash,
        );
        console.log(
          `  attested ${decision.tier}/${decision.action} on mainnet` +
            (attestation.ok ? '' : `: FAILED ${attestation.error}`),
        );
      } catch (err) {
        // A failed attestation must never mask a successful rescue.
        console.error(`  attestation error: ${err}`);
      }
    }
    lastAttested = { tier: decision.tier, action: decision.action };
  }

  return pollIntervalBlocks(tier) * BLOCK_MS;
}

console.log(
  `GasGuard loop watching ${WATCHED}\n` +
    `  keeper ${KEEPER}\n` +
    `  ${DRY_RUN ? 'DRY_RUN is ON, nothing will execute' : 'LIVE MODE'}\n` +
    `  CRITICAL is handled server-side by the hf-watch-critical workflow\n`,
);

const once = process.argv.includes('--once');
do {
  let waitMs = 60_000;
  try {
    waitMs = await tick();
  } catch (err) {
    // One bad poll must not kill a keeper. Back off and try again.
    console.error(`  tick failed: ${err instanceof Error ? err.message : err}`);
  }
  if (once) break;
  await new Promise((r) => setTimeout(r, waitMs));
} while (true);
