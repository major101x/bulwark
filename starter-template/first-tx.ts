/**
 * Zero to your first KeeperHub-executed transaction.
 *
 *   npm install && npm run first-tx
 *
 * The only thing you need is an API key. No testnet ETH, no faucet, no wallet
 * extension, no seed phrase. KeeperHub sponsors the gas and holds the key in an
 * enclave, so a brand-new account can land a real transaction on a public
 * blockchain in about a minute.
 *
 * What it does, in order:
 *
 *   1. Checks your API key is set.
 *   2. Asks the API which wallet you have, so you do not have to look it up.
 *   3. SIMULATES the transaction and shows you the result.
 *   4. Executes it for real, and prints the block explorer link.
 *
 * Steps 3 and 4 are the two habits worth forming. Simulating first tells you
 * whether a call would revert before you spend anything on finding out, and the
 * idempotency key means a retry after a timeout cannot execute twice.
 *
 * Deliberately single-file and dependency-light (just dotenv) so you can read it
 * top to bottom in one sitting.
 */

import 'dotenv/config';

const API_URL = process.env.KEEPERHUB_API_URL ?? 'https://app.keeperhub.com';
const API_KEY = process.env.KEEPERHUB_API_KEY ?? '';

/** Sepolia. Ethereum's public test network: real chain, worthless coins. */
const CHAIN_ID = process.env.CHAIN_ID ?? '11155111';

/**
 * Zero by default, which is the point: a zero-value transfer needs no funds at
 * all, and KeeperHub pays the gas. Verified by watching the wallet balance
 * across a completed transfer, which moved by exactly 0 wei.
 */
const AMOUNT = process.env.AMOUNT ?? '0';

interface Integration {
  id: string;
  type: string;
  address?: string;
}

interface SimulateResponse {
  success: boolean;
  status: string;
  gasEstimate?: string;
  wouldRevert?: boolean;
}

interface ExecuteResponse {
  executionId: string;
  status: string;
  transactionHash?: string;
  transactionLink?: string;
  /** Present when this key was already used: nothing new was executed. */
  idempotentReplay?: boolean;
}

/**
 * One place where every HTTP detail lives, because the details are not
 * guessable and getting one wrong produces a confusing error rather than an
 * obvious one. All of these were verified against the live API, not read off a
 * docs page.
 */
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
      // The idempotency key is a HEADER. Putting it in the JSON body looks
      // right, matches the MCP tool's parameter name, and is silently ignored:
      // your call executes a second time and you get a second transaction.
      ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, path, text);
  return JSON.parse(text) as T;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`${status} on ${path}: ${body}`);
  }

  /** Say what to do about it, not what went wrong internally. */
  get advice(): string {
    if (this.status === 401 || this.status === 403) {
      return (
        'Your API key was rejected.\n' +
        '  Get a fresh one at https://app.keeperhub.com -> profile -> API keys,\n' +
        '  and check you copied the whole thing (they start with "kh_").'
      );
    }
    if (this.status === 402) {
      return (
        'Out of execution quota.\n' +
        '  The free tier covers 5,000 executions a month. Check\n' +
        '  https://app.keeperhub.com/billing.'
      );
    }
    if (this.status === 400) {
      return (
        'The API rejected the request body.\n' +
        `  It said: ${this.body}\n` +
        '  If you edited this script, check the field names against the\n' +
        '  comments above: several differ from what you would guess.'
      );
    }
    if (this.status >= 500) {
      return 'KeeperHub returned a server error. Wait a moment and run it again.';
    }
    return `Unexpected response.\n  ${this.body}`;
  }
}

/** Ask the API which wallet you have, rather than making you find it. */
async function findWallet(): Promise<string> {
  const integrations = await api<Integration[]>('/api/integrations');
  const wallet = integrations.find((i) => i.type === 'web3' && i.address);
  if (!wallet?.address) {
    throw new Error(
      'No wallet is connected to your KeeperHub account.\n' +
        '  Open https://app.keeperhub.com -> Integrations and create one.\n' +
        '  KeeperHub can generate and hold it for you; you do not need\n' +
        '  MetaMask or a seed phrase for this.',
    );
  }
  return wallet.address;
}

async function main(): Promise<void> {
  console.log('\nKeeperHub: your first transaction\n');

  if (!API_KEY) {
    console.error(
      'KEEPERHUB_API_KEY is not set.\n\n' +
        '  1. Sign up at https://app.keeperhub.com\n' +
        '  2. Profile -> API keys -> create one\n' +
        '  3. cp .env.example .env, and paste it in\n',
    );
    process.exit(1);
  }

  const wallet = await findWallet();
  console.log(`  wallet    ${wallet}`);
  console.log(`  chain     ${CHAIN_ID} (Sepolia testnet)`);
  console.log(`  sending   ${AMOUNT} ETH to yourself\n`);

  // --- 1. Simulate ---------------------------------------------------------
  // Free, instant, and changes nothing. There is no reason to skip it.
  const sim = await api<SimulateResponse>('/api/execute/transfer', {
    method: 'POST',
    body: {
      chainId: CHAIN_ID,
      // Not `toAddress`. The MCP tool calls this `to_address`, but the REST
      // API wants `recipientAddress` and 400s on anything else.
      recipientAddress: wallet,
      amount: AMOUNT,
      simulate: true,
    },
  });

  if (!sim.success || sim.wouldRevert) {
    console.error('  Simulation says this would fail, so nothing was sent.');
    console.error(`  ${JSON.stringify(sim)}\n`);
    process.exit(1);
  }
  console.log(`  simulated OK, estimated gas ${sim.gasEstimate ?? 'unknown'}`);

  // --- 2. Execute ----------------------------------------------------------
  // The key is derived from the transaction itself, so running this script
  // twice replays the first result instead of sending a second transaction.
  // That is the behaviour you want everywhere: a retry after a network blip
  // must not spend twice.
  const idempotencyKey =
    process.env.FIRST_TX_KEY ?? `first-tx:${CHAIN_ID}:${wallet}:${AMOUNT}`;

  const run = await api<ExecuteResponse>('/api/execute/transfer', {
    method: 'POST',
    body: { chainId: CHAIN_ID, recipientAddress: wallet, amount: AMOUNT },
    idempotencyKey,
  });

  if (run.idempotentReplay) {
    console.log('\n  This exact transaction was already sent, so nothing new happened.');
    console.log('  That is the idempotency key doing its job.');
    console.log('  To send a genuinely new one, change AMOUNT or set FIRST_TX_KEY.\n');
  } else {
    console.log('\n  Executed.\n');
  }

  console.log(`  status    ${run.status}`);
  console.log(`  execution ${run.executionId}`);
  if (run.transactionHash) console.log(`  tx        ${run.transactionHash}`);
  if (run.transactionLink) console.log(`\n  ${run.transactionLink}\n`);

  console.log('That transaction is real and permanent. You paid nothing for it,');
  console.log('and no private key ever touched this machine.\n');
}

try {
  await main();
} catch (err) {
  console.error('');
  if (err instanceof ApiError) {
    console.error(err.advice);
  } else if (err instanceof Error) {
    console.error(err.message);
  } else {
    console.error(String(err));
  }
  console.error('');
  process.exit(1);
}
