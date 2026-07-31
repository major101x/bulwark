/**
 * Environment loading. Fails loudly and early: a keeper that starts up with a
 * missing workflow ID and discovers it at 3am during a rescue is worse than
 * one that refuses to boot.
 */

import 'dotenv/config';

function required(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new Error(
      `Missing required env var ${key}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function optional(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}

export const config = {
  keeperhub: {
    apiKey: () => required('KEEPERHUB_API_KEY'),
    apiUrl: optional('KEEPERHUB_API_URL', 'https://app.keeperhub.com'),
    workflows: {
      hfWatch: () => required('WF_HF_WATCH'),
      rescueRepay: () => required('WF_RESCUE_REPAY'),
      rescueCollateral: () => required('WF_RESCUE_COLLATERAL'),
      attestMainnet: () => required('WF_ATTEST_MAINNET'),
    },
  },
  position: {
    watchedWallet: () => required('WATCHED_WALLET'),
    aavePool: () => required('AAVE_POOL_SEPOLIA'),
    debtAsset: () => required('DEBT_ASSET'),
    collateralAsset: () => required('COLLATERAL_ASSET'),
  },
  rpc: {
    sepolia: optional('SEPOLIA_RPC_URL', 'https://ethereum-sepolia-rpc.publicnode.com'),
    mainnet: optional('MAINNET_RPC_URL', 'https://ethereum-rpc.publicnode.com'),
  },
  guardianLogAddress: () => required('GUARDIAN_LOG_ADDRESS'),
  agentPort: Number(optional('AGENT_PORT', '8787')),
  /** When true, compute and log decisions but execute nothing. Default on. */
  dryRun: optional('DRY_RUN', '1') !== '0',
} as const;
