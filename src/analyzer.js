// Token analysis: market + security + technicals -> risk score, verdict, levels, report.
import { computeTechnicals } from './technicals.js';
import { computeLevels } from './risk.js';
import { normalizeChain, detectAddressKind } from './chains.js';
import { fmtAge, fmtNum, fmtPct, fmtPrice, fmtUsd, shortAddr, yesNo } from './format.js';
import { atrHint, buildCosts, costGate, netEdgeAtTarget } from './costs.js';
import { costSentence, coverage, disagreements, trafficLight } from './explain.js';
import { identityLine } from './data/identity.js';

/** Points per 1% of the larger of buy/sell tax (capped at RISK_WEIGHTS.buyTax / sellTax). */
export const TAX_POINTS_PER_PCT = 2;

/**
 * Risk points per finding. Tune here. Score is capped at 100 (higher = riskier).
 * Every key is also a stable reason code (explain.js has a plain-language template for each).
 */
export const RISK_WEIGHTS = {
  noSecurityData: 25,
  cannotSellAll: 30,
  buyTax: 30, // cap; TAX_POINTS_PER_PCT per 1% of the larger tax
  sellTax: 30, // cap
  mintable: 15,
  hiddenOwner: 15,
  takeBackOwnership: 15,
  ownerChangeBalance: 20,
  selfDestruct: 15,
  externalCall: 5,
  taxModifiable: 15,
  personalTaxModifiable: 10,
  transferPausable: 8,
  tradingCooldown: 5,
  ownerNotRenounced: 5,
  proxy: 10,
  blacklist: 8,
  closedSource: 20,
  honeypotSameCreator: 15,
  freezable: 15,
  balanceMutable: 25,
  closable: 10,
  transferHook: 15,
  metadataMutable: 2,
  topHoldersHigh: 15, // top-10 holders > 50%
  topHoldersMid: 8, // > 30%
  creatorHeavy: 10, // creator/owner holds > 5%
  lpUnlockedYoung: 15, // < 50% LP locked and pair younger than 7d
  lowLiquidity: 10, // liquidity < 2x MIN_LIQUIDITY_USD
  veryYoungPair: 15, // < 24h
  youngPair: 8, // < 72h
  lowVolume: 8, // 24h volume < $10k
  sellPressure: 5, // 1h sells > 3x buys
  crash24h: 10, // 24h change < -50%
  fewHolders: 10, // < 100 holders
  roundTripHigh: 8, // round trip at POSITION_SIZE_USD loses more than ROUND_TRIP_WARN_PCT (default 5%)
};

/**
 * @param {import('./data/dexscreener.js').MarketData|null} market
 * @param {import('./data/goplus.js').SecurityReport|null} sec
 * @param {any} p cfg.analysis
 * @param {typeof RISK_WEIGHTS} [W]
 * @param {any} [costs] analysis costs block (Exit Test), optional
 * @returns {{score: number, reasons: {code: string, text: string, points: number, data: any}[], hardAvoid: boolean,
 *   hardReasons: string[], hard: {code: string, text: string, data: any}[]}}
 */
