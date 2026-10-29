// "Is this the real one?" - token identity check against copycats of well-known tickers.
//   listed:         GeckoTerminal token info has coingecko_coin_id, or (Solana) Jupiter marks the mint verified/strict.
//   possible_clone: another token with the same ticker/name is listed, or is >30 days older with >=5x the liquidity.
//   unlisted:       neutral ("Not on CoinGecko yet, normal for new tokens").
//   unknown:        a lookup failed (the token's own info, the search or a candidate's info); counts as a missing
//                   check in coverage, is never cached, and blocks automatic buys until a check works.
// Ranking is listed first, then oldest pair - never by liquidity alone (a research run found an Ethereum 'BONK'
// pool reporting more liquidity than the real BONK).
import { chainInfo } from '../chains.js';
import { shortAddr } from '../format.js';

const DAY = 86_400_000;

/** Lowercase, strip $ and every non-alphanumeric. */
export const normSymbol = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Candidate originals from DexScreener search pairs: same normalized symbol or name, different address.
 * Pairs are grouped per (chain, address): earliest pair creation and the largest liquidity.
 */
export function candidatesFrom(pairs, market) {
  const sym = normSymbol(market.token.symbol);
  const name = normSymbol(market.token.name);
  const self = String(market.token.address).toLowerCase();
  const by = new Map();
  for (const p of pairs ?? []) {
    const t = p?.baseToken;
    if (!t?.address || String(t.address).toLowerCase() === self) continue;
    const same = (sym && normSymbol(t.symbol) === sym) || (name && normSymbol(t.name) === name);
    if (!same) continue;
    const key = `${p.chainId}:${String(t.address).toLowerCase()}`;
    const liq = Number(p?.liquidity?.usd) || 0;
    const created = Number(p?.pairCreatedAt) || null;
    const cur = by.get(key);
    if (!cur) {
      by.set(key, { chain: p.chainId, address: t.address, symbol: t.symbol, name: t.name, pairCreatedAt: created, liquidityUsd: liq, listed: null });
    } else {
      cur.liquidityUsd = Math.max(cur.liquidityUsd, liq);
      if (created && (!cur.pairCreatedAt || created < cur.pairCreatedAt)) cur.pairCreatedAt = created;
    }
  }
  return [...by.values()];
}

/** Listed first, then oldest pair; liquidity only breaks exact ties. */
export function rankCandidates(cands) {
  return [...cands].sort((a, b) => {
    const la = a.listed === true ? 1 : 0;
    const lb = b.listed === true ? 1 : 0;
    if (la !== lb) return lb - la;
    const ta = a.pairCreatedAt ?? Infinity;
    const tb = b.pairCreatedAt ?? Infinity;
    if (ta !== tb) return ta - tb;
    return (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0);
  });
}

/**
 * Decide the identity status from the best candidate.
 * @returns {{status: 'unlisted'|'possible_clone', original?: any}}
 */
export function judgeClone(market, ranked, now = Date.now()) {
  const best = ranked[0];
  if (!best) return { status: 'unlisted' };
  const ourCreated = market.pairCreatedAt ?? now;
  const older = best.pairCreatedAt ? ourCreated - best.pairCreatedAt > 30 * DAY : false;
  const richer = (best.liquidityUsd ?? 0) >= 5 * (market.liquidityUsd ?? 0);
  if (best.listed === true || (older && richer)) {
    return {
      status: 'possible_clone',
      original: {
        chain: best.chain, address: best.address, symbol: best.symbol, liquidityUsd: best.liquidityUsd,
        ageDays: best.pairCreatedAt ? (now - best.pairCreatedAt) / DAY : null,
      },
    };
  }
  return { status: 'unlisted' };
}

/**
 * @typedef {{status: 'listed'|'unlisted'|'possible_clone'|'unknown', coingeckoId: string|null, verified: boolean|null,
 *   original?: {chain: string, address: string, symbol: string, ageDays: number|null, liquidityUsd: number}, error?: string}} Identity
 *
 * @param {{getTokenInfo(chain: string, address: string): Promise<{coingeckoId: string|null}|null>,
 *   jupiterVerified?(mint: string): Promise<boolean|null>, searchPairs(q: string): Promise<any[]>}} src
 * @returns {Promise<Identity>}
 */
export async function resolveIdentity(src, market, { now = Date.now(), maxInfoCalls = 3 } = {}) {
  try {
    // getTokenInfo returns null for a token GeckoTerminal does not know (not listed); it throws on a failed lookup
    // (429, 5xx, network). A failed lookup is 'unknown', never 'not listed' (that would fail open on a copycat).
    let infoErr = null;
    const info = await src.getTokenInfo(market.chain, market.token.address).catch((err) => {
      infoErr = err;
      return null;
    });
    let verified = null;
    if (chainInfo(market.chain)?.kind === 'solana' && src.jupiterVerified) {
      verified = await src.jupiterVerified(market.token.address).catch(() => null);
    }
    if (info?.coingeckoId || verified === true) {
      return { status: 'listed', coingeckoId: info?.coingeckoId ?? null, verified };
    }
    if (infoErr) return { status: 'unknown', coingeckoId: null, verified, error: `token info: ${infoErr.message ?? infoErr}` };
    const pairs = await src.searchPairs(market.token.symbol);
    const cands = candidatesFrom(pairs, market);
    // Pre-rank by age (cheap) and look up listing for at most the top N.
    const pre = rankCandidates(cands).slice(0, maxInfoCalls);
    let lookupErr = null;
    for (const c of pre) {
      try {
        const ci = await src.getTokenInfo(c.chain, c.address);
        c.listed = !!ci?.coingeckoId;
      } catch (err) {
        c.listed = null; // unknown, not "not listed"
        lookupErr ??= err;
      }
    }
    const verdict = judgeClone(market, rankCandidates(pre), now);
    const out = { status: verdict.status, coingeckoId: info?.coingeckoId ?? null, verified, ...(verdict.original ? { original: verdict.original } : {}) };
    // Older-and-richer already proves a possible clone; otherwise a failed candidate lookup leaves it open.
    if (lookupErr && verdict.status !== 'possible_clone') {
      return { status: 'unknown', coingeckoId: out.coingeckoId, verified, error: `candidate lookup: ${lookupErr.message ?? lookupErr}` };
    }
    return out;
  } catch (err) {
    return { status: 'unknown', coingeckoId: null, verified: null, error: err.message };
  }
}

/** One plain-language line about identity. */
export function identityLine(id, market, now = Date.now()) {
  if (!id || id.status === 'unknown') return 'Identity: could not check if this is the well-known token (treated as missing).';
  if (id.status === 'listed') return `Listed${id.coingeckoId ? ` on CoinGecko (${id.coingeckoId})` : ''}${id.verified ? ' · verified on Jupiter' : ''}.`;
  if (id.status === 'unlisted') return 'Not on CoinGecko yet, normal for new tokens.';
  const o = id.original;
  const ours = market?.pairAgeHours;
  const theirAge = o.ageDays === null || o.ageDays === undefined ? 'age unknown' : o.ageDays >= 2 ? `${Math.round(o.ageDays)} days old` : `${Math.round(o.ageDays * 24)} hours old`;
  const ourAge = ours === null || ours === undefined ? '' : ours >= 48 ? ` This one is ${Math.round(ours / 24)} days old.` : ` This one is ${Math.max(1, Math.round(ours))} hours old.`;
  void now;
  return `Possible copycat: the well-known ${o.symbol} is ${shortAddr(o.address)} (${o.chain}, ${theirAge}).${ourAge}`;
}
