// Hot-wallet balance reader for the balance-drop auto-pause and doctor. Reads the quote-token (USDC) balance through
// the live executors, which load their optional packages only when this is first called.
import { getLogger } from './log.js';

const log = getLogger('wallet');

/**
 * @typedef {{label: string, balanceUsd: () => Promise<number|null>}} WalletReader
 * balanceUsd resolves to the summed USDC balance, or null when no part could be read. Any failed read rejects:
 * a partial sum would look like a balance drop.
 */

/**
 * The reader for the wallets configured in .env, or null when real funds cannot move (DRY_RUN=true) or no wallet
 * key is set.
 * @param {any} cfg
 * @param {{solana?: any, evm?: any}} executors lazy live executors (see index.js buildExecutors)
 * @returns {WalletReader|null}
 */
export function hotWallet(cfg, executors) {
  if (cfg.dryRun) return null;
  const parts = [];
  if (cfg.live.solanaPrivateKey) parts.push(['Solana', () => executors.solana.walletBalanceUsd()]);
  if (cfg.live.evmPrivateKey) parts.push(['EVM', () => executors.evm.walletBalanceUsd()]);
  if (!parts.length) return null;
  return {
    label: `${parts.map(([n]) => n).join(' + ')} USDC`,
    async balanceUsd() {
      let total = null;
      for (const [name, read] of parts) {
        const v = await read();
        if (v === null || v === undefined) continue;
        if (!Number.isFinite(v) || v < 0) throw new Error(`${name} wallet: unexpected balance ${v}`);
        total = (total ?? 0) + v;
      }
      log.debug(`hot-wallet balance ${total === null ? 'unknown' : `$${total.toFixed(2)}`}`);
      return total;
    },
  };
}
