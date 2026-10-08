// Technical snapshot used by both the analyzer (report) and the strategy (signals). Pure.
import { ema, rsi, macd, atr, volumeSpike, barsSinceCross } from './indicators.js';

/**
 * @typedef {{
 *   ok: boolean, reason?: string, candles: number, close?: number,
 *   emaFast?: number, emaSlow?: number, rsi?: number|null, macd?: number|null, macdSignal?: number|null,
 *   macdHist?: number|null, macdHistPrev?: number|null, atr?: number|null, atrPct?: number|null,
 *   volSpike?: number|null, trend?: 'up'|'down'|'flat', momentum?: 'rising'|'falling'|'mixed',
 *   crossUpAgo?: number|null, crossDownAgo?: number|null,
 *   signal: 'bullish'|'bearish'|'neutral', reasons: string[]
 * }} Technicals
 */

/**
 * @param {import('./data/geckoterminal.js').Candle[]} candles oldest-first
 * @param {any} p analysis params (cfg.analysis)
 * @returns {Technicals}
 */
export function computeTechnicals(candles, p) {
  const n = candles?.length ?? 0;
  const need = Math.max(p.emaSlow, p.rsiPeriod, p.atrPeriod) + 2;
  if (n < need) {
    return { ok: false, reason: `not enough candles (${n}/${need})`, candles: n, signal: 'neutral', reasons: [] };
  }
  const closes = candles.map((c) => c.c);
  const ef = ema(closes, p.emaFast);
  const es = ema(closes, p.emaSlow);
  const r = rsi(closes, p.rsiPeriod);
  const m = macd(closes, p.macdFast, p.macdSlow, p.macdSignal);
  const a = atr(candles, p.atrPeriod);
  const i = n - 1;
  const close = closes[i];
  const vs = volumeSpike(candles.map((c) => c.v), p.volLookback);
  const crossUpAgo = barsSinceCross(ef, es, 'up', p.crossLookback);
  const crossDownAgo = barsSinceCross(ef, es, 'down', p.crossLookback);

  const trend = ef[i] > es[i] && close > es[i] ? 'up' : ef[i] < es[i] && close < es[i] ? 'down' : 'flat';
  const hist = m.histogram[i];
  const histPrev = m.histogram[i - 1];
  let momentum = 'mixed';
  if (hist !== null && histPrev !== null) {
    if (hist > 0 && hist >= histPrev) momentum = 'rising';
    else if (hist < 0 && hist <= histPrev) momentum = 'falling';
  }
  const rv = r[i];
  const reasons = [];
  let signal = 'neutral';

  const rsiOk = rv !== null && rv >= p.rsiMinEntry && rv <= p.rsiOverbought;
  if (trend === 'up' && crossUpAgo !== null && rsiOk) {
    signal = 'bullish';
    reasons.push(`EMA${p.emaFast} crossed above EMA${p.emaSlow} ${crossUpAgo === 0 ? 'on the last bar' : `${crossUpAgo} bar(s) ago`}`);
    reasons.push(`RSI ${rv.toFixed(1)} within ${p.rsiMinEntry}-${p.rsiOverbought}`);
  } else if (trend === 'down' || crossDownAgo !== null) {
    signal = 'bearish';
    if (crossDownAgo !== null) reasons.push(`EMA${p.emaFast} crossed below EMA${p.emaSlow} ${crossDownAgo === 0 ? "on the last bar" : `${crossDownAgo} bar(s) ago`}`);
    if (trend === 'down') reasons.push('price below falling EMAs');
  } else {
    if (trend === 'up' && crossUpAgo === null) reasons.push('uptrend but no fresh EMA cross');
    if (rv !== null && rv > p.rsiOverbought) reasons.push(`RSI ${rv.toFixed(1)} overbought`);
    if (rv !== null && rv < p.rsiMinEntry && trend === 'up') reasons.push(`RSI ${rv.toFixed(1)} below entry floor`);
    if (trend === 'flat') reasons.push('no clear trend');
  }
  if (momentum === 'rising') reasons.push('MACD histogram positive and rising');
  if (momentum === 'falling') reasons.push('MACD histogram negative and falling');
  if (vs !== null && vs >= p.volSpikeMult) reasons.push(`volume spike x${vs.toFixed(1)}`);

  return {
    ok: true,
    candles: n,
    close,
    emaFast: ef[i],
    emaSlow: es[i],
    rsi: rv,
    macd: m.macd[i],
    macdSignal: m.signal[i],
    macdHist: hist,
    macdHistPrev: histPrev,
    atr: a[i],
    atrPct: a[i] !== null && close ? (a[i] / close) * 100 : null,
    volSpike: vs,
    trend,
    momentum,
    crossUpAgo,
    crossDownAgo,
    signal,
    reasons,
  };
}
