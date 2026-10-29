// Position sizing, entry limits, SL/TP levels, trailing stop and exit checks. Pure.

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Size of a new position in USD.
 * Fixed `sizeUsd`, or `sizePct` % of equity when sizePct > 0; capped by maxTradeUsd and available cash.
 */
export function positionSizeUsd({ equity, cash = null, sizeUsd, sizePct = 0, maxTradeUsd = Infinity }) {
  let size = sizePct > 0 ? (equity * sizePct) / 100 : sizeUsd;
  size = Math.min(size, maxTradeUsd);
  if (cash !== null && cash !== undefined) size = Math.min(size, cash);
  return size > 0 ? round2(size) : 0;
}

/**
 * Hard limits before opening a position (every buy: manual, automatic, confirmation cards). `paused` is /pause or
 * an auto-pause.
 * @returns {{ok: boolean, code: string|null, reason: string, p?: any}}
 */
export function checkEntryAllowed({
  paused = false,
  hasPosition = false,
  openPositions = 0,
  maxOpenPositions = 3,
  dailyPnlUsd = 0,
  dailyLossLimitUsd = Infinity,
  tradesLastHour = 0,
  maxTradesPerHour = Infinity,
  sizeUsd = 0,
  maxTradeUsd = Infinity,
  minTradeUsd = 1,
}) {
  if (paused) return { ok: false, code: 'PAUSED', reason: 'trading is paused: no new entries until it is resumed (/resume; exits keep running)' };
  if (hasPosition) return { ok: false, code: 'POSITION_OPEN', reason: 'position already open' };
  if (openPositions >= maxOpenPositions) return { ok: false, code: 'LIMIT_EXPOSURE', reason: `max open positions reached (${maxOpenPositions})`, p: { open: openPositions, max: maxOpenPositions } };
  if (dailyLossLimitUsd > 0 && dailyPnlUsd <= -dailyLossLimitUsd) {
    return { ok: false, code: 'LIMIT_DAILY_LOSS', reason: `daily loss limit hit (${dailyPnlUsd.toFixed(2)} <= -${dailyLossLimitUsd})`, p: { pnlUsd: dailyPnlUsd } };
  }
  if (tradesLastHour >= maxTradesPerHour) return { ok: false, code: 'LIMIT_HOURLY', reason: `max trades per hour reached (${maxTradesPerHour})`, p: { count: tradesLastHour, max: maxTradesPerHour } };
  if (sizeUsd > maxTradeUsd + 1e-9) return { ok: false, code: 'PRICE_ABOVE_MAX', reason: `size $${sizeUsd} exceeds MAX_TRADE_USD $${maxTradeUsd}`, p: { usd: sizeUsd, max: maxTradeUsd } };
  if (sizeUsd < minTradeUsd) return { ok: false, code: 'NOT_ENOUGH_CASH', reason: `size $${sizeUsd} below minimum $${minTradeUsd} (no cash?)` };
  return { ok: true, code: null, reason: 'ok' };
}

/**
 * ATR-based stop-loss and take-profit.
 * SL distance = clamp(ATR * atrSlMult, minSlPct, maxSlPct) of price (defaultSlPct without ATR).
 * TP = entry + distance * tpRr (tpRr <= 0 disables TP -> trailing stop only).
 */
export function computeLevels(price, atrValue, p) {
  if (!price || !Number.isFinite(price)) return null;
  let dist = atrValue && Number.isFinite(atrValue) ? atrValue * p.atrSlMult : (price * p.defaultSlPct) / 100;
  dist = Math.min(Math.max(dist, (price * p.minSlPct) / 100), (price * p.maxSlPct) / 100);
  const stopLoss = price - dist;
  const takeProfit = p.tpRr > 0 ? price + dist * p.tpRr : null;
  return {
    entry: price,
    stopLoss,
    takeProfit,
    takeProfit2: p.tpRr > 0 ? price + dist * p.tpRr * 2 : null,
    slPct: (-dist / price) * 100,
    tpPct: takeProfit ? ((takeProfit - price) / price) * 100 : null,
  };
}

/** Effective stop: max(initial stop, trailing stop from the highest price seen). */
export function effectiveStop(pos, trailingPct) {
  const trail = trailingPct > 0 && pos.trailHigh ? pos.trailHigh * (1 - trailingPct / 100) : -Infinity;
  return Math.max(pos.stopLoss ?? -Infinity, trail);
}

/**
 * Exit check for an open position against a tick (price) or a candle (low/high).
 * Stop is checked before take-profit (conservative when both are inside one candle).
 * @returns {{reason: 'STOP_LOSS'|'TRAILING_STOP'|'TAKE_PROFIT', price: number}|null}
 */
export function checkExit(pos, { price, high = price, low = price }, trailingPct = 0) {
  const stop = effectiveStop(pos, trailingPct);
  if (Number.isFinite(stop) && low <= stop) {
    const trailing = trailingPct > 0 && stop > (pos.stopLoss ?? -Infinity);
    return { reason: trailing ? 'TRAILING_STOP' : 'STOP_LOSS', price: Math.min(stop, high) };
  }
  if (pos.takeProfit && high >= pos.takeProfit) {
    return { reason: 'TAKE_PROFIT', price: Math.max(pos.takeProfit, low) };
  }
  return null;
}

