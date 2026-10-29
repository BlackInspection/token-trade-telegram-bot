// Portfolio bookkeeping on top of Storage. Paper mode also tracks cash; live mode tracks
// positions/PnL from executor fills (wallet balances are the source of truth on-chain).

/**
 * Simulated buy fill: pay `usd` (fee included). Price is worsened by SLIPPAGE_BPS, or - when `impactPct` is given
 * (realistic fills, from the pool's round-trip math) - by that price impact instead. A token buy tax shrinks the
 * tokens received.
 */
export function paperBuyFill({ usd, price, slippageBps = 0, feeBps = 0, impactPct = null, buyTaxPct = 0 }) {
  const realistic = impactPct !== null && impactPct !== undefined;
  const fillPrice = realistic ? price * (1 + impactPct / 100) : price * (1 + slippageBps / 10_000);
  const feeUsd = (usd * feeBps) / 10_000;
  const afterFee = usd - feeUsd;
  const taxUsd = afterFee * ((buyTaxPct ?? 0) / 100);
  const qty = (afterFee - taxUsd) / fillPrice;
  const impactUsd = afterFee - taxUsd - qty * price;
  return { side: 'BUY', price: fillPrice, qty, usd, feeUsd, taxUsd, impactUsd };
}

/**
 * Simulated sell fill: receive qty * price minus slippage (or `impactPct`), the token sell tax and the fee.
 */
export function paperSellFill({ qty, price, slippageBps = 0, feeBps = 0, impactPct = null, sellTaxPct = 0 }) {
  const realistic = impactPct !== null && impactPct !== undefined;
  const fillPrice = realistic ? price * (1 - impactPct / 100) : price * (1 - slippageBps / 10_000);
  const gross = qty * fillPrice;
  const taxUsd = gross * ((sellTaxPct ?? 0) / 100);
  const afterTax = gross - taxUsd;
  const feeUsd = (afterTax * feeBps) / 10_000;
  return { side: 'SELL', price: fillPrice, qty, usd: afterTax - feeUsd, feeUsd, taxUsd, impactUsd: qty * price - gross, grossUsd: gross };
}

const DAY_MS = 86_400_000;
export const startOfUtcDay = (ts = Date.now()) => Math.floor(ts / DAY_MS) * DAY_MS;

export class InsufficientCashError extends Error {}

export class Portfolio {
  /** @param {import('./storage.js').Storage} storage */
  constructor(storage, { startEquity = 1000, now = () => Date.now() } = {}) {
    this.storage = storage;
    this.startEquity = startEquity;
    this.now = now;
  }

  cash() {
    return this.storage.getKv('paper_cash', this.startEquity);
  }

  setCash(v) {
    this.storage.setKv('paper_cash', v);
  }

  /** Paper equity = cash + marked-to-market open paper positions. @param {Map<string, number>} prices lowercased address -> price */
  equity(prices = new Map()) {
    let eq = this.cash();
    for (const p of this.storage.listOpenPositions('paper')) {
      const px = prices.get(p.address.toLowerCase()) ?? p.entryPrice;
      eq += p.qty * px;
    }
    return eq;
  }

  /**
   * Record a buy fill; opens a position or adds to the existing one.
   * @param {{mode: string, dry?: boolean, token: {address: string, chain: string, symbol: string},
   *          fill: {price: number, qty: number, usd: number, feeUsd: number, venue?: string, txId?: string},
   *          levels?: {stopLoss: number, takeProfit: number|null}|null, reason?: string}} a
   */
  recordBuy({ mode, dry = false, token, fill, levels = null, reason = '' }) {
    if (mode === 'paper') {
      const cash = this.cash();
      if (fill.usd > cash + 1e-9) throw new InsufficientCashError(`not enough paper cash: $${cash.toFixed(2)} < $${fill.usd.toFixed(2)}`);
      this.setCash(cash - fill.usd);
    }
    let pos = this.storage.getOpenPosition(token.address, mode);
    if (pos) {
      const qty = pos.qty + fill.qty;
      const costUsd = pos.costUsd + fill.usd;
      this.storage.updatePosition(pos.id, { qty, costUsd, entryPrice: costUsd / qty });
      pos = this.storage.getPosition(pos.id);
    } else {
      pos = this.storage.insertPosition({
        mode, dry, address: token.address, chain: token.chain, symbol: token.symbol,
        qty: fill.qty, entryPrice: fill.price, costUsd: fill.usd,
        stopLoss: levels?.stopLoss ?? null, takeProfit: levels?.takeProfit ?? null, trailHigh: fill.price,
        openedAt: this.now(),
      });
    }
    this.storage.insertTrade({
      ts: this.now(), mode, dry, positionId: pos.id, address: token.address, chain: token.chain, symbol: token.symbol,
      side: 'BUY', qty: fill.qty, price: fill.price, usd: fill.usd, feeUsd: fill.feeUsd, venue: fill.venue, txId: fill.txId, reason,
      taxUsd: fill.taxUsd ?? 0, impactUsd: fill.impactUsd ?? 0,
    });
    return pos;
  }

  /**
   * Record a sell fill against a position (partial or full).
   * @returns {{pnlUsd: number, closed: boolean, position: any}}
   */
  recordSell({ position, fill, reason = '', dry = false }) {
    const fraction = Math.min(1, fill.qty / position.qty);
    const costPart = position.costUsd * fraction;
    const pnlUsd = fill.usd - costPart;
    const qtyLeft = position.qty - fill.qty;
    const closed = fraction >= 0.9999 || qtyLeft <= position.qty * 1e-6;
    if (position.mode === 'paper') this.setCash(this.cash() + fill.usd);
    const realized = (position.realizedPnlUsd ?? 0) + pnlUsd;
    if (closed) {
      this.storage.updatePosition(position.id, {
        qty: 0, costUsd: 0, status: 'closed', closedAt: this.now(), exitPrice: fill.price, realizedPnlUsd: realized, closeReason: reason,
      });
    } else {
      this.storage.updatePosition(position.id, { qty: qtyLeft, costUsd: position.costUsd - costPart, realizedPnlUsd: realized });
    }
    this.storage.insertTrade({
      ts: this.now(), mode: position.mode, dry: dry || position.dry, positionId: position.id, address: position.address,
      chain: position.chain, symbol: position.symbol, side: 'SELL', qty: fill.qty, price: fill.price, usd: fill.usd,
      feeUsd: fill.feeUsd, pnlUsd, venue: fill.venue, txId: fill.txId, reason, taxUsd: fill.taxUsd ?? 0, impactUsd: fill.impactUsd ?? 0,
    });
    return { pnlUsd, closed, position: this.storage.getPosition(position.id) };
  }

  todayPnl(mode) {
    return this.storage.realizedPnlSince(mode, startOfUtcDay(this.now()));
  }

  stats(mode) {
    const s = this.storage.closedPositionStats(mode);
    return {
      closed: s.n,
      wins: s.wins ?? 0,
      winRate: s.n ? ((s.wins ?? 0) / s.n) * 100 : null,
      realizedPnl: this.storage.realizedPnlSince(mode, 0),
      todayPnl: this.todayPnl(mode),
    };
  }
}
