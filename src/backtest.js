// Backtester: runs a Strategy over historical candles with the same SL/TP/trailing and fee/slippage
// rules as paper trading. Entries/exits on signals fill at the candle close; SL/TP fill intrabar.
import { checkExit, computeLevels, positionSizeUsd } from './risk.js';
import { paperBuyFill, paperSellFill } from './portfolio.js';
import { cpImpact, costGate, estimateRoundTrip } from './costs.js';
import { fmtPct, fmtPrice, fmtUsd } from './format.js';

/** Max drawdown of an equity series. @returns {{pct: number, usd: number}} */
export function maxDrawdown(values) {
  let peak = -Infinity;
  let pct = 0;
  let usd = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = peak - v;
      if (dd / peak > pct) {
        pct = dd / peak;
        usd = dd;
      }
    }
  }
  return { pct: pct * 100, usd };
}

export function computeStats(trades, curve, startEquity, candles = []) {
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = losses.reduce((s, t) => s + t.pnlUsd, 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const finalEquity = curve.length ? curve[curve.length - 1].equity : startEquity;
  const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);
  const first = candles[0]?.c;
  const last = candles[candles.length - 1]?.c;
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : null,
    totalPnlUsd: totalPnl,
    totalPnlPct: (totalPnl / startEquity) * 100,
    avgWinPct: avg(wins.map((t) => t.pnlPct)),
    avgLossPct: avg(losses.map((t) => t.pnlPct)),
    profitFactor: grossLoss < 0 ? grossWin / -grossLoss : wins.length ? Infinity : null,
    maxDrawdownPct: maxDrawdown(curve.map((x) => x.equity)).pct,
    finalEquity,
    buyHoldPct: first && last ? ((last - first) / first) * 100 : null,
  };
}

/**
 * @param {import('./data/geckoterminal.js').Candle[]} candles oldest-first
 * @param {{strategy: import('./strategy.js').Strategy, analysis: any, trading: any, risk?: any,
 *   costs?: {liquidityUsd: number, buyTaxPct?: number, sellTaxPct?: number, dexFeeBps?: number, networkFeeUsd?: number,
 *     costGateMult?: number}|null}} opts
 *   costs: realistic fills - constant-product impact from the CURRENT liquidity on every fill plus token taxes
 *   (current liquidity only approximates the past). Without it (or with --fixed-slippage) SLIPPAGE_BPS is used.
 */
