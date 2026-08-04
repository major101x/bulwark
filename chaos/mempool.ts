/**
 * Mempool hygiene for the chaos baselines.
 *
 * The underpricing scenario deliberately leaves transactions sitting unmined.
 * That is the failure under measurement, but it has two consequences the
 * harness has to handle rather than suffer:
 *
 *   1. Every later transaction from the same wallet queues behind them by
 *      nonce, so the next scenario inherits a wedged wallet and its numbers
 *      mean nothing. One published cell was already ruined this way.
 *   2. ethers can block indefinitely on a wallet in that state, which is why
 *      the harness also needs a hard deadline above every trial.
 *
 * Clearing works by replacing each pending nonce with a zero-value self-send
 * priced high enough to actually mine.
 */

import { JsonRpcProvider, Wallet, formatUnits, parseUnits } from 'ethers';

export interface StuckReport {
  address: string;
  confirmedNonce: number;
  pendingNonce: number;
  stuck: number;
  cleared: number;
  failed: number;
}

/** How far above market to price replacements. The originals were underpriced. */
const REPLACEMENT_MULTIPLIER = 5n;

export async function inspect(
  provider: JsonRpcProvider,
  address: string,
): Promise<{ confirmedNonce: number; pendingNonce: number; stuck: number }> {
  const [confirmedNonce, pendingNonce] = await Promise.all([
    provider.getTransactionCount(address, 'latest'),
    provider.getTransactionCount(address, 'pending'),
  ]);
  return { confirmedNonce, pendingNonce, stuck: pendingNonce - confirmedNonce };
}

/**
 * Replace every pending-but-unmined transaction so the wallet is usable again.
 * Safe to call when nothing is stuck: it returns immediately.
 */
export async function clearStuckNonces(
  rpcUrl: string,
  privateKey: string,
  log: (line: string) => void = () => {},
): Promise<StuckReport> {
  const provider = new JsonRpcProvider(rpcUrl);
  try {
    const wallet = new Wallet(privateKey, provider);
    const { confirmedNonce, pendingNonce, stuck } = await inspect(
      provider,
      wallet.address,
    );

    const report: StuckReport = {
      address: wallet.address,
      confirmedNonce,
      pendingNonce,
      stuck,
      cleared: 0,
      failed: 0,
    };
    if (stuck <= 0) return report;

    const market = (await provider.getFeeData()).gasPrice ?? parseUnits('1', 'gwei');
    const price = market * REPLACEMENT_MULTIPLIER;
    log(`  clearing ${stuck} stuck tx at ${formatUnits(price, 'gwei')} gwei`);

    for (let nonce = confirmedNonce; nonce < pendingNonce; nonce++) {
      try {
        const tx = await wallet.sendTransaction({
          to: wallet.address,
          value: 0n,
          nonce,
          gasPrice: price,
        });
        await tx.wait();
        report.cleared++;
        log(`  nonce ${nonce} cleared`);
      } catch (err) {
        report.failed++;
        log(
          `  nonce ${nonce} could not be cleared: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
    return report;
  } finally {
    // Without this the harness process keeps a live socket and never exits.
    provider.destroy();
  }
}