export function scoreRisk(market, sec, p, W = RISK_WEIGHTS, costs = null) {
  const reasons = [];
  const hard = [];
  const add = (cond, code, points, text, data = {}) => {
    if (cond) reasons.push({ code, text, points, data });
  };
  const hardAdd = (code, text, data = {}) => hard.push({ code, text, data });
  const done = (score) => {
    const hardAvoid = hard.length > 0;
    return { score: hardAvoid ? Math.max(score, 100) : score, reasons, hardAvoid, hardReasons: hard.map((h) => h.text), hard };
  };

  if (!market) {
    hardAdd('noPair', 'no DEX pair found');
    return done(100);
  }

  // --- security ---
  if (!sec || sec.sources.length === 0) {
    add(true, 'noSecurityData', W.noSecurityData, 'security data unavailable');
  } else {
    if (sec.isHoneypot === true) hardAdd('honeypot', `honeypot detected (${sec.sources.join('+')})`, { sources: sec.sources.length });
    if (sec.cannotBuy === true) hardAdd('cannotBuy', 'token cannot be bought');
    if (sec.nonTransferable === true) hardAdd('nonTransferable', 'token is non-transferable');
    if (sec.defaultFrozen === true) hardAdd('defaultFrozen', 'new token accounts are frozen by default');
    if (sec.sellTaxPct !== null && sec.sellTaxPct > p.maxSellTaxPct) {
      hardAdd('sellTaxOverLimit', `sell tax ${sec.sellTaxPct.toFixed(1)}% > limit ${p.maxSellTaxPct}%`, { sellTaxPct: sec.sellTaxPct, taxPct: sec.sellTaxPct, limitPct: p.maxSellTaxPct });
    }
    if (sec.buyTaxPct !== null && sec.buyTaxPct > p.maxBuyTaxPct) {
      hardAdd('buyTaxOverLimit', `buy tax ${sec.buyTaxPct.toFixed(1)}% > limit ${p.maxBuyTaxPct}%`, { buyTaxPct: sec.buyTaxPct, taxPct: sec.buyTaxPct, limitPct: p.maxBuyTaxPct });
    }
    const bt = sec.buyTaxPct ?? 0;
    const st = sec.sellTaxPct ?? 0;
    const tax = Math.max(bt, st);
    const taxCode = st >= bt ? 'sellTax' : 'buyTax';
    add(tax > 0, taxCode, Math.min(W[taxCode], Math.round(tax * TAX_POINTS_PER_PCT)), `tax ${tax.toFixed(1)}%`, { buyTaxPct: bt, sellTaxPct: st, taxPct: tax });
    add(sec.cannotSellAll === true, 'cannotSellAll', W.cannotSellAll, 'cannot sell all tokens at once');
    add(sec.isMintable === true, 'mintable', W.mintable, 'mintable supply');
    add(sec.hiddenOwner === true, 'hiddenOwner', W.hiddenOwner, 'hidden owner');
    add(sec.canTakeBackOwnership === true, 'takeBackOwnership', W.takeBackOwnership, 'ownership can be reclaimed');
    add(sec.ownerChangeBalance === true, 'ownerChangeBalance', W.ownerChangeBalance, 'owner can change balances');
    add(sec.selfDestruct === true, 'selfDestruct', W.selfDestruct, 'selfdestruct present');
    add(sec.externalCall === true, 'externalCall', W.externalCall, 'external calls in transfer');
    add(sec.taxModifiable === true, 'taxModifiable', W.taxModifiable, 'tax is modifiable');
    add(sec.personalTaxModifiable === true, 'personalTaxModifiable', W.personalTaxModifiable, 'per-address tax modifiable');
    add(sec.transferPausable === true, 'transferPausable', W.transferPausable, 'transfers can be paused');
    add(sec.tradingCooldown === true, 'tradingCooldown', W.tradingCooldown, 'trading cooldown');
    add(sec.kind === 'evm' && sec.ownerRenounced === false, 'ownerNotRenounced', W.ownerNotRenounced, 'ownership not renounced');
    add(sec.isProxy === true, 'proxy', W.proxy, 'upgradeable proxy');
    add(sec.hasBlacklist === true, 'blacklist', W.blacklist, 'blacklist function');
    add(sec.isOpenSource === false, 'closedSource', W.closedSource, 'contract not verified');
    add(sec.honeypotSameCreator === true, 'honeypotSameCreator', W.honeypotSameCreator, 'creator deployed honeypots before');
    add(sec.freezable === true, 'freezable', W.freezable, 'freeze authority set');
    add(sec.balanceMutable === true, 'balanceMutable', W.balanceMutable, 'balances mutable by authority');
    add(sec.closable === true, 'closable', W.closable, 'mint is closable');
    add(sec.transferHook === true, 'transferHook', W.transferHook, 'transfer hook set');
    add(sec.metadataMutable === true, 'metadataMutable', W.metadataMutable, 'metadata mutable');
    if (sec.top10Pct !== null) {
      if (sec.top10Pct > 50) add(true, 'topHoldersHigh', W.topHoldersHigh, `top-10 holders own ${sec.top10Pct.toFixed(0)}%`, { top10Pct: sec.top10Pct });
      else if (sec.top10Pct > 30) add(true, 'topHoldersMid', W.topHoldersMid, `top-10 holders own ${sec.top10Pct.toFixed(0)}%`, { top10Pct: sec.top10Pct });
    }
    const insider = Math.max(sec.creatorPct ?? 0, sec.ownerPct ?? 0);
    add(insider > 5, 'creatorHeavy', W.creatorHeavy, `creator/owner holds ${insider.toFixed(1)}%`, { insiderPct: insider });
    add(
      sec.lpLockedPct !== null && sec.lpLockedPct < 50 && (market.pairAgeHours ?? 0) < 24 * 7,
      'lpUnlockedYoung',
      W.lpUnlockedYoung,
      `only ${sec.lpLockedPct?.toFixed(0)}% LP locked on a young pair`,
      { lpLockedPct: sec.lpLockedPct ?? 0, ageHours: market.pairAgeHours ?? 0 },
    );
    add(sec.holderCount !== null && sec.holderCount < 100, 'fewHolders', W.fewHolders, `only ${sec.holderCount} holders`, { holders: sec.holderCount ?? 0 });
  }

  // --- market ---
  const liq = market.liquidityUsd ?? 0;
  if (liq < p.minLiquidityUsd) hardAdd('lowLiquidityHard', `liquidity ${fmtUsd(liq)} < min ${fmtUsd(p.minLiquidityUsd)}`, { liquidityUsd: liq, minUsd: p.minLiquidityUsd });
  else add(liq < p.minLiquidityUsd * 2, 'lowLiquidity', W.lowLiquidity, `thin liquidity ${fmtUsd(liq)}`, { liquidityUsd: liq });
  const age = market.pairAgeHours;
  if (age !== null) {
    if (age < 24) add(true, 'veryYoungPair', W.veryYoungPair, `pair is ${fmtAge(age)} old`, { ageHours: age });
    else if (age < 72) add(true, 'youngPair', W.youngPair, `pair is ${fmtAge(age)} old`, { ageHours: age });
  }
  add((market.volume.h24 ?? 0) < 10_000, 'lowVolume', W.lowVolume, `24h volume ${fmtUsd(market.volume.h24 ?? 0)}`, { volume24h: market.volume.h24 ?? 0 });
  const h1 = market.txns.h1;
  add(h1.buys + h1.sells >= 20 && h1.sells > 3 * Math.max(1, h1.buys), 'sellPressure', W.sellPressure, `1h sells ${h1.sells} vs buys ${h1.buys}`, { sells: h1.sells, buys: h1.buys });
  add((market.priceChange.h24 ?? 0) < -50, 'crash24h', W.crash24h, `24h change ${fmtPct(market.priceChange.h24)}`, { changePct: market.priceChange.h24 ?? 0 });

  // --- round-trip costs (Exit Test) ---
  if (costs) {
    const data = { lossPct: costs.lossPct, sizeUsd: costs.sizeUsd, getBackUsd: costs.getBackUsd };
    if (costs.sellRoute === false) hardAdd('noSellRoute', 'no route to sell this token back');
    if (costs.lossPct > (p.maxRoundtripPct ?? 15)) {
      hardAdd('roundTripTooHigh', `round trip ${costs.lossPct.toFixed(1)}% at $${costs.sizeUsd} > limit ${p.maxRoundtripPct}%`, { ...data, limitPct: p.maxRoundtripPct });
    }
    add(costs.lossPct > (p.roundTripWarnPct ?? 5), 'roundTripHigh', W.roundTripHigh, `round trip costs ${costs.lossPct.toFixed(1)}% at $${costs.sizeUsd}`, data);
  }

  return done(Math.min(100, reasons.reduce((s, r) => s + r.points, 0)));
}

