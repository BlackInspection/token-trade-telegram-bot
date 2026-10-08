// Round-trip quotes: buy with USDC and sell straight back, to measure what you would really get back.
//   Solana: Jupiter GET {JUPITER_API_URL}/quote (keyless on lite-api.jup.ag; x-api-key only if JUPITER_API_KEY).
//   EVM:    KyberSwap GET {KYBER_API_URL}/{slug}/api/v1/routes (header x-client-id).
// Both verified live 2026-10-28 without a key. 0x is NOT used here: /swap/allowance-holder/price
// returns 401 without ZEROX_API_KEY. A quote is not an execution.
import { fetchJson } from '../http.js';
import { chainInfo, SOLANA_USDC } from '../chains.js';
import { getLogger } from '../log.js';

const log = getLogger('quotes');

/** Recognise "no route" answers. TODO(verify): exact Jupiter error text and Kyber codes for an unsellable token. */
export function isNoRoute(errOrBody) {
  const body = typeof errOrBody === 'string' ? errOrBody : errOrBody?.body ?? errOrBody?.message ?? '';
  const status = errOrBody?.status ?? 0;
  if (status && ![400, 404, 422].includes(status)) return false;
  return /no route|route not found|could_not_find_any_route|could not find any route|no_routes_found|4008|4011/i.test(String(body));
}

const pctLoss = (size, back) => ((size - back) / size) * 100;

export class QuoteClient {
  /**
   * @param {{jupiterUrl: string, jupiterKey?: string, kyberUrl: string, kyberClientId: string,
   *   timeoutMs?: number, cacheSec?: number, fetchImpl?: typeof fetch, now?: () => number}} opts
   */
  constructor({ jupiterUrl, jupiterKey = '', kyberUrl, kyberClientId, timeoutMs = 10_000, cacheSec = 60, fetchImpl, now = () => Date.now() }) {
    this.jupiterUrl = jupiterUrl;
    this.jupiterKey = jupiterKey;
    this.kyberUrl = kyberUrl;
    this.kyberClientId = kyberClientId;
    this.timeoutMs = timeoutMs;
    this.cacheMs = cacheSec * 1000;
    this.fetchImpl = fetchImpl;
    this.now = now;
    /** @type {Map<string, {at: number, value: any}>} */
    this.cache = new Map();
    this.requests = 0;
  }

  get(url, query, headers = {}) {
    this.requests += 1;
    return fetchJson(url, { query, headers, timeoutMs: this.timeoutMs, retries: 0, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) });
  }

  /**
   * @returns {Promise<{getBackUsd: number, lossPct: number, rawLossPct: number, sellRoute: boolean, method: string,
   *   buyImpactPct?: number|null}|null>} null = no quote (timeout, network error, unsupported chain): use the estimate.
   */
  async roundTrip({ chain, token, sizeUsd, buyTaxPct = 0, sellTaxPct = 0 }) {
    const key = `${chain}:${String(token).toLowerCase()}:${sizeUsd}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.cacheMs) return hit.value;
    let value = null;
    try {
      const info = chainInfo(chain);
      if (info?.kind === 'solana') value = await this.jupiter(token, sizeUsd);
      else if (info?.kyber && info.usdc) value = await this.kyber(info, token, sizeUsd, buyTaxPct, sellTaxPct);
    } catch (err) {
      log.debug(`round-trip quote failed for ${token} on ${chain}: ${err.message}`);
      value = null;
    }
    if (value) this.cache.set(key, { at: this.now(), value });
    return value;
  }

  async jupiter(mint, sizeUsd) {
    const headers = this.jupiterKey ? { 'x-api-key': this.jupiterKey } : {};
    const amount = Math.round(sizeUsd * 10 ** SOLANA_USDC.decimals);
    let q1;
    try {
      q1 = await this.get(`${this.jupiterUrl}/quote`, { inputMint: SOLANA_USDC.address, outputMint: mint, amount, slippageBps: 50 }, headers);
    } catch (err) {
      if (isNoRoute(err)) return null; // cannot even buy: let the estimate speak
      throw err;
    }
    if (!q1?.outAmount) return null;
    let q2;
    try {
      q2 = await this.get(`${this.jupiterUrl}/quote`, { inputMint: mint, outputMint: SOLANA_USDC.address, amount: q1.outAmount, slippageBps: 50 }, headers);
    } catch (err) {
      if (isNoRoute(err)) return { getBackUsd: 0, lossPct: 100, rawLossPct: 100, sellRoute: false, method: 'jupiter' };
      throw err;
    }
    if (q2?.error || !q2?.outAmount) {
      if (isNoRoute(JSON.stringify(q2 ?? {}))) return { getBackUsd: 0, lossPct: 100, rawLossPct: 100, sellRoute: false, method: 'jupiter' };
      return null;
    }
    // TODO(verify): whether Jupiter quotes include Token-2022 transfer fees; if not, apply GoPlus transfer_fee here.
    const back = Number(q2.outAmount) / 10 ** SOLANA_USDC.decimals;
    const loss = pctLoss(sizeUsd, back);
    return {
      getBackUsd: back, lossPct: loss, rawLossPct: loss, sellRoute: true, method: 'jupiter',
      buyImpactPct: q1.priceImpactPct !== undefined ? Number(q1.priceImpactPct) * 100 : null,
    };
  }

  async kyber(info, token, sizeUsd, buyTaxPct, sellTaxPct) {
    const headers = { 'x-client-id': this.kyberClientId };
    const url = `${this.kyberUrl}/${info.kyber}/api/v1/routes`;
    const dec = info.usdc.decimals;
    const raw = BigInt(Math.round(sizeUsd * 10 ** Math.min(6, dec))) * 10n ** BigInt(Math.max(0, dec - 6));
    let r1;
    try {
      r1 = await this.get(url, { tokenIn: info.usdc.address, tokenOut: token, amountIn: raw.toString() }, headers);
    } catch (err) {
      if (isNoRoute(err)) return null;
      throw err;
    }
    const out1 = r1?.code === 0 ? r1?.data?.routeSummary?.amountOut : null;
    if (!out1) return null;
    let r2;
    try {
      r2 = await this.get(url, { tokenIn: token, tokenOut: info.usdc.address, amountIn: out1 }, headers);
    } catch (err) {
      if (isNoRoute(err)) return { getBackUsd: 0, lossPct: 100, rawLossPct: 100, sellRoute: false, method: 'kyber' };
      throw err;
    }
    if (r2?.code !== 0 || !r2?.data?.routeSummary) {
      if (isNoRoute(JSON.stringify(r2 ?? {}))) return { getBackUsd: 0, lossPct: 100, rawLossPct: 100, sellRoute: false, method: 'kyber' };
      return null;
    }
    const s = r2.data.routeSummary;
    let back = Number(s.amountOutUsd);
    if (!Number.isFinite(back)) back = Number(s.amountOut) / 10 ** dec;
    // Kyber does not simulate fee-on-transfer: apply the token taxes from honeypot.is / GoPlus.
    back *= (1 - (buyTaxPct ?? 0) / 100) * (1 - (sellTaxPct ?? 0) / 100);
    const loss = pctLoss(sizeUsd, back);
    return { getBackUsd: back, lossPct: loss, rawLossPct: loss, sellRoute: true, method: 'kyber', buyImpactPct: null };
  }
}
