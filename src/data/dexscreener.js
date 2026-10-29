// DexScreener: market data. GET /latest/dex/tokens/{address} (public, ~300 req/min).
import { fetchJson } from '../http.js';

/**
 * @typedef {{buys: number, sells: number}} TxnCount
 * @typedef {{
 *   chain: string, dexId: string, labels: string[], pairAddress: string, url: string,
 *   token: {address: string, name: string, symbol: string}, quote: {address: string, symbol: string},
 *   tokenIsBase: boolean, priceUsd: number|null, priceNative: number|null, liquidityUsd: number|null,
 *   fdv: number|null, marketCap: number|null,
 *   volume: {m5: number|null, h1: number|null, h6: number|null, h24: number|null},
 *   priceChange: {m5: number|null, h1: number|null, h6: number|null, h24: number|null},
 *   txns: {m5: TxnCount, h1: TxnCount, h6: TxnCount, h24: TxnCount},
 *   pairCreatedAt: number|null, pairAgeHours: number|null
 * }} MarketData
 */

export class DexScreenerClient {
  constructor({ baseUrl = 'https://api.dexscreener.com', timeoutMs = 15000 } = {}) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  /** @returns {Promise<any[]>} raw pairs */
  async getTokenPairs(address) {
    const data = await fetchJson(`${this.baseUrl}/latest/dex/tokens/${encodeURIComponent(address)}`, {
      timeoutMs: this.timeoutMs,
    });
    return Array.isArray(data?.pairs) ? data.pairs : [];
  }

  /** Free-text search (symbol/name/address). Verified 2026-10-28: up to 30 pairs across chains. */
  async search(q) {
    const data = await fetchJson(`${this.baseUrl}/latest/dex/search`, { query: { q }, timeoutMs: this.timeoutMs });
    return Array.isArray(data?.pairs) ? data.pairs : [];
  }

  /**
   * Up to 30 token addresses on one chain in one call: GET /tokens/v1/{chainId}/{a,b,...}.
   * Verified 2026-10-28 (BONK+WIF on solana in one call). Returns raw pairs (a flat array).
   */
  async getTokensBatch(chainId, addresses) {
    if (addresses.length > 30) throw new Error('DexScreener /tokens/v1 takes at most 30 addresses per call');
    const data = await fetchJson(`${this.baseUrl}/tokens/v1/${encodeURIComponent(chainId)}/${addresses.map(encodeURIComponent).join(',')}`, {
      timeoutMs: this.timeoutMs,
    });
    return Array.isArray(data) ? data : Array.isArray(data?.pairs) ? data.pairs : [];
  }
}

/** Best pair per base token address (lowercased key) from a batch answer, chosen by pickBestPair. @returns {Map<string, MarketData>} */
export function bestPairsByToken(pairs, now = Date.now()) {
  const groups = new Map();
  for (const p of pairs ?? []) {
    const a = String(p?.baseToken?.address ?? '').toLowerCase();
    if (!a) continue;
    if (!groups.has(a)) groups.set(a, []);
    groups.get(a).push(p);
  }
  const out = new Map();
  for (const [a, list] of groups) {
    const best = pickBestPair(list, list[0].baseToken.address);
    if (best) out.set(a, parsePair(best, best.baseToken.address, now));
  }
  return out;
}

const n = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const liq = (p) => n(p?.liquidity?.usd) ?? 0;
const vol24 = (p) => n(p?.volume?.h24) ?? 0;
const same = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

/** A pair whose price is more than this fraction away from the volume-weighted median is ignored. */
export const PRICE_OUTLIER_FRAC = 0.5;
/** Standard quote assets; such pairs get a 2x weight in the ranking. */
const STANDARD_QUOTES = new Set(['usdc', 'usdt', 'usdce', 'usdbc', 'dai', 'sol', 'wsol', 'eth', 'weth', 'bnb', 'wbnb']);

/** USD price of `address` in this pair (the token may be the quote side), or null. */
export function tokenPriceInPair(p, address) {
  const usd = n(p?.priceUsd);
  if (same(p?.baseToken?.address, address)) return usd;
  const nat = n(p?.priceNative);
  if (same(p?.quoteToken?.address, address)) return usd && nat ? usd / nat : null;
  return null;
}

