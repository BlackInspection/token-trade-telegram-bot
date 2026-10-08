// RugCheck (Solana): fills the LP-lock gap GoPlus leaves for Solana pools.
// GET {RUGCHECK_URL}/v1/tokens/{mint}/report/summary (verified keyless 2026-10-28: lpLockedPct, score_normalised, risks[]).
// TODO(verify): RugCheck rate limits and terms of use for automated calls.
import { fetchJson } from '../http.js';

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** @returns {{lpLockedPct: number|null, score: number|null, risks: string[]}} */
export function parseRugcheckSummary(json) {
  return {
    lpLockedPct: num(json?.lpLockedPct),
    score: num(json?.score_normalised ?? json?.score),
    risks: Array.isArray(json?.risks) ? json.risks.map((r) => (typeof r === 'string' ? r : r?.name ?? '')).filter(Boolean) : [],
  };
}

export class RugCheckClient {
  constructor({ baseUrl = 'https://api.rugcheck.xyz', timeoutMs = 10_000, fetchImpl } = {}) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async summary(mint) {
    const json = await fetchJson(`${this.baseUrl}/v1/tokens/${encodeURIComponent(mint)}/report/summary`, {
      timeoutMs: this.timeoutMs, retries: 0, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
    return parseRugcheckSummary(json);
  }
}
