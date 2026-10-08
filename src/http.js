// Small fetch wrapper: JSON, timeout, retries on 429/5xx/network errors.
import { getLogger } from './log.js';

const log = getLogger('http');

export class HttpError extends Error {
  constructor(message, { status = 0, url = '', body = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} url
 * @param {{method?: string, headers?: Record<string,string>, body?: any, query?: Record<string, any>,
 *          timeoutMs?: number, retries?: number, fetchImpl?: typeof fetch}} [opts]
 *   fetchImpl: inject a fetch (tests use a stub; nothing leaves the process).
 */
export async function fetchJson(url, { method = 'GET', headers = {}, body, query, timeoutMs = 15000, retries = 2, fetchImpl = globalThis.fetch } = {}) {
  const u = new URL(url);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    }
  }
  const short = `${method} ${u.host}${u.pathname}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetchImpl(u, {
        method,
        headers: {
          accept: 'application/json',
          'user-agent': 'crypto-trading-bot/0.1 (+node)',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastErr = new HttpError(`${short} failed: ${err?.cause?.code || err?.name || ''} ${err?.message || err}`.trim(), { url: u.href });
      if (attempt < retries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw lastErr;
    }
    if (res.status === 429 || res.status >= 500) {
      const text = await res.text().catch(() => '');
      lastErr = new HttpError(`${short} -> HTTP ${res.status}: ${text.slice(0, 200)}`, { status: res.status, url: u.href, body: text });
      if (attempt < retries) {
        const ra = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30000) : 1000 * 2 ** attempt;
        log.debug(`${short} -> ${res.status}, retry in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw lastErr;
    }
    const text = await res.text();
    if (!res.ok) {
      throw new HttpError(`${short} -> HTTP ${res.status}: ${text.slice(0, 300)}`, { status: res.status, url: u.href, body: text });
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new HttpError(`${short} returned non-JSON: ${text.slice(0, 200)}`, { status: res.status, url: u.href, body: text });
    }
  }
  throw lastErr;
}
