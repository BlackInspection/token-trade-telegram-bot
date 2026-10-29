// Pure technical indicators on plain arrays (no TA-Lib). Every function returns an
// array aligned with its input; positions without enough history are `null`.

/** @param {number[]} values @param {number} period */
export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** EMA seeded with the SMA of the first `period` values. Leading nulls in input are skipped. */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const start = values.findIndex((v) => v !== null && v !== undefined);
  if (start < 0 || period <= 0 || values.length - start < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = start; i < start + period; i++) prev += values[i];
  prev /= period;
  out[start + period - 1] = prev;
  for (let i = start + period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** RSI with Wilder smoothing. First value at index `period`. */
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  const val = () => (avgL === 0 ? (avgG === 0 ? 50 : 100) : 100 - 100 / (1 + avgG / avgL));
  out[period] = val();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = val();
  }
  return out;
}

/** MACD line, signal line and histogram. */
export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] === null || es[i] === null ? null : ef[i] - es[i]));
  const sig = ema(line, signal);
  const hist = line.map((v, i) => (v === null || sig[i] === null ? null : v - sig[i]));
  return { macd: line, signal: sig, histogram: hist };
}

/** @param {{h: number, l: number, c: number}[]} candles */
export function trueRange(candles) {
  return candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const pc = candles[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  });
}

/** Average True Range, Wilder smoothing. First value at index `period - 1`. */
export function atr(candles, period = 14) {
  const tr = trueRange(candles);
  const out = new Array(candles.length).fill(null);
  if (candles.length < period) return out;
  let prev = 0;
  for (let i = 0; i < period; i++) prev += tr[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** Last volume divided by the mean of the previous `lookback` volumes (null if not computable). */
export function volumeSpike(volumes, lookback = 20) {
  const n = volumes.length;
  if (n < lookback + 1) return null;
  let sum = 0;
  for (let i = n - 1 - lookback; i < n - 1; i++) sum += volumes[i];
  const mean = sum / lookback;
  return mean > 0 ? volumes[n - 1] / mean : null;
}

/** a crosses above b at index i. */
export function crossover(a, b, i) {
  if (i < 1 || [a[i], b[i], a[i - 1], b[i - 1]].some((v) => v === null || v === undefined)) return false;
  return a[i - 1] <= b[i - 1] && a[i] > b[i];
}

/** a crosses below b at index i. */
export function crossunder(a, b, i) {
  if (i < 1 || [a[i], b[i], a[i - 1], b[i - 1]].some((v) => v === null || v === undefined)) return false;
  return a[i - 1] >= b[i - 1] && a[i] < b[i];
}

/** Bars since the most recent cross (0 = on the last bar) within `lookback`, else null. */
export function barsSinceCross(a, b, dir = 'up', lookback = 3) {
  const fn = dir === 'up' ? crossover : crossunder;
  const last = a.length - 1;
  for (let k = 0; k <= lookback && last - k >= 1; k++) {
    if (fn(a, b, last - k)) return k;
  }
  return null;
}

/** Last non-null value of an array. */
export function lastValue(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] !== null && arr[i] !== undefined) return arr[i];
  return null;
}
