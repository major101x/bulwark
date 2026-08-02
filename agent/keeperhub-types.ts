/**
 * KeeperHub wire shapes, VERIFIED against a live account on 2026-08-02.
 *
 * These are transcribed from real responses, not from the docs. Each field
 * below was observed in an actual execution:
 *
 *   approve   0xa6041117ac9d6ea52c4f52075cae603e0b75e06ec56bb0a03a341a601649599b
 *   supply    0xacf47d3fe4f491226b7ad24fcf845aecea7ca1927fbd4118970eb5de3f4ab0ac
 *
 * Findings that are not in the documentation:
 *
 *   1. `web3/*` actions (approve-token, transfer-token, write-contract) cannot
 *      be run through direct execution. They return 501 and must be wrapped in
 *      a workflow. Use `execute_contract_call` for one-off writes instead.
 *   2. `aave-v3/*` amounts are in the asset's SMALLEST UNIT, not human units.
 *      Only the aave-v4 docs mention this; the v3 action does not.
 *   3. `referralCode` is required on aave-v3/supply despite being advertised as
 *      optional. Omitting it fails argument encoding, not validation.
 *   4. Executions are gas sponsored on Sepolia too, not only mainnet.
 *   5. The wallet is an EIP-7702 delegated EOA. Calls route through an executor
 *      contract, but `msg.sender` remains the wallet, so allowances and
 *      balances belong to the wallet address as expected.
 */

/** Terminal and in-flight states observed on a direct execution. */
export type KeeperHubStatus = 'pending' | 'running' | 'completed' | 'failed';

/** The `executedCall` sub-object, present once a write has been attempted. */
export interface KeeperHubExecutedCall {
  contractAddress: string;
  functionName: string;
  functionSignature: string;
  args: Record<string, string>;
  sponsored: boolean;
  reverted: boolean;
  /** The executor contract calls are routed through, not the final target. */
  topLevelTo: string;
}

/** Result payload of a completed direct execution. */
export interface KeeperHubResult {
  success: boolean;
  sponsored: boolean;
  transactionHash?: string;
  transactionLink?: string;
  gasUsed?: string;
  gasUsedUnits?: string;
  effectiveGasPrice?: string;
  executedCall?: KeeperHubExecutedCall;
}

/** Response of `get_direct_execution_status`. */
export interface KeeperHubExecutionStatus {
  executionId: string;
  status: KeeperHubStatus;
  type: 'contract-call' | 'transfer' | 'check-and-execute';
  transactionHash?: string;
  transactionLink?: string;
  result?: KeeperHubResult;
  error: string | null;
  gasUsedWei?: string;
  gasPriceWei?: string;
  estimatedCostUsd: number | null;
  /** How many times KeeperHub resubmitted. Feeds the chaos scorecard. */
  retryCount: number;
  network: string;
  createdAt: string;
  completedAt?: string;
}

/**
 * `execute_protocol_action` returns the result inline rather than an execution
 * id, so it has its own shape. Failures come back as `success: false` with a
 * message rather than as an HTTP error.
 */
export interface ProtocolActionResponse {
  success: boolean;
  error?: string;
  errorClass?: 'user' | 'system';
  sponsored?: boolean;
  transactionHash?: string;
  transactionLink?: string;
  gasUsed?: string;
  effectiveGasPrice?: string;
  executedCall?: KeeperHubExecutedCall;
  /** Present on read actions such as get-user-account-data. */
  result?: Record<string, string>;
}

/** Chain ids we execute against. */
export const CHAIN = {
  mainnet: 1,
  sepolia: 11155111,
  base: 8453,
} as const;
