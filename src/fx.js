// Display currency. Prices come from DexScreener in USD; USDC ~ 1 USD, so USD is the native currency here.
// Other display currencies are optional and never block a decision: if FX fails, only USD is shown.
import { fetchJson } from './http.js';

/**
 * Default rate source. TODO(verify): a keyless USD->RUB/EUR source; TonAPI /v2/rates is used by the TON bots
 * (tokens=usdt is assumed to be priced ~1 USD).
 */
export async function tonapiRates() {
  const data = await fetchJson('https://tonapi.io/v2/rates', { query: { tokens: 'usdt', currencies: 'usd,rub,eur' }, timeoutMs: 8000, retries: 0 });
  const p = data?.rates?.USDT?.prices ?? data?.rates?.usdt?.prices ?? {};
  const usd = Number(p.USD ?? 1);
  return { rub: Number(p.RUB) / usd, eur: Number(p.EUR) / usd };
}

export class Fx {
  /** @param {{currency?: string, fetchRates?: () => Promise<Record<string, number>>, cacheSec?: number, now?: () => number}} opts */
  constructor({ currency = 'usd', fetchRates = tonapiRates, cacheSec = 300, now = () => Date.now() } = {}) {
    this.currency = currency;
    this.fetchRates = fetchRates;
    this.cacheMs = cacheSec * 1000;
    this.now = now;
    this.cache = null;
  }

  /** USD -> display currency rate, or null (FX off / failed). */
  async rate() {
    if (this.currency === 'usd' || this.currency === 'none') return null;
    if (this.cache && this.now() - this.cache.at < this.cacheMs) return this.cache.rates[this.currency] ?? null;
    try {
      const rates = await this.fetchRates();
      this.cache = { at: this.now(), rates };
      const r = rates[this.currency];
      return Number.isFinite(r) && r > 0 ? r : null;
    } catch {
      this.cache = { at: this.now(), rates: {} }; // back off for FX_CACHE_SEC instead of refetching on every message
      return null;
    }
  }

  /** "$50.00 (~4,600 RUB)" or "$50.00" when FX is off or failed. */
  async format(usd) {
    const base = `$${usd.toFixed(2)}`;
    const r = await this.rate();
    if (!r) return base;
    return `${base} (~${Math.round(usd * r).toLocaleString('en-US')} ${this.currency.toUpperCase()})`;
  }
}
