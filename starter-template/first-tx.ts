/**
 * Zero to your first KeeperHub-executed transaction.
 *
 * This is the onboarding-bounty deliverable. The goal is that a
 * stranger with no web3 background can run one command and see a transaction
 * land, with every prerequisite checked and every failure explained in terms of
 * what to do next rather than what went wrong internally.
 *
 * Deliberately dependency-light and single-file so it can be read top to bottom.
 *
 * STATUS: preflight checks are real and runnable today. The execution step is
 * stubbed pending a rewrite against the verified shapes in agent/keeperhub-types.ts.
 */

import 'dotenv/config';

const CHECKS: Array<{ label: string; hint: string; check: () => boolean }> = [
  {
    label: 'KEEPERHUB_API_KEY is set',
    hint:
      'Sign up at https://app.keeperhub.com, then profile → API keys.\n' +
      '      Copy .env.example to .env and paste the key in.',
    check: () => Boolean(process.env.KEEPERHUB_API_KEY),
  },
  {
    label: 'A recipient address is set',
    hint:
      'Set WATCHED_WALLET in .env to any address you control.\n' +
      '      This first transaction just sends a trivial amount to yourself.',
    check: () => /^0x[a-fA-F0-9]{40}$/.test(process.env.WATCHED_WALLET ?? ''),
  },
];

/**
 * Faucets, in the order you need them. Ordering matters more than it looks:
 * people commonly claim Aave test tokens before they have any Sepolia ETH, then
 * cannot submit the transaction that claims them.
 */
const FAUCETS = [
  ['Sepolia ETH (for gas, do this first)', 'https://www.alchemy.com/faucets/ethereum-sepolia'],
  ['Aave test tokens (collateral and debt assets)', 'https://gho.aave.com/faucet/'],
  ['Base Sepolia USDC (only needed for the x402 work)', 'https://faucet.circle.com/'],
] as const;

function preflight(): boolean {
  console.log('\nPreflight\n');
  let ok = true;
  for (const { label, hint, check } of CHECKS) {
    const passed = check();
    console.log(`  ${passed ? '✅' : '❌'} ${label}`);
    if (!passed) {
      console.log(`      ${hint}\n`);
      ok = false;
    }
  }
  return ok;
}

function printFaucets(): void {
  console.log('\nFree testnet funds, in this order:\n');
  for (const [what, url] of FAUCETS) {
    console.log(`  • ${what}\n    ${url}`);
  }
  console.log(
    '\nFund BOTH your own wallet and your KeeperHub wallet address\n' +
      '(app.keeperhub.com → profile → Wallet) with Sepolia ETH.\n' +
      'Missing the second one is the most common first-run failure.\n',
  );
}

async function main(): Promise<void> {
  console.log('KeeperHub: first transaction');

  if (!preflight()) {
    printFaucets();
    console.log('Fix the items above, then run `npm run first-tx` again.\n');
    process.exit(1);
  }

  console.log('\n  ⛔ Execution step not implemented yet.');
  console.log('     Preflight above is live and correct.\n');
  process.exit(1);
}

await main();
