/**
 * Mint Aave V3 Sepolia test tokens without a faucet website.
 *
 *   npm run mint            # 10 LINK
 *   npm run mint -- USDC    # 10 USDC
 *   npm run mint -- DAI 500
 *
 * Why this exists: the hosted Aave faucets are unreliable. On 2026-07-31 the
 * gho.aave.com faucet page did not work and app.aave.com's bridge defaulted to
 * Base, which left no working route to Sepolia test tokens at all. That is a
 * hard stop for anyone whose next tutorial step assumes they have some.
 *
 * The faucet is just a contract, and a contract call is a thing KeeperHub does.
 * So this calls it directly, with sponsored gas and no private key. It works
 * whether or not the websites are up.
 *
 * Run `first-tx.ts` before this one. It is the simpler introduction and this
 * reuses everything it teaches.
 */

import 'dotenv/config';

const API_URL = process.env.KEEPERHUB_API_URL ?? 'https://app.keeperhub.com';
const API_KEY = process.env.KEEPERHUB_API_KEY ?? '';
const CHAIN_ID = '11155111';

/** Aave's Sepolia faucet. Anyone may mint; the tokens are worthless by design. */
const FAUCET = '0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D';

/**
 * The faucet mints any token it owns, so the address has to be supplied. These
 * are Aave V3's Sepolia test assets.
 */
const TOKENS: Record<string, { address: string; decimals: number }> = {
  LINK: { address: '0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5', decimals: 18 },
  USDC: { address: '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8', decimals: 6 },
  DAI: { address: '0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357', decimals: 18 },
  WETH: { address: '0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c', decimals: 18 },
};

const FAUCET_ABI = [
  {
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'mint',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];

interface Integration {
  type: string;
  address?: string;
}

interface CallResponse {
  executionId?: string;
  status?: string;
  success?: boolean;
  wouldRevert?: boolean;
  gasEstimate?: string;
  idempotentReplay?: boolean;
}

async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const { method = 'GET', body, idempotencyKey } = options;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${API_KEY}`,
      // Header, not a body field. See first-tx.ts.
      ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} on ${path}: ${text}`);
  return JSON.parse(text) as T;
}

/**
 * Token amounts are integers in the token's smallest unit. USDC has 6 decimals,
 * so 10 USDC is 10000000. Getting this wrong by a factor of a trillion is the
 * single most common beginner error, so do the conversion in one place.
 */
function toBaseUnits(human: string, decimals: number): string {
  const [whole = '0', fraction = ''] = human.split('.');
  const padded = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || '0')).toString();
}

async function main(): Promise<void> {
  const symbol = (process.argv[2] ?? 'LINK').toUpperCase();
  const human = process.argv[3] ?? '10';

  const token = TOKENS[symbol];
  if (!token) {
    console.error(
      `\nUnknown token "${symbol}".\n  Available: ${Object.keys(TOKENS).join(', ')}\n`,
    );
    process.exit(1);
  }

  if (!API_KEY) {
    console.error('\nKEEPERHUB_API_KEY is not set. See README.md.\n');
    process.exit(1);
  }

  const integrations = await api<Integration[]>('/api/integrations');
  const wallet = integrations.find((i) => i.type === 'web3' && i.address)?.address;
  if (!wallet) {
    console.error(
      '\nNo wallet is connected.\n' +
        '  Create one at https://app.keeperhub.com -> Integrations.\n',
    );
    process.exit(1);
  }

  const amount = toBaseUnits(human, token.decimals);
  console.log(`\nMinting ${human} ${symbol} to ${wallet}`);
  console.log(`  ${amount} base units (${token.decimals} decimals)\n`);

  const body = {
    contractAddress: FAUCET,
    chainId: CHAIN_ID,
    functionName: 'mint',
    // Both of these are JSON *strings*, not JSON values. Passing them as
    // arrays or objects fails in a way that does not name the cause.
    functionArgs: JSON.stringify([token.address, wallet, amount]),
    abi: JSON.stringify(FAUCET_ABI),
  };

  const sim = await api<CallResponse>('/api/execute/contract-call', {
    method: 'POST',
    body: { ...body, simulate: true },
  });
  if (sim.success === false || sim.wouldRevert) {
    console.error('  Simulation says this would revert, so nothing was sent.');
    console.error(`  ${JSON.stringify(sim)}\n`);
    console.error('  The faucet caps how much you can mint at once. Try less.\n');
    process.exit(1);
  }
  console.log(`  simulated OK, estimated gas ${sim.gasEstimate ?? 'unknown'}`);

  const run = await api<CallResponse>('/api/execute/contract-call', {
    method: 'POST',
    body,
    idempotencyKey: `mint:${CHAIN_ID}:${wallet}:${symbol}:${amount}`,
  });

  console.log(`\n  status    ${run.status ?? 'unknown'}`);
  console.log(`  execution ${run.executionId ?? 'unknown'}`);
  if (run.idempotentReplay) {
    console.log('\n  Already minted this exact amount, so nothing new was sent.');
    console.log('  Ask for a different amount to mint again.');
  }

  // contract-call does not return a transaction hash: there is no REST route
  // for direct-execution detail. Check the balance rather than pretending.
  console.log(
    `\n  Confirm at https://sepolia.etherscan.io/token/${token.address}?a=${wallet}\n`,
  );
}

try {
  await main();
} catch (err) {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