/**
 * Verdict. Hard rule: honeypot / tax over limit / no liquidity / no sell route => AVOID regardless of TA.
 * Caps (BUY -> WATCH): a possible copycat of a well-known token, a failed cost gate, a net profit at target
 * below MIN_NET_PROFIT_*. The cap is returned so the engine can skip automatic buys with the right reason.
 * @param {{gate?: {ok: boolean, reason: string}|null, identity?: any, netEdge?: {usd: number, pct: number}|null,
 *   costs?: any}} [ctx]
 * @returns {{verdict: 'BUY'|'WATCH'|'AVOID', why: string, cap?: {code: string, suite: string, text: string, data: any}}}
 */
export function decideVerdict(risk, ta, p, ctx = {}) {
  if (risk.hardAvoid) return { verdict: 'AVOID', why: risk.hardReasons.join('; ') };
  if (risk.score >= p.avoidRisk) return { verdict: 'AVOID', why: `risk score ${risk.score} >= ${p.avoidRisk}` };
  const id = ctx.identity;
  const cloneCap = id?.status === 'possible_clone' && id.original
    ? { code: 'possibleClone', suite: 'POSSIBLE_CLONE', text: `possible copycat of ${id.original.symbol} ${shortAddr(id.original.address)}`, data: { ...id.original } }
    : null;
  if (ta?.ok && ta.signal === 'bullish') {
    if (risk.score <= p.maxBuyRisk) {
      if (cloneCap) return { verdict: 'WATCH', why: cloneCap.text, cap: cloneCap };
      if (ctx.gate && !ctx.gate.ok) {
        return {
          verdict: 'WATCH', why: `cost gate: ${ctx.gate.reason}`,
          cap: { code: 'costGate', suite: 'FEES_EAT_PROFIT', text: ctx.gate.reason, data: { tpPct: ctx.gate.tpPct, lossPct: ctx.gate.lossPct } },
        };
      }
      const ne = ctx.netEdge;
      if (ne && ((p.minNetProfitUsd > 0 && ne.usd < p.minNetProfitUsd) || (p.minNetProfitPct > 0 && ne.pct < p.minNetProfitPct))) {
        const text = `net profit at target ${ne.usd >= 0 ? '+' : '-'}$${Math.abs(ne.usd).toFixed(2)} (${ne.pct.toFixed(1)}%) is below the minimum`;
        return { verdict: 'WATCH', why: text, cap: { code: 'netProfitLow', suite: 'FEES_EAT_PROFIT', text, data: { netUsd: ne.usd, netPct: ne.pct } } };
      }
      return { verdict: 'BUY', why: ta.reasons.slice(0, 2).join('; ') };
    }
    return { verdict: 'WATCH', why: `bullish setup but risk ${risk.score} > ${p.maxBuyRisk}` };
  }
  if (cloneCap) return { verdict: 'WATCH', why: cloneCap.text, cap: cloneCap };
  if (!ta?.ok) return { verdict: 'WATCH', why: `no TA: ${ta?.reason ?? 'no candles'}` };
  return { verdict: 'WATCH', why: ta.reasons[0] ?? `TA ${ta.signal}` };
}