/** New trailing high after observing `high`. */
export const updateTrailHigh = (pos, high) => Math.max(pos.trailHigh ?? pos.entryPrice ?? 0, high);

// ------------------------------------------------------------------ seatbelts (entries only, never exits)

const MIN = 60_000;
const hhmm = (ts) => new Date(ts).toISOString().slice(11, 16);
const dayHhmm = (ts) => {
  const d = new Date(ts);
  return `${d.getUTCDate()} ${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${hhmm(ts)}`;
};

export const startOfUtcMonth = (ts) => {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};
export const startOfNextUtcMonth = (ts) => {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};

/** Losing closes in a row, newest first. @param {{realizedPnlUsd: number}[]} closedNewestFirst */
export function lossStreak(closedNewestFirst) {
  let n = 0;
  for (const p of closedNewestFirst) {
    if ((p.realizedPnlUsd ?? 0) < 0) n += 1;
    else break;
  }
  return n;
}

const fmt$ = (v) => `$${Math.max(0, v).toFixed(Math.abs(v - Math.round(v)) < 0.005 ? 0 : 2)}`;

/**
 * Seatbelts gate ENTRIES only (manual and automatic, every mode, practice included). Exits are never blocked.
 * @param {{now: number, closedPositions: {address: string, realizedPnlUsd: number, closedAt: number, closeReason?: string}[],
 *   monthPnlUsd: number, budgetUsd: number, streakPause: number, cooldownMin: number, revengeMin: number,
 *   address?: string, verdict?: string, override?: boolean}} a closedPositions newest first
 * @returns {{ok: boolean, code: string|null, reason: string, until: number|null, budgetLeftUsd: number|null, streak: number,
 *   lostUsd: number}} lostUsd = realized loss this month (0 when in profit)
 */
export function checkSeatbelts({ now, closedPositions = [], monthPnlUsd = 0, budgetUsd = 0, streakPause = 3, cooldownMin = 120, revengeMin = 60, address = null, verdict = null, override = false }) {
  const lost = Math.max(0, -monthPnlUsd);
  const budgetLeftUsd = budgetUsd > 0 ? Math.max(0, budgetUsd - lost) : null;
  const left = budgetUsd > 0 ? `${fmt$(budgetLeftUsd)} of your ${fmt$(budgetUsd)} monthly budget left.` : 'Monthly loss budget not set.';
  const streak = lossStreak(closedPositions);
  const no = (code, reason, until = null) => ({ ok: false, code, reason, until, budgetLeftUsd, streak, lostUsd: lost });

  if (verdict === 'AVOID') return no('AVOID_ADD_ON', `Not buying: this token is rated AVOID. ${left}`);
  if (budgetUsd > 0 && lost >= budgetUsd) {
    const until = startOfNextUtcMonth(now);
    return no('LOSS_BUDGET', `Paused: you lost ${fmt$(lost)} this month, the whole ${fmt$(budgetUsd)} budget. Back on ${dayHhmm(until)} UTC.`, until);
  }
  if (streakPause > 0 && streak >= streakPause && closedPositions[0]?.closedAt) {
    const until = closedPositions[0].closedAt + cooldownMin * MIN;
    if (now < until && !override) return no('LOSS_STREAK', `Paused: ${streak} losses in a row. ${left} Back at ${hhmm(until)} UTC.`, until);
  }
  if (address && revengeMin > 0) {
    const a = String(address).toLowerCase();
    const stop = closedPositions.find((p) => String(p.address).toLowerCase() === a && /STOP|TRAILING/.test(p.closeReason ?? ''));
    if (stop && now - stop.closedAt < revengeMin * MIN) {
      const until = stop.closedAt + revengeMin * MIN;
      return no('REVENGE_BLOCK', `No revenge trade: this token hit your stop ${Math.round((now - stop.closedAt) / MIN)} min ago. ${left} Back at ${hhmm(until)} UTC.`, until);
    }
  }
  return { ok: true, code: null, reason: 'ok', until: null, budgetLeftUsd, streak, lostUsd: lost };
}

/** One status line for /safety and the mock. */
export function seatbeltStatus({ streak, streakPause, budgetUsd, monthPnlUsd }) {
  const s = `${streak} loss${streak === 1 ? '' : 'es'} in a row (pause after ${streakPause})`;
  const lost = Math.max(0, -monthPnlUsd);
  const b = budgetUsd > 0 ? `monthly budget ${fmt$(Math.max(0, budgetUsd - lost))} of ${fmt$(budgetUsd)} left` : 'monthly budget not set';
  return `Seatbelts: ${s} · ${b}`;
}

/**
 * Is changing a tunable from oldV to newV a loosening (riskier) change?
 * @param {{dir: 'up'|'down', zeroMeansOff?: boolean}} spec
 */
export function isLoosening(spec, oldV, newV) {
  if (!spec || oldV === newV) return false;
  if (spec.zeroMeansOff) {
    if (newV === 0) return oldV !== 0; // switching a limit off
    if (oldV === 0) return false; // switching a limit on is tightening
  }
  return spec.dir === 'up' ? newV > oldV : newV < oldV;
}
