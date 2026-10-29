// GeckoTerminal: OHLCV candles for a pool.
// GET /networks/{network}/pools/{pool}/ohlcv/{minute|hour|day}?aggregate=..&limit=..&token=..
// Public, ~30 req/min. Returns newest-first [ts_sec, o, h, l, c, volume_usd].
import { fetchJson } from '../http.js';

/** @typedef {{t: number, o: number, h: number, l: number, c: number, v: number}} Candle  t = open time, ms */

const ALLOWED = { minute: [1, 5, 15], hour: [1, 4, 12], day: [1] };

/** "5m" -> {timeframe: "minute", aggregate: 5, ms: 300000} */
export function timeframeToGecko(tf) {
  const m = /^(\d+)\s*(m|h|d)$/i.exec(String(tf).trim());
  if (!m) throw new Error(`Invalid timeframe "${tf}" (use 1m, 5m, 15m, 1h, 4h, 12h, 1d)`);
  const agg = Number(m[1]);
  const unit = m[2].toLowerCase();
  const timeframe = unit === 'm' ? 'minute' : unit === 'h' ? 'hour' : 'day';
  if (!ALLOWED[timeframe].includes(agg)) {
    throw new Error(`Unsupported timeframe "${tf}" (GeckoTerminal supports 1m, 5m, 15m, 1h, 4h, 12h, 1d)`);
  }
  const unitMs = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return { timeframe, aggregate: agg, ms: agg * unitMs };
}

/** Raw API JSON -> candles sorted oldest-first, de-duplicated. @returns {Candle[]} */
export function parseOhlcv(json) {
  const list = json?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  const byT = new Map();
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [t, o, h, l, c, v] = row.map(Number);
    if (![t, o, h, l, c].every(Number.isFinite)) continue;
    byT.set(t * 1000, { t: t * 1000, o, h, l, c, v: Number.isFinite(v) ? v : 0 });
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

export class GeckoTerminalClient {
  constructor({ baseUrl = 'https://api.geckoterminal.com/api/v2', timeoutMs = 15000 } = {}) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  /** @returns {Promise<Candle[]>} */
  async getOhlcv({ network, pool, token, timeframe = '5m', limit = 300 }) {
    const tf = timeframeToGecko(timeframe);
    const json = await fetchJson(`${this.baseUrl}/networks/${network}/pools/${pool}/ohlcv/${tf.timeframe}`, {
      query: { aggregate: tf.aggregate, limit: Math.min(1000, Math.max(1, limit)), token, currency: 'usd' },
      timeoutMs: this.timeoutMs,
    });
    return parseOhlcv(json);
  }

  /**
   * GET /networks/{net}/tokens/{addr}/info. Verified 2026-10-28 for BONK: coingecko_coin_id 'bonk', gt_score 76.1,
   * developer_address and holders.distribution_percentage. @returns {Promise<TokenInfo|null>}
   */
  async getTokenInfo(network, address) {
    let json;
    try {
      json = await fetchJson(`${this.baseUrl}/networks/${network}/tokens/${address}/info`, { timeoutMs: this.timeoutMs, retries: 0 });
    } catch (err) {
      // 404 = GeckoTerminal does not know the token (not listed). Anything else (429, 5xx, network) is a failed
      // lookup and is thrown, so identity can say 'unknown' instead of 'not listed'.
      if (err?.status === 404) return null;
      throw err;
    }
    return parseTokenInfo(json);
  }
}

/** @typedef {{coingeckoId: string|null, gtScore: number|null, developerAddress: string|null, symbol: string|null}} TokenInfo */
export function parseTokenInfo(json) {
  const a = json?.data?.attributes;
  if (!a) return null;
  const score = Number(a.gt_score);
  return {
    coingeckoId: a.coingecko_coin_id || null,
    gtScore: Number.isFinite(score) ? score : null,
    developerAddress: a.developer_address || null,
    symbol: a.symbol ?? null,
  };
}