/**
 * Entry gates for AUTOMATIC buys that do not depend on the TA signal. decideVerdict sets its caps only on a bullish
 * setup, while the strategy can emit BUY on a bar where the analyzer's TA is not bullish (or the risk limit was
 * tightened since): every automatic buy checks these on its own.
 * @param {any} a analysis
 * @param {any} p current cfg.analysis (tuned settings included)
 * @returns {{code: string, suite: string, text: string, data: any}|null} the first block, or null
 */
export function entryBlock(a, p) {
  if (a.verdict?.cap) return a.verdict.cap;
  const id = a.identity;
  if (id?.status === 'possible_clone' && id.original) {
    return { code: 'possibleClone', suite: 'POSSIBLE_CLONE', text: `possible copycat of ${id.original.symbol} ${shortAddr(id.original.address)}`, data: { ...id.original } };
  }
  // A lookup that failed (not a data source without the check) leaves the copycat question open: no automatic buy.
  if (id?.status === 'unknown' && id.error) {
    return { code: 'identityUnknown', suite: 'IDENTITY_UNKNOWN', text: `could not check whether this is the well-known ${a.market?.token?.symbol ?? 'token'} (${id.error})`, data: {} };
  }
  if (a.risk && a.risk.score > p.maxBuyRisk) {
    return { code: 'riskHigh', suite: 'RISK_SCORE_HIGH', text: `risk ${a.risk.score} > max ${p.maxBuyRisk}`, data: { score: a.risk.score, max: p.maxBuyRisk } };
  }
  const gate = a.costs?.gate;
  if (gate && gate.ok === false) {
    return { code: 'costGate', suite: 'FEES_EAT_PROFIT', text: gate.reason, data: { tpPct: gate.tpPct, lossPct: gate.lossPct } };
  }
  const ne = a.costs?.netEdge;
  if (ne && ((p.minNetProfitUsd > 0 && ne.usd < p.minNetProfitUsd) || (p.minNetProfitPct > 0 && ne.pct < p.minNetProfitPct))) {
    const text = `net profit at target ${ne.usd >= 0 ? '+' : '-'}$${Math.abs(ne.usd).toFixed(2)} (${ne.pct.toFixed(1)}%) is below the minimum`;
    return { code: 'netProfitLow', suite: 'FEES_EAT_PROFIT', text, data: { netUsd: ne.usd, netPct: ne.pct } };
  }
  return null;
}

