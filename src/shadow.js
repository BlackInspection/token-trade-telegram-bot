// Shadow-first rules: a newly watched token's auto-buy rule starts in state 'shadow'.
// When the engine would buy, it records a shadow fill instead of calling a live executor (practice still trades
// on paper). Each cycle shadow fills are marked to market NET of round-trip costs. After a trial period a
// hindsight card offers [Go live] [Keep testing 24h] [Delete]. 'live' is set only by promote().
import { money, pctText } from './format.js';

const H = 3_600_000;

/**
 * Net value of a shadow fill now: tokens x price, minus the sell-side costs (DEX fee, sell tax, price impact)
 * and gas. Always below the gross value when any cost is non-zero.
 */
export function markNet({ qty, priceNow, feeBps = 30, sellTaxPct = 0, sellImpactPct = 0, networkFeeUsd = 0 }) {
  const gross = qty * priceNow;
  const keep = (1 - feeBps / 10_000) * (1 - sellTaxPct / 100) * (1 - sellImpactPct / 100);
  return Math.max(0, gross * keep - networkFeeUsd);
}

/** Buy side of a fill: tokens received for sizeUsd after fee, buy tax and impact (and gas). */
export function entryFill({ sizeUsd, price, feeBps = 30, buyTaxPct = 0, buyImpactPct = 0, networkFeeUsd = 0 }) {
  const keep = (1 - feeBps / 10_000) * (1 - buyTaxPct / 100) * (1 - buyImpactPct / 100);
  const net = Math.max(0, sizeUsd - networkFeeUsd) * keep;
  return { qty: net / price, entryCosts: sizeUsd - net, executablePrice: keep > 0 ? price / keep : Infinity };
}

/** gain | loss | rugged (liquidity down more than 80% since the fill). */
export function outcomeOf({ netValue, sizeUsd, liqEntry, liqNow }) {
  if (liqEntry > 0 && liqNow !== null && liqNow !== undefined && liqNow < liqEntry * 0.2) return 'rugged';
  return netValue >= sizeUsd ? 'gain' : 'loss';
}

/** Is a hindsight card due for a rule? */
export function cardDue({ now, trialStart, matches, minHours, minMatches, maxHours }) {
  const hours = (now - trialStart) / H;
  if (matches < 1) return false;
  return (hours >= minHours && matches >= minMatches) || hours >= maxHours;
}

export const ruleIdFor = (address) => `watch:${String(address).toLowerCase()}`;

export class Shadow {
  /** @param {{storage: import('./storage.js').Storage, cfg: any, now?: () => number}} deps */
  constructor({ storage, cfg, now = () => Date.now() }) {
    this.storage = storage;
    this.cfg = cfg;
    this.now = now;
  }

  /** Record what the rule would have bought (never calls an executor). */
  record({ ruleId, a, sizeUsd, reasonCode = 'SHADOW_RULE' }) {
    const c = a.costs ?? {};
    const price = a.market?.priceUsd;
    if (!(price > 0)) return null;
    const f = entryFill({
      sizeUsd, price, feeBps: c.feeBps ?? 30, buyTaxPct: c.buyTaxPct ?? 0, buyImpactPct: c.buyImpactPct ?? 0, networkFeeUsd: c.networkFeeUsd ?? 0,
    });
    return this.storage.insertShadowFill({
      ruleId, subjectRef: a.address, ts: this.now(), entryPrice: price, entryCosts: f.entryCosts, executablePrice: f.executablePrice,
      meta: { sizeUsd, qty: f.qty, symbol: a.market.token.symbol, chain: a.chain, liqEntry: a.market.liquidityUsd, reasonCode },
    });
  }