/** Weighted median of [{v, w}] (plain median when no weights). */
function weightedMedian(items) {
  const xs = items.filter((x) => x.v > 0).sort((a, b) => a.v - b.v);
  if (!xs.length) return null;
  const total = xs.reduce((t, x) => t + x.w, 0);
  if (!(total > 0)) return xs[Math.floor((xs.length - 1) / 2)].v;
  let acc = 0;
  for (const x of xs) {
    acc += x.w;
    if (acc >= total / 2) return x.v;
  }
  return xs[xs.length - 1].v;
}

/**
 * Pick the pair to trust for the token. Prefers pairs where the token is the base side. If `chain` is given only that
 * chain is considered (DexScreener chainId, e.g. "ethereum", "solana").
 * Reported liquidity alone is not trusted (a bogus BONK/JUP DLMM pool once reported $37.9M at 5000x the real price):
 * pairs priced more than PRICE_OUTLIER_FRAC away from the 24h-volume-weighted median are dropped, then the rest are
 * ranked by 24h volume (x2 for a standard quote: USDC, USDT, SOL, WETH, WBNB), with liquidity as the tie-break.
 */
export function pickBestPair(pairs, address, chain = null) {
  const pool = (pairs ?? []).filter((p) => !chain || p.chainId === chain);
  const asBase = pool.filter((p) => same(p.baseToken?.address, address));
  const cands = asBase.length ? asBase : pool.filter((p) => same(p.quoteToken?.address, address));
  if (!cands.length) return null;
  const med = weightedMedian(cands.map((p) => ({ v: tokenPriceInPair(p, address), w: vol24(p) })));
  let ok = cands;
  if (med) {
    const inBand = cands.filter((p) => {
      const v = tokenPriceInPair(p, address);
      return v > 0 && Math.abs(v / med - 1) <= PRICE_OUTLIER_FRAC;
    });
    if (inBand.length) ok = inBand;
  }
  const other = (p) => (same(p.baseToken?.address, address) ? p.quoteToken : p.baseToken);
  const score = (p) => vol24(p) * (STANDARD_QUOTES.has(String(other(p)?.symbol ?? '').toLowerCase().replace(/[^a-z]/g, '')) ? 2 : 1);
  return [...ok].sort((a, b) => score(b) - score(a) || liq(b) - liq(a))[0];
}

const txn = (t) => ({ buys: n(t?.buys) ?? 0, sells: n(t?.sells) ?? 0 });

/** Normalise a raw DexScreener pair into MarketData. @returns {MarketData} */
export function parsePair(pair, address, now = Date.now()) {
  const tokenIsBase = same(pair.baseToken?.address, address) || !same(pair.quoteToken?.address, address);
  const tok = tokenIsBase ? pair.baseToken : pair.quoteToken;
  const other = tokenIsBase ? pair.quoteToken : pair.baseToken;
  let priceUsd = n(pair.priceUsd);
  let priceNative = n(pair.priceNative);
  if (!tokenIsBase && priceUsd && priceNative) {
    // Token is the quote side: priceUsd/priceNative describe the base token.
    priceUsd = priceUsd / priceNative;
    priceNative = 1 / priceNative;
  }
  const created = n(pair.pairCreatedAt);
  return {
    chain: pair.chainId,
    dexId: pair.dexId ?? '',
    labels: pair.labels ?? [],
    pairAddress: pair.pairAddress,
    url: pair.url ?? '',
    token: { address: tok?.address ?? address, name: tok?.name ?? '', symbol: tok?.symbol ?? '?' },
    quote: { address: other?.address ?? '', symbol: other?.symbol ?? '?' },
    tokenIsBase,
    priceUsd,
    priceNative,
    liquidityUsd: n(pair.liquidity?.usd),
    fdv: n(pair.fdv),
    marketCap: n(pair.marketCap),
    volume: { m5: n(pair.volume?.m5), h1: n(pair.volume?.h1), h6: n(pair.volume?.h6), h24: n(pair.volume?.h24) },
    priceChange: {
      m5: n(pair.priceChange?.m5), h1: n(pair.priceChange?.h1), h6: n(pair.priceChange?.h6), h24: n(pair.priceChange?.h24),
    },
    txns: { m5: txn(pair.txns?.m5), h1: txn(pair.txns?.h1), h6: txn(pair.txns?.h6), h24: txn(pair.txns?.h24) },
    pairCreatedAt: created,
    pairAgeHours: created ? Math.max(0, (now - created) / 3_600_000) : null,
  };
}
