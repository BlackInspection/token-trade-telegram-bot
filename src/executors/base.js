// Executor interface. All executors return a Fill; bookkeeping happens in Portfolio.
import { paperBuyFill, paperSellFill } from '../portfolio.js';

/**
 * @typedef {{address: string, chain: string, symbol: string}} TokenRef
 * @typedef {{side: 'BUY'|'SELL', price: number, qty: number, usd: number, feeUsd: number,
 *            venue: string, txId: string|null, dry: boolean, note?: string}} Fill
 */

export class ExecutionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExecutionError';
  }
}

/**
 * Mark an error thrown after the swap transaction was broadcast (or may have been): the swap may have landed, so the
 * engine keeps the spend reserved against the limits instead of forgetting it.
 */
export function markSent(err, txId = null) {
  const e = err instanceof Error ? err : new ExecutionError(String(err));
  e.txSent = true;
  if (txId) e.txId = txId;
  return e;
}

/** Decimal token quantity -> raw integer units (rounded to the token's decimals). Pure. */
export function toRawUnits(qty, decimals) {
  if (!(qty > 0)) return 0n;
  if (qty >= 1e21) return BigInt(Math.floor(qty)) * 10n ** BigInt(decimals);
  const [whole, frac = ''] = qty.toFixed(Math.min(decimals, 100)).split('.');
  return BigInt(whole + frac.padEnd(decimals, '0').slice(0, decimals));
}

/**
 * Raw amount for a live sell: `qty` (the position's share being sold) capped at the wallet balance. Tokens the
 * wallet held before the bot bought, or bought outside the bot, are never sold. Pure.
 * @returns {{amount: bigint, all: boolean}} all = the wallet held no more than qty (everything left was sold)
 */
export function sellAmountRaw({ balanceRaw, qty, decimals }) {
  const want = toRawUnits(qty, decimals);
  if (balanceRaw <= want) return { amount: balanceRaw, all: true };
  return { amount: want, all: false };
}

/** Slippage for a quote: the request's (the engine's current setting) or the executor's .env value. */
export const slippageOf = (req, trading) => req?.slippageBps ?? trading.slippageBps;

export class Executor {
  name = 'base';

  /** @param {{token: TokenRef, usd: number, price: number, costs?: any, slippageBps?: number}} _req @returns {Promise<Fill>} */
  async buy(_req) {
    throw new ExecutionError(`${this.name}: buy not implemented`);
  }

  /**
   * @param {{token: TokenRef, qty: number, pct: number, price: number, slippageBps?: number}} _req qty = tokens to sell
   *   (pct % of the position); live executors sell at most qty, capped at the wallet balance @returns {Promise<Fill>}
   */
  async sell(_req) {
    throw new ExecutionError(`${this.name}: sell not implemented`);
  }
}

/**
 * Simulated fill used by paper trading and by live executors in DRY_RUN.
 * @param {{impactPct?: number|null, buyTaxPct?: number, sellTaxPct?: number}|null} [costs] realistic fills: when
 *   present the pool's price impact replaces SLIPPAGE_BPS and token taxes are applied.
 */
export function simulatedFill(side, { usd, qty, price, costs = null }, { slippageBps, feeBps }, venue, dry, note = '') {
  const extra = costs ? { impactPct: costs.impactPct ?? null, buyTaxPct: costs.buyTaxPct ?? 0, sellTaxPct: costs.sellTaxPct ?? 0 } : {};
  const f = side === 'BUY' ? paperBuyFill({ usd, price, slippageBps, feeBps, ...extra }) : paperSellFill({ qty, price, slippageBps, feeBps, ...extra });
  return { ...f, venue, txId: null, dry, note };
}