  /** Revalue open shadow fills for the tokens analysed this cycle (net of round-trip costs). */
  markAll(analyses) {
    const byAddr = new Map(analyses.filter((a) => a?.market).map((a) => [a.address.toLowerCase(), a]));
    let n = 0;
    for (const f of this.storage.listShadowFills()) {
      const a = byAddr.get(String(f.subject_ref).toLowerCase());
      if (!a) continue;
      const meta = JSON.parse(f.meta ?? '{}');
      const c = a.costs ?? {};
      const net = markNet({
        qty: meta.qty, priceNow: a.market.priceUsd, feeBps: c.feeBps ?? 30, sellTaxPct: c.sellTaxPct ?? 0,
        sellImpactPct: c.sellImpactPct ?? 0, networkFeeUsd: c.networkFeeUsd ?? 0,
      });
      const outcome = outcomeOf({ netValue: net, sizeUsd: meta.sizeUsd, liqEntry: meta.liqEntry, liqNow: a.market.liquidityUsd });
      this.storage.updateShadowMark(f.id, { markPrice: a.market.priceUsd, markTs: this.now(), markSource: 'dexscreener', outcome, netValue: net });
      n += 1;
    }
    return n;
  }

  /** Summary of a rule's fills. */
  ruleStats(ruleId) {
    const fills = this.storage.listShadowFills({ ruleId });
    let spent = 0;
    let worth = 0;
    const rets = [];
    for (const f of fills) {
      const meta = JSON.parse(f.meta ?? '{}');
      const net = meta.netValue ?? meta.sizeUsd;
      spent += meta.sizeUsd;
      worth += net;
      rets.push((net / meta.sizeUsd - 1) * 100);
    }
    return { fills, n: fills.length, spent, worth, best: rets.length ? Math.max(...rets) : null, worst: rets.length ? Math.min(...rets) : null };
  }

  /** Rules whose hindsight card is due now. */
  dueCards() {
    const s = this.cfg.shadow;
    const out = [];
    for (const w of this.storage.listWatch()) {
      if (w.state !== 'shadow') continue;
      const ruleId = ruleIdFor(w.address);
      const trialStart = w.addedAt;
      const next = this.storage.getKv(`shadow_next:${ruleId}`, 0);
      if (next === -1 || this.now() < next) continue; // -1: card shown, waiting for the user's answer
      const st = this.ruleStats(ruleId);
      if (cardDue({ now: this.now(), trialStart, matches: st.n, minHours: s.minHours, minMatches: s.minMatches, maxHours: s.maxHours })) {
        out.push({ ruleId, watch: w, stats: st, hours: (this.now() - trialStart) / H });
      }
    }
    return out;
  }

  markCardSent(ruleId) {
    this.storage.setKv(`shadow_next:${ruleId}`, -1);
  }

  /** The hindsight card text (net of fees). */
  cardText({ watch, stats, hours }, { dryRun, verdictRecord = null } = {}) {
    const pct = stats.spent ? (stats.worth / stats.spent - 1) * 100 : 0;
    const L = [
      `Rule "auto-buy ${watch.symbol ?? watch.address}", ${Math.round(hours)}h trial: would have bought ${stats.n} for ${money(stats.spent)}; ` +
        `worth ${money(stats.worth)} net now (${pct >= 0 ? '+' : ''}${pctText(pct)}); best ${stats.best === null ? 'n/a' : `${stats.best >= 0 ? '+' : ''}${pctText(stats.best)}`}, ` +
        `worst ${stats.worst === null ? 'n/a' : `${stats.worst >= 0 ? '+' : ''}${pctText(stats.worst)}`}.`,
    ];
    if (verdictRecord) L.push(verdictRecord);
    L.push('Values are net of DEX fees, token taxes, price impact and gas (estimate).');
    if (dryRun) L.push('Go live changes this rule only: real buying also needs DRY_RUN=false in .env.');
    return L.join('\n');
  }

  /** The ONLY way a rule becomes live. */
  promote(ruleId) {
    const address = ruleId.replace(/^watch:/, '');
    this.storage.setWatchState(address, 'live', this.now());
    return address;
  }

  /** [Keep testing 24h]: the next card comes 24 h from now. */
  keepTesting(ruleId) {
    this.storage.setKv(`shadow_next:${ruleId}`, this.now() + 24 * H);
  }
}
