// Track record: the bot grades its own calls, losers included.
// Every analysis is an observation; after each horizon (1h/24h/7d) the outcome is fetched in batches from
// DexScreener (/tokens/v1, <= 30 addresses per call) and labelled ok / rugged / delisted.
// "Only tokens checked with this bot; not a promise of future results."
import { horizonMs } from './config.js';
import { fmtPrice, money, pctText, shortAddr } from './format.js';
import { getLogger } from './log.js';

const log = getLogger('tracker');
const DAY = 86_400_000;

/** Wilson 95% score interval for k successes out of n. n = 0 -> nulls. */
export function wilson(k, n, z = 1.96) {
  if (!n) return { p: null, lo: null, hi: null };
  const p = k / n;
  const den = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return { p, lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

/**
 * Pure outcome label.
 * no pair -> 'delisted' (reported separately, not counted as a rug);
 * liquidity < max(rugLiqUsd, 10% of the observed liquidity) -> 'rugged' (ret -100%: the money cannot come out);
 * otherwise 'ok' with the price return.
 */
export function labelOutcome(obs, market, { rugLiqUsd = 1000 } = {}) {
  if (!market) return { status: 'delisted', price: null, liquidityUsd: null, retPct: null };
  const liq = market.liquidityUsd ?? 0;
  const floor = Math.max(rugLiqUsd, 0.1 * (obs.liquidity_usd ?? obs.liquidityUsd ?? 0));
  if (liq < floor) return { status: 'rugged', price: market.priceUsd ?? null, liquidityUsd: liq, retPct: -100 };
  const p0 = obs.price;
  const p1 = market.priceUsd;
  if (!(p0 > 0) || !(p1 > 0)) return { status: 'no_data', price: p1 ?? null, liquidityUsd: liq, retPct: null };
  return { status: 'ok', price: p1, liquidityUsd: liq, retPct: (p1 / p0 - 1) * 100 };
}

/** Walk candles after an observation: stop first when both are inside one candle (as the backtest does). */
export function hitFromCandles(candles, { from, to, stopLoss, takeProfit }) {
  if (!stopLoss && !takeProfit) return null;
  for (const c of candles) {
    if (c.t < from || c.t > to) continue;
    if (stopLoss && c.l <= stopLoss) return 'sl';
    if (takeProfit && c.h >= takeProfit) return 'tp';
  }
  return 'none';
}

const median = (xs) => {
  const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/** Stats for one group of joined rows {verdict, ret_pct, status, hit}. */
export function groupStats(rows) {
  const n = rows.length;
  const rets = rows.map((r) => r.ret_pct).filter((x) => x !== null && x !== undefined);
  const fell = rows.filter((r) => r.ret_pct !== null && r.ret_pct !== undefined && r.ret_pct <= -50).length;
  const rugged = rows.filter((r) => r.status === 'rugged').length;
  const delisted = rows.filter((r) => r.status === 'delisted').length;
  const tpRows = rows.filter((r) => r.hit === 'tp' || r.hit === 'sl' || r.hit === 'none');
  return {
    n,
    median: median(rets),
    fell50: { k: fell, ...wilson(fell, n) },
    rugged: { k: rugged, p: n ? rugged / n : null },
    delisted: { k: delisted, p: n ? delisted / n : null },
    tpFirst: { k: tpRows.filter((r) => r.hit === 'tp').length, n: tpRows.length },
  };
}

/**
 * Per-verdict stats + the baseline (all observations). Losing calls are never filtered out.
 * @param {any[]} rows joined observation+outcome rows for ONE horizon
 */
export function summarize(rows, { horizon = '24h', window = 'all' } = {}) {
  const by = {};
  for (const v of ['BUY', 'WATCH', 'AVOID']) {
    const g = rows.filter((r) => r.verdict === v);
    if (g.length) by[v] = { ...groupStats(g), rows: g };
  }
  return { horizon, window, n: rows.length, byVerdict: by, baseline: groupStats(rows), synthetic: rows.some((r) => r.synthetic) };
}

const pct1 = (x) => (x === null || x === undefined ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`);
const share = (s) => (s.p === null ? 'n/a' : `${Math.round(s.p * 100)}%`);
const ci = (w) => (w.p === null ? 'n/a' : `${Math.round(w.p * 100)}% [${Math.round(w.lo * 100)}-${Math.round(w.hi * 100)}]`);

/** "We checked this 3 d ago: WATCH at $0.0012, now $0.0004 (-67%)." */
export function seenBeforeLine(obs, priceNow, now = Date.now()) {
  if (!obs) return null;
  const dt = now - obs.ts;
  const ago = dt < 3_600_000 ? `${Math.max(0, Math.round(dt / 60_000))} min` : dt < 2 * DAY ? `${Math.round(dt / 3_600_000)} h` : `${Math.round(dt / DAY)} d`;
  const ret = obs.price > 0 && priceNow > 0 ? ` (${pct1((priceNow / obs.price - 1) * 100).replace('.0%', '%')})` : '';
  return `Seen before: we checked this ${ago} ago: ${obs.verdict} at ${fmtPrice(obs.price)}, now ${fmtPrice(priceNow)}${ret}.`;
}

/**
 * Plain-text /trackrecord.
 * @param {ReturnType<typeof summarize>} s
 * @param {{minN?: number, personal?: string|null, labelOf?: (row: any) => string}} [opts]
 */
export function formatTrackRecord(s, { minN = 20, personal = null, labelOf = (r) => r.symbol ?? shortAddr(r.address) } = {}) {
  const L = [`Track record (${s.horizon} after each check, window ${s.window})${s.synthetic ? ' (synthetic)' : ''}: n=${s.n}`];
  if (!s.n) L.push('No graded checks yet. Outcomes appear 1 h, 24 h and 7 d after a token is checked.');
  for (const [v, g] of Object.entries(s.byVerdict)) {
    let line = `${v.padEnd(5)} n=${g.n} · median ${pct1(g.median)} · fell >50%: ${ci(g.fell50)} · rugged ${share(g.rugged)} · delisted ${share(g.delisted)}`;
    if (v === 'BUY' && g.tpFirst.n) line += ` · hit target before stop ${g.tpFirst.k}/${g.tpFirst.n}`;
    L.push(line);
    if (g.n <= 8) {
      L.push(`      ${g.rows.map((r) => `${labelOf(r)} ${r.status === 'ok' ? pct1(r.ret_pct) : r.status}${r.hit && r.hit !== 'none' ? ` (${r.hit})` : ''}`).join(' · ')}`);
    }
  }
  const b = s.baseline;
  if (s.n) L.push(`ALL   n=${b.n} · median ${pct1(b.median)} · fell >50%: ${ci(b.fell50)} · rugged ${share(b.rugged)} (baseline: every token checked)`);
  if (s.n < minN) L.push(`small sample (n=${s.n} < ${minN}): treat these numbers as anecdotes.`);
  if (personal) L.push(personal);
  L.push('Only tokens checked with this bot; not a promise of future results. Losing calls are always included.');
  return L.join('\n');
}

/** "Tokens we flagged AVOID that you skipped and then fell more than 50%: 4. At your usual $50 that is about $140 not lost (estimate)." */
export function personalLine(rows7d, { sizeUsd = 50, hadPosition = () => false } = {}) {
  const avoided = rows7d.filter((r) => r.verdict === 'AVOID' && r.ret_pct !== null && r.ret_pct <= -50 && !hadPosition(r));
  if (!avoided.length) return null;
  const saved = avoided.reduce((s, r) => s + sizeUsd * Math.min(1, Math.abs(r.ret_pct) / 100), 0);
  return `Tokens we flagged AVOID that you skipped and then fell more than 50%: ${avoided.length}. At your usual ${money(sizeUsd)} that is about ${money(Math.round(saved))} not lost (estimate).`;
}

export const WINDOWS = { '7d': 7 * DAY, '30d': 30 * DAY, all: null };

export class Tracker {
  /**
   * @param {{storage: import('./storage.js').Storage, ds: any, cfg: any}} deps
   */
  constructor({ storage, ds, cfg }) {
    this.storage = storage;
    this.ds = ds;
    this.cfg = cfg;
  }

  get horizons() {
    return this.cfg.track.horizons.map((h) => ({ h, ms: horizonMs(h) }));
  }

  /**
   * Grade every observation whose horizon has passed. Idempotent (outcomes are keyed by observation+horizon).
   * @returns {Promise<{due: number, written: number, batchCalls: number, ohlcvCalls: number}>}
   */
  async runDue(now = Date.now()) {
    const due = this.storage.dueObservations(now, this.horizons, 30 * DAY);
    if (!due.length) return { due: 0, written: 0, batchCalls: 0, ohlcvCalls: 0 };
    const byChain = new Map();
    for (const d of due) {
      const set = byChain.get(d.chain) ?? new Set();
      set.add(d.address.toLowerCase());
      byChain.set(d.chain, set);
    }
    const markets = new Map();
    let batchCalls = 0;
    for (const [chain, set] of byChain) {
      const addrs = [...set];
      for (let i = 0; i < addrs.length; i += 30) {
        const chunk = addrs.slice(i, i + 30);
        batchCalls += 1;
        try {
          const got = await this.ds.getMarketsBatch(chain, chunk);
          for (const a of chunk) markets.set(`${chain}:${a}`, got.get(a) ?? null);
        } catch (err) {
          log.warn(`batch ${chain} (${chunk.length}) failed: ${err.message}`);
          for (const a of chunk) markets.set(`${chain}:${a}`, undefined); // unknown: retry next run
        }
      }
    }
    let written = 0;
    let ohlcvCalls = 0;
    const candleCache = new Map();
    for (const d of due) {
      const m = markets.get(`${d.chain}:${d.address.toLowerCase()}`);
      if (m === undefined) continue;
      const out = labelOutcome(d, m, { rugLiqUsd: this.cfg.track.rugLiqUsd });
      let hit = null;
      if (d.verdict === 'BUY' && d.horizon === '24h' && this.cfg.track.tpCheck && m && d.levels) {
        const lv = JSON.parse(d.levels);
        const key = d.address.toLowerCase();
        if (!candleCache.has(key) && ohlcvCalls < this.cfg.track.maxOhlcvPerRun) {
          ohlcvCalls += 1;
          candleCache.set(key, await this.ds.getOhlcv(m, '5m', 300).catch(() => []));
        }
        const candles = candleCache.get(key);
        if (candles) hit = hitFromCandles(candles, { from: d.ts, to: d.ts + DAY, stopLoss: lv.stopLoss, takeProfit: lv.takeProfit });
      }
      written += this.storage.insertOutcome({
        observationId: d.id, horizon: d.horizon, ts: now, price: out.price, liquidityUsd: out.liquidityUsd,
        retPct: out.retPct, status: out.status, hit,
      });
    }
    return { due: due.length, written, batchCalls, ohlcvCalls };
  }

  /** Track-record text for a window ('7d'|'30d'|'all'). */
  report({ window = 'all', horizon = '24h', now = Date.now(), sizeUsd = 50 } = {}) {
    const since = WINDOWS[window] ? now - WINDOWS[window] : 0;
    const rows = this.storage.outcomeRows({ horizon, since });
    const s = summarize(rows, { horizon, window });
    const rows7d = this.storage.outcomeRows({ horizon: '7d', since });
    const personal = personalLine(rows7d, {
      sizeUsd,
      hadPosition: (r) => this.storage.positionOpenedBetween(r.address, r.ts, r.ts + DAY),
    });
    const dup = new Map();
    for (const r of rows) dup.set(r.symbol, (dup.get(r.symbol) ?? new Set()).add(r.address));
    const labelOf = (r) => (dup.get(r.symbol)?.size > 1 ? `${r.symbol} (${shortAddr(r.address)})` : r.symbol ?? shortAddr(r.address));
    return { summary: s, text: formatTrackRecord(s, { minN: this.cfg.track.minN, personal, labelOf }) };
  }

  /** Deterministic synthetic history (mock DB only), labelled synthetic=1. */
  insertSynthetic(n, now = Date.now()) {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const verdicts = ['BUY', 'WATCH', 'AVOID'];
    for (let i = 0; i < n; i++) {
      const verdict = verdicts[i % 3];
      const ts = now - (8 + Math.floor(rnd() * 20)) * DAY;
      const id = this.storage.insertObservation({
        ts, address: `SYNTH${String(i).padStart(4, '0')}`, chain: 'solana', symbol: `SYN${i}`, verdict, light: null,
        riskScore: Math.round(rnd() * 100), hardAvoid: verdict === 'AVOID' ? 1 : 0, price: 1, liquidityUsd: 50_000,
        levels: null, features: { synthetic: true }, source: 'synthetic', synthetic: 1,
      });
      for (const h of this.horizons) {
        const r = rnd();
        const rug = verdict === 'AVOID' ? r < 0.35 : verdict === 'WATCH' ? r < 0.12 : r < 0.05;
        const ret = rug ? -100 : (rnd() - (verdict === 'BUY' ? 0.45 : 0.55)) * 120;
        this.storage.insertOutcome({
          observationId: id, horizon: h.h, ts: now, price: rug ? 0 : 1 + ret / 100, liquidityUsd: rug ? 100 : 50_000,
          retPct: ret, status: rug ? 'rugged' : 'ok', hit: verdict === 'BUY' && h.h === '24h' ? (rnd() < 0.4 ? 'tp' : 'sl') : null,
        });
      }
    }
  }
}
