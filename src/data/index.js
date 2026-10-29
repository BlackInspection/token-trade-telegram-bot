// LiveDataSource: DexScreener + GoPlus (+ honeypot.is) + GeckoTerminal behind one interface.
// MockDataSource (data/mock.js) implements the same interface offline.
import { DexScreenerClient, pickBestPair, parsePair, bestPairsByToken } from './dexscreener.js';
import { GoPlusClient, emptySecurity } from './goplus.js';
import { HoneypotIsClient } from './honeypot.js';
import { GeckoTerminalClient } from './geckoterminal.js';
import { QuoteClient } from './quotes.js';
import { RugCheckClient } from './rugcheck.js';
import { resolveIdentity } from './identity.js';
import { chainInfo, detectAddressKind, normalizeChain } from '../chains.js';
import { fetchJson } from '../http.js';
import { getLogger } from '../log.js';

const log = getLogger('data');

/**
 * @typedef {import('./dexscreener.js').MarketData} MarketData
 * @typedef {import('./goplus.js').SecurityReport} SecurityReport
 * @typedef {import('./geckoterminal.js').Candle} Candle
 * @typedef {{
 *   getMarket(address: string, chain?: string|null): Promise<MarketData|null>,
 *   getSecurity(market: MarketData, opts?: {maxAgeMs?: number}): Promise<SecurityReport|null>,
 *   getOhlcv(market: MarketData, timeframe: string, limit: number): Promise<Candle[]>,
 *   getRoundTrip?(market: MarketData, sizeUsd: number, security: SecurityReport|null, opts?: {allowQuote?: boolean}): Promise<any|null>,
 *   getIdentity?(market: MarketData): Promise<import('./identity.js').Identity>,
 *   getMarketsBatch?(chain: string, addresses: string[]): Promise<Map<string, MarketData>>,
 * }} DataSource
 *   Optional methods are feature-detected; a data source without them still works (estimate / 'unknown').
 */

/** Merge honeypot.is simulation into a GoPlus report (worst case wins). */
export function mergeHoneypotIs(sec, hp) {
  const out = sec ?? emptySecurity('evm');
  // Keep GoPlus' own view so disagreements between sources can be shown (explain.disagreements).
  out.goplusView = { buyTaxPct: out.buyTaxPct, sellTaxPct: out.sellTaxPct, cannotSellAll: out.cannotSellAll, isHoneypot: out.isHoneypot };
  out.honeypotIs = hp;
  out.sources = [...out.sources, 'honeypot.is'];
  if (hp.isHoneypot === true) out.isHoneypot = true;
  else if (out.isHoneypot === null && hp.isHoneypot === false) out.isHoneypot = false;
  const max = (a, b) => (a === null ? b : b === null ? a : Math.max(a, b));
  out.buyTaxPct = max(out.buyTaxPct, hp.buyTaxPct);
  out.sellTaxPct = max(out.sellTaxPct, hp.sellTaxPct);
  return out;
}

/** @implements {DataSource} */
export class LiveDataSource {
  constructor(cfg) {
    const t = cfg.api.timeoutMs;
    this.dex = new DexScreenerClient({ baseUrl: cfg.api.dexscreener, timeoutMs: t });
    this.goplus = new GoPlusClient({ baseUrl: cfg.api.goplus, accessToken: cfg.api.goplusToken, timeoutMs: t });
    this.gecko = new GeckoTerminalClient({ baseUrl: cfg.api.geckoterminal, timeoutMs: t });
    this.hp = cfg.api.useHoneypotIs ? new HoneypotIsClient({ baseUrl: cfg.api.honeypotIs, timeoutMs: t }) : null;
    this.secTtlMs = cfg.api.securityCacheSec * 1000;
    /** @type {Map<string, {at: number, value: SecurityReport|null}>} */
    this.secCache = new Map();
    this.useQuotes = cfg.api.useQuotes;
    this.quotes = new QuoteClient({
      jupiterUrl: cfg.live.jupiterApiUrl, jupiterKey: cfg.live.jupiterApiKey,
      kyberUrl: cfg.api.kyber, kyberClientId: cfg.api.kyberClientId, cacheSec: cfg.api.quoteCacheSec,
      timeoutMs: Math.min(t, 10_000),
    });
    this.rugcheck = cfg.api.useRugcheck ? new RugCheckClient({ baseUrl: cfg.api.rugcheck, timeoutMs: Math.min(t, 10_000) }) : null;
    this.jupiterTokensUrl = cfg.api.jupiterTokens;
    this.timeoutMs = t;
    this.identityTtlMs = cfg.api.identityCacheSec * 1000;
    /** @type {Map<string, {at: number, value: any}>} identity (24h) and search results (1h) */
    this.idCache = new Map();
    this.searchCache = new Map();
  }

  async getMarket(address, chain = null) {
    const pairs = await this.dex.getTokenPairs(address);
    const best = pickBestPair(pairs, address, normalizeChain(chain));
    return best ? parsePair(best, address) : null;
  }

