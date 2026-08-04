/**
 * Shared Sepolia addresses and helpers for the position-management scripts.
 *
 * Every address here was resolved from Aave's PoolAddressesProvider on chain
 * rather than copied from a blog post, and the token addresses came out of the
 * faucet mint receipts. Verify with `npm run pos:status` before trusting them.
 */

import 'dotenv/config';
import { Contract, JsonRpcProvider, Wallet, formatUnits } from 'ethers';

import type {
  GasSnapshot,
  PositionSnapshot,
  WalletBalances,
} from '../agent/types.ts';
import type { ContractTransactionResponse } from 'ethers';

export const SEPOLIA_CHAIN_ID = 11155111;

export const AAVE = {
  addressesProvider: '0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A',
  pool: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
  dataProvider: '0x3e9708d80f7B3e43118013075F7e95CE3AB31F31',
  oracle: '0x2da88497588bf89281816106C7259e31AF45a663',
} as const;

/** Aave V3 Sepolia test tokens, from the faucet at 0xC959...42D. */
export const TOKENS = {
  LINK: { address: '0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5', decimals: 18 },
  USDC: { address: '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8', decimals: 6 },
  DAI: { address: '0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357', decimals: 18 },
  WETH: { address: '0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c', decimals: 18 },
} as const;

/** Aave V3 interest rate modes. Stable is disabled on most reserves. */
export const RATE_MODE = { stable: 1, variable: 2 } as const;

export const POOL_ABI = [
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function setUserUseReserveAsCollateral(address asset, bool useAsCollateral)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
] as const;

export const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
] as const;

/**
 * Typed views over the contracts.
 *
 * ethers exposes contract methods through an index signature, which under
 * `noUncheckedIndexedAccess` makes every call possibly-undefined. Declaring the
 * shapes we actually use is better than relaxing the compiler flag, and it
 * catches argument-order mistakes: Aave's `borrow` and `supply` both take an
 * `onBehalfOf`, but in different positions.
 */
export interface PoolContract {
  supply(
    asset: string,
    amount: bigint,
    onBehalfOf: string,
    referralCode: number,
  ): Promise<ContractTransactionResponse>;
  borrow(
    asset: string,
    amount: bigint,
    interestRateMode: number,
    referralCode: number,
    onBehalfOf: string,
  ): Promise<ContractTransactionResponse>;
  repay(
    asset: string,
    amount: bigint,
    interestRateMode: number,
    onBehalfOf: string,
  ): Promise<ContractTransactionResponse>;
  withdraw(
    asset: string,
    amount: bigint,
    to: string,
  ): Promise<ContractTransactionResponse>;
  setUserUseReserveAsCollateral(
    asset: string,
    useAsCollateral: boolean,
  ): Promise<ContractTransactionResponse>;
  getUserAccountData(user: string): Promise<{
    totalCollateralBase: bigint;
    totalDebtBase: bigint;
    availableBorrowsBase: bigint;
    currentLiquidationThreshold: bigint;
    ltv: bigint;
    healthFactor: bigint;
  }>;
}

export interface Erc20Contract {
  approve(spender: string, amount: bigint): Promise<ContractTransactionResponse>;
  allowance(owner: string, spender: string): Promise<bigint>;
  balanceOf(account: string): Promise<bigint>;
  transfer(to: string, amount: bigint): Promise<ContractTransactionResponse>;
  decimals(): Promise<bigint>;
}

/**
 * Sepolia endpoints, in preference order.
 *
 * A single public RPC dropped repeatedly over a day of building: it wedged an
 * agent tick, and it polluted a chaos cell with estimateGas failures that were
 * nothing to do with the backend under test. One endpoint is a single point of
 * failure for both the keeper and its own measurements.
 */
const SEPOLIA_RPCS = [
  process.env.SEPOLIA_RPC_URL,
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://sepolia.drpc.org',
].filter((u): u is string => typeof u === 'string' && u.length > 0);

/**
 * A plain provider for one endpoint.
 *
 * We tried ethers' FallbackProvider here and backed it out. It broke the write
 * path (network detection failed under a Wallet) and then the read path ("no
 * runners?!" once its sub-providers were unhealthy), which is a lot of opaque
 * failure to inherit in exchange for retry logic we can write in ten lines and
 * actually debug.
 */
export function providerFor(url: string): JsonRpcProvider {
  return new JsonRpcProvider(url, SEPOLIA_CHAIN_ID, {
    staticNetwork: true,
    // ethers batches parallel reads by default and free tiers reject batches
    // (drpc caps them at 3), failing a whole observation rather than one call.
    batchMaxCount: 1,
  });
}

