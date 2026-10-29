// Strategy interface + default EMA-cross / RSI-filter / risk-gate strategy.
import { computeTechnicals } from './technicals.js';

/**
 * @typedef {'BUY'|'SELL'|'HOLD'} Action
 * @typedef {{action: Action, reason: string, price: number|null, t: number|null, atr?: number|null}} Signal
 * @typedef {{
 *   position?: any|null,          // open position for this token (null if flat)
 *   risk?: {score: number, hardAvoid: boolean}|null, // analyzer risk; undefined = no gate
 *   warmup?: boolean,             // feed history without evaluating
 * }} StrategyContext
 */

export const hold = (reason = '', price = null, t = null) => ({ action: 'HOLD', reason, price, t });

/** Base class. Implementations override onCandle and optionally onTick. */
export class Strategy {
  name = 'base';

  /** Called with every closed (or updating) candle, oldest first. @returns {Signal} */
  // eslint-disable-next-line no-unused-vars
  onCandle(candle, ctx = {}) {
    return hold();
  }

  /** Called with intra-candle price ticks ({price, t}). SL/TP are handled by the engine. @returns {Signal} */
  // eslint-disable-next-line no-unused-vars
  onTick(tick, ctx = {}) {
    return hold();
  }

  /** Feed history without producing signals. */
  warmup(candles) {
    for (const c of candles) this.onCandle(c, { warmup: true });
  }
}

/**
 * Entry: EMA fast crossed above EMA slow within CROSS_LOOKBACK bars, price above slow EMA,
 *        RSI in [RSI_MIN_ENTRY, RSI_OVERBOUGHT], and the risk gate passes (no hard-avoid, score <= MAX_BUY_RISK).
 * Exit:  EMA bearish cross on the current bar, or RSI >= RSI_EXIT. (SL/TP/trailing are enforced by the engine/backtester.)
 */
export class EmaCrossRsiStrategy extends Strategy {
  name = 'ema_cross_rsi';

  /** @param {any} p cfg.analysis */
  constructor(p, { maxCandles = 600 } = {}) {
    super();
    this.p = p;
    this.maxCandles = maxCandles;
    /** @type {import('./data/geckoterminal.js').Candle[]} */
    this.candles = [];
  }

  get lastT() {
    return this.candles.length ? this.candles[this.candles.length - 1].t : -Infinity;
  }

  /** Append, or replace the last candle when it has the same open time (candle still forming). */
  push(candle) {
    const last = this.candles[this.candles.length - 1];
    if (last && candle.t === last.t) this.candles[this.candles.length - 1] = candle;
    else if (!last || candle.t > last.t) this.candles.push(candle);
    else return false;
    if (this.candles.length > this.maxCandles) this.candles.splice(0, this.candles.length - this.maxCandles);
    return true;
  }

  onCandle(candle, ctx = {}) {
    if (!this.push(candle) || ctx.warmup) return hold('warmup', candle.c, candle.t);
    const p = this.p;
    const ta = computeTechnicals(this.candles, p);
    const at = (action, reason) => ({ action, reason, price: candle.c, t: candle.t, atr: ta.atr ?? null });
    if (!ta.ok) return at('HOLD', ta.reason);

    if (ctx.position) {
      if (ta.crossDownAgo === 0) return at('SELL', `EMA${p.emaFast} crossed below EMA${p.emaSlow}`);
      if (ta.rsi !== null && ta.rsi >= p.rsiExit) return at('SELL', `RSI ${ta.rsi.toFixed(1)} >= ${p.rsiExit}`);
      return at('HOLD', 'in position');
    }

    const risk = ctx.risk;
    if (risk && risk.hardAvoid) return at('HOLD', 'risk gate: hard avoid');
    if (risk && risk.score > p.maxBuyRisk) return at('HOLD', `risk gate: score ${risk.score} > ${p.maxBuyRisk}`);

    if (ta.signal === 'bullish') return at('BUY', ta.reasons.slice(0, 2).join('; '));
    return at('HOLD', ta.reasons[0] ?? ta.signal);
  }
}

export const STRATEGIES = { ema_cross_rsi: EmaCrossRsiStrategy };

/**
 * @returns {(pNow?: any) => Strategy} the engine passes its current cfg.analysis (settings changed in the bot, such as
 *   max_buy_risk, must reach the strategy's risk gate); without it the factory uses `p`.
 */
export function strategyFactory(name, p) {
  const Cls = STRATEGIES[name];
  if (!Cls) throw new Error(`Unknown strategy "${name}" (available: ${Object.keys(STRATEGIES).join(', ')})`);
  return (pNow) => new Cls(pNow ?? p);
}
