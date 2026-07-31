/**
 * Read-only position and wallet report. Safe to run at any time, and the first
 * thing to check when something looks wrong.
 *
 *   npm run pos:status
 */

import { formatUnits } from 'ethers';

import { TOKENS, erc20, printAccount, provider, readAccount } from './lib.ts';
import { classify } from '../agent/risk.ts';

const POSITION_WALLET =
  process.env.WATCHED_WALLET ?? '0x5Fd5a59693CFC88CC65692751bE547a3fc66992b';
const KEEPER_WALLET =
  process.env.KEEPERHUB_WALLET ?? '0x2Ac0C346502571c8Ef320e2768702589800b14F8';

async function balances(label: string, address: string): Promise<void> {
  const p = provider();
  const eth = await p.getBalance(address);
  const parts: string[] = [`ETH ${Number(formatUnits(eth, 18)).toFixed(4)}`];
  for (const [name, token] of Object.entries(TOKENS)) {
    const bal = await erc20(token.address, p).balanceOf(address);
    if (bal > 0n) {
      parts.push(`${name} ${Number(formatUnits(bal, token.decimals)).toFixed(4)}`);
    }
  }
  console.log(`${label} ${address}\n  ${parts.join('  ')}`);
}

const account = await readAccount(POSITION_WALLET);
printAccount(`\nAave position (${POSITION_WALLET})`, account);
console.log(`  tier         ${classify(account.healthFactor)}`);

console.log('');
await balances('Position wallet', POSITION_WALLET);
await balances('Keeper wallet  ', KEEPER_WALLET);
console.log('');