export function runBacktest(candles, { strategy, analysis: p, trading: t, risk = null, costs = null }) {
  let cash = t.startEquity;
  let pos = null;
  const trades = [];
  const curve = [];
  const fees = { slippageBps: t.slippageBps, feeBps: t.feeBps };
  let gateSkips = 0;
  const legCosts = (usd, side) => (costs
    ? {
      impactPct: cpImpact(usd, costs.liquidityUsd) * 100,
      ...(side === 'BUY' ? { buyTaxPct: costs.buyTaxPct ?? 0 } : { sellTaxPct: costs.sellTaxPct ?? 0 }),
    }
    : {});

  const close = (exitPrice, reason, ts) => {
    const f = paperSellFill({ qty: pos.qty, price: exitPrice, ...fees, ...legCosts(pos.qty * exitPrice, 'SELL') });
    cash += f.usd;
    const pnlUsd = f.usd - pos.costUsd;
    trades.push({
      entryT: pos.entryT, exitT: ts, entryPrice: pos.entryPrice, exitPrice: f.price, qty: pos.qty,
      costUsd: pos.costUsd, proceedsUsd: f.usd, pnlUsd, pnlPct: (pnlUsd / pos.costUsd) * 100,
      entryReason: pos.reason, exitReason: reason,
    });
    pos = null;
  };

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (pos) {
      const exit = checkExit(pos, { price: c.c, high: c.h, low: c.l }, t.trailingPct);
      if (exit) close(exit.price, exit.reason, c.t);
      else pos.trailHigh = Math.max(pos.trailHigh, c.h);
    }
    const sig = strategy.onCandle(c, { position: pos, risk });
    if (pos && sig.action === 'SELL') {
      close(c.c, `signal: ${sig.reason}`, c.t);
    } else if (!pos && sig.action === 'BUY' && i < candles.length - 1) {
      const size = positionSizeUsd({ equity: cash, cash, sizeUsd: t.sizeUsd, sizePct: t.sizePct, maxTradeUsd: t.maxTradeUsd });
      if (size >= 1) {
        const f = paperBuyFill({ usd: size, price: c.c, ...fees, ...legCosts(size, 'BUY') });
        const lv = computeLevels(f.price, sig.atr ?? null, p);
        if (costs) {
          const rt = estimateRoundTrip({ sizeUsd: size, liquidityUsd: costs.liquidityUsd, buyTaxPct: costs.buyTaxPct, sellTaxPct: costs.sellTaxPct, dexFeeBps: costs.dexFeeBps ?? 30, networkFeeUsd: costs.networkFeeUsd ?? 0 });
          if (!costGate({ tpPct: lv.tpPct, lossPct: rt.lossPct, mult: costs.costGateMult ?? 3 }).ok) gateSkips += 1;
        }
        pos = {
          entryT: c.t, entryPrice: f.price, qty: f.qty, costUsd: size, reason: sig.reason,
          stopLoss: lv.stopLoss, takeProfit: lv.takeProfit, trailHigh: f.price,
        };
        cash -= size;
      }
    }
    curve.push({ t: c.t, equity: cash + (pos ? pos.qty * c.c : 0) });
  }
  if (pos) {
    const lastC = candles[candles.length - 1];
    close(lastC.c, 'END (open at end of data)', lastC.t);
    curve[curve.length - 1] = { t: lastC.t, equity: cash };
  }
  return { trades, curve, stats: computeStats(trades, curve, t.startEquity, candles), gateSkips, realistic: !!costs };
}

const ts = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

export function formatBacktest(res, { symbol = '?', timeframe = '?', candles = [], maxRows = 30 } = {}) {
  const s = res.stats;
  const L = [];
  if (candles.length) L.push(`Backtest ${symbol} ${timeframe}: ${candles.length} candles, ${ts(candles[0].t)} -> ${ts(candles[candles.length - 1].t)} UTC`);
  const rows = res.trades.slice(-maxRows);
  if (res.trades.length > rows.length) L.push(`(showing last ${rows.length} of ${res.trades.length} trades)`);
  for (const t of rows) {
    L.push(
      `${ts(t.entryT)} -> ${ts(t.exitT)}  ${fmtPrice(t.entryPrice)} -> ${fmtPrice(t.exitPrice)}  ` +
        `${fmtPct(t.pnlPct)} (${fmtUsd(t.pnlUsd, { compact: false })})  ${t.exitReason}`,
    );
  }
  if (!res.trades.length) L.push('No trades.');
  if (res.realistic) L.push(`Fills: price impact from current pool liquidity + token taxes (estimate). Cost gate would have skipped ${res.gateSkips} trades.`);
  else L.push('Fills: fixed SLIPPAGE_BPS (--fixed-slippage).');
  L.push(
    `Trades ${s.trades} · wins ${s.wins} · losses ${s.losses} · win rate ${s.winRate === null ? 'n/a' : `${s.winRate.toFixed(1)}%`}`,
    `PnL ${fmtUsd(s.totalPnlUsd, { compact: false })} (${fmtPct(s.totalPnlPct)}) · final equity ${fmtUsd(s.finalEquity, { compact: false })}`,
    `Max drawdown ${s.maxDrawdownPct.toFixed(2)}% · profit factor ${s.profitFactor === null ? 'n/a' : s.profitFactor === Infinity ? 'inf' : s.profitFactor.toFixed(2)}` +
      ` · avg win ${fmtPct(s.avgWinPct)} · avg loss ${fmtPct(s.avgLossPct)} · buy&hold ${fmtPct(s.buyHoldPct)}`,
  );
  return L.join('\n');
}