/**
 * Full analysis of one token.
 * @param {import('./data/index.js').DataSource} ds
 * @param {string} address
 * @param {{chain?: string|null, timeframe?: string, limit?: number, p: any, sizeUsd?: number,
 *   securityMaxAgeMs?: number, allowQuote?: boolean, now?: number}} opts
 *   allowQuote: real round-trip quotes only on analyze, /buy, /cost and for open positions (never every tick).
 */
export async function analyzeToken(ds, address, { chain = null, timeframe, limit, p, sizeUsd, securityMaxAgeMs, allowQuote = true, now } = {}) {
  const errors = [];
  const tf = timeframe ?? p.timeframe;
  const at = now ?? Date.now();
  const market = await ds.getMarket(address, normalizeChain(chain));
  if (!market) {
    const risk = scoreRisk(null, null, p);
    const a = {
      address, chain: normalizeChain(chain), kind: detectAddressKind(address), timeframe: tf, at,
      market: null, security: null, candles: [], ta: { ok: false, reason: 'no market', signal: 'neutral', reasons: [], candles: 0 },
      risk, verdict: decideVerdict(risk, null, p), levels: null, costs: null,
      identity: { status: 'unknown', coingeckoId: null, verified: null }, errors: [`no DEX pairs found${chain ? ` on ${chain}` : ''}`],
    };
    a.coverage = coverage(a);
    a.disagreements = [];
    a.light = trafficLight(a, p);
    return a;
  }
  const [secRes, candlesRes, idRes] = await Promise.allSettled([
    securityMaxAgeMs !== undefined ? ds.getSecurity(market, { maxAgeMs: securityMaxAgeMs }) : ds.getSecurity(market),
    ds.getOhlcv(market, tf, limit ?? p.ohlcvLimit),
    ds.getIdentity ? ds.getIdentity(market) : Promise.resolve({ status: 'unknown', coingeckoId: null, verified: null }),
  ]);
  const security = secRes.status === 'fulfilled' ? secRes.value : null;
  if (secRes.status === 'rejected') errors.push(`security: ${secRes.reason?.message ?? secRes.reason}`);
  if (security?.errors?.length) errors.push(...security.errors);
  const candles = candlesRes.status === 'fulfilled' ? candlesRes.value : [];
  if (candlesRes.status === 'rejected') errors.push(`ohlcv: ${candlesRes.reason?.message ?? candlesRes.reason}`);
  const identity = idRes.status === 'fulfilled' && idRes.value ? idRes.value
    : { status: 'unknown', coingeckoId: null, verified: null, ...(idRes.status === 'rejected' ? { error: String(idRes.reason?.message ?? idRes.reason) } : {}) };

  const size = sizeUsd ?? p.sizeUsd ?? 50;
  let quote = null;
  if (ds.getRoundTrip) {
    try {
      quote = await ds.getRoundTrip(market, size, security, { allowQuote });
    } catch (err) {
      errors.push(`quote: ${err.message}`);
    }
  }
  const costs = buildCosts({ market, security, sizeUsd: size, p, quote });

  const ta = computeTechnicals(candles, p);
  const risk = scoreRisk(market, security, p, RISK_WEIGHTS, costs);
  const price = market.priceUsd ?? ta.close ?? null;
  const rawLevels = computeLevels(price, ta.ok ? ta.atr : null, p);
  const gate = { ...costGate({ tpPct: rawLevels?.tpPct ?? null, lossPct: costs.lossPct, mult: p.costGateMult ?? 3 }), tpPct: rawLevels?.tpPct ?? null, lossPct: costs.lossPct };
  const netEdge = netEdgeAtTarget({ sizeUsd: size, tpPct: rawLevels?.tpPct ?? null, lossPct: costs.lossPct });
  costs.gate = gate;
  costs.netEdge = netEdge;
  costs.atrHint = ta.ok && !risk.hardAvoid ? atrHint({ atrPct: ta.atrPct, lossPct: costs.lossPct, timeframe: tf, mult: p.costGateMult ?? 3 }) : null;
  const verdict = decideVerdict(risk, ta, p, { gate, identity, netEdge, costs });
  const levels = verdict.verdict === 'AVOID' ? null : rawLevels;
  const a = {
    address: market.token.address, chain: market.chain, kind: detectAddressKind(market.token.address),
    timeframe: tf, at, market, security, candles, ta, risk, verdict, levels, costs, identity, errors,
  };
  a.coverage = coverage(a);
  a.disagreements = disagreements(a);
  a.light = trafficLight(a, p);
  return a;
}

