// honeypot.is: buy/sell simulation for EVM (Ethereum, BSC, Base).
// GET /v2/IsHoneypot?address=0x...&chainID=1  (public)
import { fetchJson } from '../http.js';

/** @returns {{isHoneypot: boolean|null, buyTaxPct: number|null, sellTaxPct: number|null, risk: string|null, flags: string[]}} */
export function parseHoneypotIs(data) {
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const flags = data?.summary?.flags ?? data?.flags ?? [];
  return {
    isHoneypot: typeof data?.honeypotResult?.isHoneypot === 'boolean' ? data.honeypotResult.isHoneypot : null,
    // honeypot.is reports taxes in percent (e.g. 5 = 5%). TODO(verify) for exotic tokens.
    buyTaxPct: num(data?.simulationResult?.buyTax),
    sellTaxPct: num(data?.simulationResult?.sellTax),
    risk: data?.summary?.risk ?? null,
    flags: Array.isArray(flags) ? flags.map((f) => (typeof f === 'string' ? f : f?.flag ?? JSON.stringify(f))) : [],
  };
}

export class HoneypotIsClient {
  constructor({ baseUrl = 'https://api.honeypot.is', timeoutMs = 15000 } = {}) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  async check(address, chainId) {
    const data = await fetchJson(`${this.baseUrl}/v2/IsHoneypot`, {
      query: { address, chainID: chainId },
      timeoutMs: this.timeoutMs,
      retries: 1,
    });
    return parseHoneypotIs(data);
  }
}