/** Default read provider: the first configured endpoint. */
export function provider(): JsonRpcProvider {
  return providerFor(SEPOLIA_RPCS[0]!);
}

/**
 * Run a read against each endpoint in turn until one answers.
 *
 * Every public Sepolia endpoint we tried dropped requests at some point today.
 * Reads are idempotent, so retrying elsewhere is always safe.
 */
export async function withRpcFallback<T>(
  fn: (p: JsonRpcProvider) => Promise<T>,
): Promise<T> {
  let last: unknown;
  for (const url of SEPOLIA_RPCS) {
    try {
      return await fn(providerFor(url));
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error
    ? new Error(`all ${SEPOLIA_RPCS.length} Sepolia endpoints failed: ${last.message}`)
    : new Error('all Sepolia endpoints failed');
}

/**
 * Single endpoint for anything that signs.
 *
 * Writes deliberately do NOT use the fallback provider. A signer that reads its
 * nonce from whichever endpoint answered first can see two different views and
 * build two transactions with the same nonce, which is the exact failure the
 * chaos harness exists to measure. Reads are idempotent and want resilience;
 * writes want one consistent view.
 */
export function writeProvider(): JsonRpcProvider {
  return new JsonRpcProvider(SEPOLIA_RPCS[0], SEPOLIA_CHAIN_ID, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
}

/**
 * Signer for the position-owning wallet. This is the only place a raw key is
 * used: the keeper itself never touches one, since KeeperHub holds its key in
 * a Turnkey enclave. Testnet only.
 */
export function positionSigner(): Wallet {
  const key = process.env.SEPOLIA_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      'Set SEPOLIA_PRIVATE_KEY in .env (testnet key for the position wallet).',
    );
  }
  return new Wallet(key, writeProvider());
}

export function pool(runner: Wallet | JsonRpcProvider): PoolContract {
  return new Contract(AAVE.pool, POOL_ABI, runner) as unknown as PoolContract;
}

export function erc20(address: string, runner: Wallet | JsonRpcProvider): Erc20Contract {
  return new Contract(address, ERC20_ABI, runner) as unknown as Erc20Contract;
}

/** Aave reports base-currency amounts with 8 decimals. */
export const BASE_DECIMALS = 8;

export interface AccountData {
  totalCollateralUsd: number;
  totalDebtUsd: number;
  availableBorrowsUsd: number;
  liquidationThreshold: number;
  ltv: number;
  healthFactor: number;
}

export async function readAccount(
  user: string,
  p: JsonRpcProvider = provider(),
): Promise<AccountData> {
  const raw = await pool(p).getUserAccountData(user);
  const hfRaw = raw.healthFactor as bigint;
  return {
    totalCollateralUsd: Number(formatUnits(raw.totalCollateralBase, BASE_DECIMALS)),
    totalDebtUsd: Number(formatUnits(raw.totalDebtBase, BASE_DECIMALS)),
    availableBorrowsUsd: Number(formatUnits(raw.availableBorrowsBase, BASE_DECIMALS)),
    // Basis points on chain, fraction here.
    liquidationThreshold: Number(raw.currentLiquidationThreshold) / 10_000,
    ltv: Number(raw.ltv) / 10_000,
    // No debt means the pool returns uint256 max, which is genuinely infinite
    // health rather than a sentinel to clamp.
    healthFactor:
      hfRaw === 2n ** 256n - 1n ? Infinity : Number(formatUnits(hfRaw, 18)),
  };
}

export function printAccount(label: string, a: AccountData): void {
  const hf = a.healthFactor === Infinity ? '∞ (no debt)' : a.healthFactor.toFixed(4);
  console.log(
    `${label}\n` +
      `  collateral   $${a.totalCollateralUsd.toFixed(2)}\n` +
      `  debt         $${a.totalDebtUsd.toFixed(2)}\n` +
      `  liq. thresh. ${(a.liquidationThreshold * 100).toFixed(1)}%\n` +
      `  borrowable   $${a.availableBorrowsUsd.toFixed(2)}\n` +
      `  health       ${hf}`,
  );
}

/** Approve only when the existing allowance is short, to save a transaction. */
export async function ensureAllowance(
  token: string,
  amount: bigint,
  signer: Wallet,
): Promise<void> {
  const c = erc20(token, signer);
  const current = await c.allowance(signer.address, AAVE.pool);
  if (current >= amount) {
    console.log(`  allowance already sufficient (${current})`);
    return;
  }
  console.log(`  approving ${amount} ...`);
  const tx = await c.approve(AAVE.pool, amount);
  const receipt = await tx.wait();
  console.log(`  approved in ${receipt?.hash}`);
}

/**
 * Aave V3 reverts with bare numeric strings. Decoding the ones we actually hit
 * turns "execution reverted: 36" into something a human can act on.
 * Full list: https://github.com/aave/aave-v3-core/blob/master/contracts/protocol/libraries/helpers/Errors.sol
 */
export const AAVE_ERRORS: Record<string, string> = {
  '26': 'INVALID_AMOUNT',
  '27': 'NOT_ENOUGH_AVAILABLE_USER_BALANCE',
  '30': 'HEALTH_FACTOR_LOWER_THAN_LIQUIDATION_THRESHOLD',
  '31': 'COLLATERAL_BALANCE_IS_ZERO',
  '32': 'LTV_VALIDATION_FAILED',
  '34': 'SPECIFIED_CURRENCY_NOT_BORROWED_BY_USER',
  '35': 'NO_DEBT_OF_SELECTED_TYPE',
  '36': 'COLLATERAL_CANNOT_COVER_NEW_BORROW',
  '43': 'BORROW_CAP_EXCEEDED',
  '51': 'SUPPLY_CAP_EXCEEDED',
};

export function explainAaveError(err: unknown): string {
  const reason = (err as { reason?: string })?.reason;
  if (reason && AAVE_ERRORS[reason]) {
    return `Aave error ${reason}: ${AAVE_ERRORS[reason]}`;
  }
  return err instanceof Error ? err.message : String(err);
}


// --- Observation -----------------------------------------------------------

/**
 * Read everything a decision needs from chain in one place.
 *
 * Deliberately uses plain RPC rather than KeeperHub actions: observing is free
 * over RPC and costs a billable execution through KeeperHub, and at one poll
 * per interval that difference is the whole monthly quota. KeeperHub is for
 * writing, not for looking.
 */
export interface Observation {
  position: PositionSnapshot;
  balances: WalletBalances;
  gas: GasSnapshot;
}

const ORACLE_ABI = ['function getAssetPrice(address asset) view returns (uint256)'];

export async function priceUsd(
  asset: string,
  p: JsonRpcProvider = provider(),
): Promise<number> {
  const oracle = new Contract(AAVE.oracle, ORACLE_ABI, p);
  const raw = (await oracle.getAssetPrice!(asset)) as bigint;
  // Aave quotes its base currency with 8 decimals.
  return Number(formatUnits(raw, 8));
}

export async function observe(
  watchedWallet: string,
  keeperWallet: string,
): Promise<Observation> {
  // The whole observation runs against one endpoint so the numbers are a
  // consistent snapshot rather than a mix of two chain views.
  return withRpcFallback((p) => observeOn(p, watchedWallet, keeperWallet));
}

async function observeOn(
  p: JsonRpcProvider,
  watchedWallet: string,
  keeperWallet: string,
): Promise<Observation> {
  const account = await readAccount(watchedWallet, p);

  const [debtAsset, collateralAsset, debtAssetPriceUsd, collateralAssetPriceUsd, feeData] =
    await Promise.all([
      erc20(TOKENS.USDC.address, p).balanceOf(keeperWallet),
      erc20(TOKENS.LINK.address, p).balanceOf(keeperWallet),
      priceUsd(TOKENS.USDC.address, p),
      priceUsd(TOKENS.LINK.address, p),
      p.getFeeData(),
    ]);

  return {
    position: {
      wallet: watchedWallet,
      healthFactor: account.healthFactor,
      totalDebtUsd: account.totalDebtUsd,
      totalCollateralUsd: account.totalCollateralUsd,
      liquidationThreshold: account.liquidationThreshold,
      observedAt: Math.floor(Date.now() / 1000),
    },
    balances: {
      debtAsset,
      collateralAsset,
      debtAssetDecimals: TOKENS.USDC.decimals,
      collateralAssetDecimals: TOKENS.LINK.decimals,
      debtAssetPriceUsd,
      collateralAssetPriceUsd,
    },
    gas: {
      baseFeeGwei: Number(formatUnits(feeData.gasPrice ?? 1_000_000_000n, 'gwei')),
      // Gas is paid in the chain's native token, so price ETH, not collateral.
      ethPriceUsd: await priceUsd(TOKENS.WETH.address, p),
    },
  };
}