/** Plain-text report (Telegram + CLI). */
export function formatAnalysis(a) {
  const L = [];
  const m = a.market;
  if (!m) {
    L.push(`Token ${a.address}`);
    L.push(`VERDICT: ${a.verdict.verdict} - ${a.verdict.why}`);
    if (a.errors.length) L.push(`Notes: ${a.errors.join('; ')}`);
    return L.join('\n');
  }
  const pc = m.priceChange;
  L.push(`${m.token.symbol} / ${m.quote.symbol} · ${m.chain} · ${m.dexId}${m.labels.length ? ` ${m.labels.join(',')}` : ''}`);
  L.push(m.token.address);
  L.push(`Price: ${fmtPrice(m.priceUsd)}  (5m ${fmtPct(pc.m5)} | 1h ${fmtPct(pc.h1)} | 24h ${fmtPct(pc.h24)})`);
  L.push(`Liquidity: ${fmtUsd(m.liquidityUsd)}  FDV: ${fmtUsd(m.fdv)}  MCap: ${fmtUsd(m.marketCap)}`);
  L.push(`Volume: 5m ${fmtUsd(m.volume.m5)} | 1h ${fmtUsd(m.volume.h1)} | 24h ${fmtUsd(m.volume.h24)}`);
  L.push(`Txns 1h: ${m.txns.h1.buys} buys / ${m.txns.h1.sells} sells · 24h: ${m.txns.h24.buys} / ${m.txns.h24.sells}`);
  L.push(`Pair age: ${fmtAge(m.pairAgeHours)} · pair ${shortAddr(m.pairAddress)}`);

  const s = a.security;
  if (s && s.sources.length) {
    const tax = `${s.buyTaxPct === null ? '?' : s.buyTaxPct.toFixed(1)}%/${s.sellTaxPct === null ? '?' : s.sellTaxPct.toFixed(1)}%`;
    const parts = [`honeypot ${yesNo(s.isHoneypot)}`, `tax buy/sell ${tax}`, `mintable ${yesNo(s.isMintable)}`];
    if (s.kind === 'evm') {
      parts.push(`proxy ${yesNo(s.isProxy)}`, `blacklist ${yesNo(s.hasBlacklist)}`, `owner renounced ${yesNo(s.ownerRenounced)}`);
      parts.push(`LP locked ${s.lpLockedPct === null ? '?' : `${s.lpLockedPct.toFixed(0)}%`}`);
    } else {
      // Solana: GoPlus leaves the LP lock empty; RugCheck fills it when reachable.
      parts.push(`freezable ${yesNo(s.freezable)}`, `LP locked ${s.lpLockedPct === null || s.lpLockedPct === undefined ? '?' : `${s.lpLockedPct.toFixed(0)}%`}`);
    }
    parts.push(`top10 ${s.top10Pct === null ? '?' : `${s.top10Pct.toFixed(0)}%`}`, `holders ${s.holderCount ?? '?'}`);
    L.push(`Security (${s.sources.join('+')}): ${parts.join(' · ')}`);
  } else {
    L.push('Security: unavailable');
  }

  L.push(`Risk: ${a.risk.score}/100${a.risk.hardAvoid ? ' (HARD AVOID)' : ''}`);
  for (const r of a.risk.hardReasons) L.push(`  ! ${r}`);
  for (const r of [...a.risk.reasons].sort((x, y) => y.points - x.points).slice(0, 8)) L.push(`  - ${r.text} (+${r.points})`);

  const t = a.ta;
  if (t.ok) {
    L.push(
      `TA (${a.timeframe}, ${t.candles} candles): trend ${t.trend.toUpperCase()} · ` +
        `EMA ${t.emaFast > t.emaSlow ? 'fast > slow' : 'fast < slow'} · RSI ${fmtNum(t.rsi, 1)} · MACD ${t.momentum}` +
        ` · ATR ${fmtNum(t.atrPct, 2)}% · vol x${fmtNum(t.volSpike, 1)}`,
    );
    L.push(`Signal: ${t.signal}${t.reasons.length ? ` (${t.reasons.join('; ')})` : ''}`);
  } else {
    L.push(`TA: n/a (${t.reason})`);
  }
  const cost = costSentence(a.costs);
  if (cost) L.push(cost);
  if (a.costs?.atrHint) L.push(`Cost check: ${a.costs.atrHint} (advisory).`);
  if (a.costs) L.push('Costs are estimates: constant-product math understates impact on concentrated pools, and a quote is not an execution.');
  L.push(identityLine(a.identity, m, a.at));
  if (a.seenBefore) L.push(a.seenBefore);
  L.push(`VERDICT: ${a.verdict.verdict} - ${a.verdict.why}`);
  if (a.levels) {
    const lv = a.levels;
    L.push(
      `Entry ~${fmtPrice(lv.entry)} · SL ${fmtPrice(lv.stopLoss)} (${fmtPct(lv.slPct, 1)})` +
        (lv.takeProfit ? ` · TP ${fmtPrice(lv.takeProfit)} (${fmtPct(lv.tpPct, 1)}) · TP2 ${fmtPrice(lv.takeProfit2)}` : ''),
    );
  }
  if (a.errors.length) L.push(`Notes: ${a.errors.join('; ')}`);
  if (m.url) L.push(m.url);
  return L.join('\n');
}
