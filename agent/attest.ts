/**
 * Mainnet attestation.
 *
 * Every decision, including the ones where we decline to spend gas, is
 * written to GuardianLog on Ethereum mainnet. These calls move no value, so
 * they need no capital, only gas, which KeeperHub sponsors on mainnet.
 *
 * This is also how the submission requirement for "a link to a transaction
 * your agent executed via KeeperHub" is satisfied without funding a mainnet
 * lending position.
 */

import { Interface } from 'ethers';

import { KeeperHubBackend, type ExecutionResult } from './executor.ts';
import type { Decision } from './types.ts';

export const GUARDIAN_LOG_ABI = [
  'function attest(address watchedWallet, uint8 action, uint256 healthFactorE18, uint256 expectedLossUsdE8, uint256 rescueCostUsdE8, uint256 gasPriceGwei, bytes32 remediationTxHash)',
] as const;

const iface = new Interface(GUARDIAN_LOG_ABI);

/** JSON ABI form, which is what the REST execute endpoint expects. */
export const GUARDIAN_LOG_ABI_JSON = JSON.parse(
  iface.formatJson(),
) as unknown[];

const MAINNET_CHAIN_ID = 1;
const ZERO_HASH = `0x${'0'.repeat(64)}`;

/** Solidity enum ordering in GuardianLog.Action. */
const ACTION_CODE = {
  HOLD: 0,
  REPAY: 1,
  ADD_COLLATERAL: 2,
  SWAP_THEN_REPAY: 3,
} as const;

function actionCode(decision: Decision): number {
  if (decision.action === 'HOLD') return ACTION_CODE.HOLD;
  return ACTION_CODE[decision.remediation?.kind ?? 'REPAY'];
}

/** Scale a float to fixed-point without accumulating float error in the tail. */
function toFixedPoint(value: number, decimals: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  return BigInt(Math.round(value * 10 ** decimals));
}

/** Arguments for GuardianLog.attest, in ABI order. */
export function attestationArgs(
  decision: Decision,
  watchedWallet: string,
  healthFactor: number,
  gasPriceGwei: number,
  remediationTxHash: string = ZERO_HASH,
): unknown[] {
  return [
    watchedWallet,
    actionCode(decision),
    // HF can be Infinity when there is no debt; clamp so encoding cannot throw.
    toFixedPoint(Number.isFinite(healthFactor) ? healthFactor : 0, 18),
    toFixedPoint(decision.expectedLossUsd, 8),
    toFixedPoint(decision.rescueCostUsd, 8),
    BigInt(Math.round(gasPriceGwei)),
    remediationTxHash,
  ];
}

/** ABI-encoded calldata, for the naive baseline and for tests. */
export function encodeAttestation(
  decision: Decision,
  watchedWallet: string,
  healthFactor: number,
  gasPriceGwei: number,
  remediationTxHash: string = ZERO_HASH,
): string {
  return iface.encodeFunctionData(
    'attest',
    attestationArgs(decision, watchedWallet, healthFactor, gasPriceGwei, remediationTxHash),
  );
}

export async function attestDecision(
  backend: KeeperHubBackend,
  guardianLogAddress: string,
  decision: Decision,
  watchedWallet: string,
  healthFactor: number,
  gasPriceGwei: number,
  remediationTxHash?: string,
): Promise<ExecutionResult> {
  return backend.execute({
    label: `attest:${decision.action}`,
    chainId: MAINNET_CHAIN_ID,
    to: guardianLogAddress,
    functionName: 'attest',
    functionArgs: attestationArgs(
      decision,
      watchedWallet,
      healthFactor,
      gasPriceGwei,
      remediationTxHash,
    ),
    abi: [...GUARDIAN_LOG_ABI_JSON],
    // Same decision must never attest twice if the agent restarts mid-write.
    idempotencyKey: `attest-${watchedWallet}-${decision.action}-${remediationTxHash ?? 'hold'}`,
  });
}