  /** @param {{maxAgeMs?: number}} [opts] held tokens pass GUARDIAN_SECURITY_SEC*1000 to bypass the longer cache */
  async getSecurity(market, { maxAgeMs } = {}) {
    const key = `${market.chain}:${market.token.address.toLowerCase()}`;
    const hit = this.secCache.get(key);
    const ttl = maxAgeMs !== undefined ? Math.min(maxAgeMs, this.secTtlMs) : this.secTtlMs;
    if (hit && Date.now() - hit.at < ttl) return hit.value;

    const info = chainInfo(market.chain);
    const kind = info?.kind ?? detectAddressKind(market.token.address) ?? 'evm';
    const errors = [];
    let sec = null;
    try {
      sec = await this.goplus.getTokenSecurity(market.chain, market.token.address);
    } catch (err) {
      errors.push(`GoPlus: ${err.message}`);
      log.warn(`GoPlus failed for ${market.token.symbol}: ${err.message}`);
    }
    if (this.hp && info?.honeypotIs && info.chainId) {
      try {
        sec = mergeHoneypotIs(sec, await this.hp.check(market.token.address, info.chainId));
      } catch (err) {
        errors.push(`honeypot.is: ${err.message}`);
        log.debug(`honeypot.is failed: ${err.message}`);
      }
    }
    // Solana LP-lock gap: GoPlus leaves lpLockedPct null; RugCheck fills it (failure -> stays null).
    if (sec && kind === 'solana' && sec.lpLockedPct === null && this.rugcheck) {
      try {
        const rc = await this.rugcheck.summary(market.token.address);
        if (rc.lpLockedPct !== null) {
          sec.lpLockedPct = rc.lpLockedPct;
          sec.sources = [...sec.sources, 'rugcheck'];
        }
      } catch (err) {
        log.debug(`RugCheck failed: ${err.message}`);
      }
    }
    if (!sec && errors.length) sec = emptySecurity(kind);
    if (sec) sec.errors = [...(sec.errors ?? []), ...errors];
    // Do not cache transient failures.
    if (!errors.length) this.secCache.set(key, { at: Date.now(), value: sec });
    return sec;
  }

  /**
   * Round trip for `sizeUsd`: a real quote when allowed (analyze, /buy, /cost, open positions), else null so the
   * caller uses the pool-size estimate. Quotes are cached QUOTE_CACHE_SEC per chain:token:size.
   */
  async getRoundTrip(market, sizeUsd, security, { allowQuote = true } = {}) {
    if (!this.useQuotes || !allowQuote) return null;
    return this.quotes.roundTrip({
      chain: market.chain, token: market.token.address, sizeUsd,
      buyTaxPct: security?.buyTaxPct ?? 0, sellTaxPct: security?.sellTaxPct ?? 0,
    });
  }

  async getTokenInfo(chain, address) {
    const network = chainInfo(chain)?.gecko ?? chain;
    return this.gecko.getTokenInfo(network, address);
  }

  /** Jupiter token search: verified if isVerified or tags include verified/strict. */
  async jupiterVerified(mint) {
    const data = await fetchJson(`${this.jupiterTokensUrl}/search`, { query: { query: mint }, timeoutMs: this.timeoutMs, retries: 0 });
    const list = Array.isArray(data) ? data : data?.tokens ?? [];
    const t = list.find((x) => (x.id ?? x.address) === mint);
    if (!t) return false;
    const tags = Array.isArray(t.tags) ? t.tags : [];
    return t.isVerified === true || tags.includes('verified') || tags.includes('strict');
  }

  async searchPairs(q) {
    const key = String(q).toLowerCase();
    const hit = this.searchCache.get(key);
    if (hit && Date.now() - hit.at < 3_600_000) return hit.value;
    const pairs = await this.dex.search(q);
    this.searchCache.set(key, { at: Date.now(), value: pairs });
    return pairs;
  }

  /** Identity, cached IDENTITY_CACHE_SEC (24 h). 'unknown' results are not cached. */
  async getIdentity(market) {
    const key = `${market.chain}:${market.token.address.toLowerCase()}`;
    const hit = this.idCache.get(key);
    if (hit && Date.now() - hit.at < this.identityTtlMs) return hit.value;
    const id = await resolveIdentity(this, market);
    if (id.status !== 'unknown') this.idCache.set(key, { at: Date.now(), value: id });
    return id;
  }

  /** Markets for many tokens of one chain, <= 30 per DexScreener call. @returns {Promise<Map<string, MarketData>>} */
  async getMarketsBatch(chain, addresses) {
    const out = new Map();
    for (let i = 0; i < addresses.length; i += 30) {
      const pairs = await this.dex.getTokensBatch(chain, addresses.slice(i, i + 30));
      for (const [k, v] of bestPairsByToken(pairs)) out.set(k, v);
    }
    return out;
  }

  async getOhlcv(market, timeframe, limit) {
    const network = chainInfo(market.chain)?.gecko ?? market.chain; // TODO(verify): unknown chains guess gecko id = dexscreener id
    return this.gecko.getOhlcv({ network, pool: market.pairAddress, token: market.token.address, timeframe, limit });
  }
}
