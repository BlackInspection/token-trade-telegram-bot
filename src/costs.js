// Exit Test: round-trip cost math. Pure, no I/O.
// Model: constant-product pool (x*y=k). It UNDERSTATES price impact on concentrated-liquidity pools
// (Uniswap v3, Orca whirlpools, Meteora DLMM), and a quote is not an execution. Every number built
// here is labelled as an estimate where it is shown to the user.

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const pct = (v) => clamp01((Number(v) || 0) / 100);

/** Constant-product price impact of swapping `size` USD into a pool with `liq` USD total liquidity. */
export function cpImpact(size, liq) {
  if (!(size > 0)) return 0;
  if (!(liq > 0)) return 1;
  return size / (liq / 2 + size);
}

/** Gas (network fee) per swap in USD for a chain. */
export function gasUsdFor(chain, gasUsd = {}) {
  const c = String(chain ?? '').toLowerCase();
  if (c in gasUsd) return gasUsd[c];
  return gasUsd.other ?? 0;
}

/**
 * Buy then sell immediately, everything in USD.
 * @returns {{sizeUsd: number, getBackUsd: number, lossUsd: number, lossPct: number, breakevenPct: number,
 *   buyImpactPct: number, sellImpactPct: number, method: string}}
 */
export function estimateRoundTrip({ sizeUsd, liquidityUsd, buyTaxPct = 0, sellTaxPct = 0, dexFeeBps = 30, networkFeeUsd = 0 }) {
  const fee = (dexFeeBps ?? 0) / 10_000;
  const bt = pct(buyTaxPct);
  const st = pct(sellTaxPct);
  const i1 = cpImpact(sizeUsd, liquidityUsd);
  const v = sizeUsd * (1 - fee) * (1 - bt) * (1 - i1);
  const i2 = cpImpact(v, liquidityUsd);
  const back = Math.max(0, v * (1 - i2) * (1 - st) * (1 - fee) - 2 * (networkFeeUsd ?? 0));
  const lossUsd = sizeUsd - back;
  return {
    sizeUsd,
    getBackUsd: back,
    lossUsd,
    lossPct: sizeUsd > 0 ? (lossUsd / sizeUsd) * 100 : 0,
    breakevenPct: back > 0 ? (sizeUsd / back - 1) * 100 : Infinity,
    buyImpactPct: i1 * 100,
    sellImpactPct: i2 * 100,
    method: 'estimate',
  };
}

/** Loss % of fees + taxes alone (no price impact, no gas). */
export function baseLossPct({ buyTaxPct = 0, sellTaxPct = 0, dexFeeBps = 30 }) {
  const fee = (dexFeeBps ?? 0) / 10_000;
  return (1 - (1 - fee) ** 2 * (1 - pct(buyTaxPct)) * (1 - pct(sellTaxPct))) * 100;
}

const LIQ_MIN = 100;
const LIQ_MAX = 1e12;

/**
 * Effective pool liquidity that makes the constant-product estimate reproduce a measured (quoted) loss.
 * Used to turn one quote into a whole size ladder. Bisection in log space.
 * @param {number} sizeUsd size the quote was taken at
 * @param {number} measuredLossPct quoted round-trip loss in %
 * @param {{buyTaxPct?: number, sellTaxPct?: number, dexFeeBps?: number, networkFeeUsd?: number}} taxes
 */
export function effectiveLiquidity(sizeUsd, measuredLossPct, taxes = {}) {
  const loss = (liq) => estimateRoundTrip({ sizeUsd, liquidityUsd: liq, ...taxes }).lossPct;
  if (loss(LIQ_MAX) >= measuredLossPct) return LIQ_MAX; // quote is no worse than fees+taxes: very deep pool
  if (loss(LIQ_MIN) <= measuredLossPct) return LIQ_MIN;
  let lo = Math.log(LIQ_MIN);
  let hi = Math.log(LIQ_MAX);
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (loss(Math.exp(mid)) > measuredLossPct) lo = mid;
    else hi = mid;
  }
  return Math.exp((lo + hi) / 2);
}

/**
 * Turn one quoted round trip into a model for other sizes. The quote's loss is split into a per-leg fee
 * (<= maxFeeBps) on top of constant-product impact at the pool's reported liquidity. If even the max fee cannot
 * explain the loss, the pool is thinner than reported and the liquidity is fitted instead; if the quote beats the
 * constant-product impact (concentrated liquidity), the liquidity is fitted with no fee.
 * TODO(verify): a second quote at a larger size would calibrate impact directly (costs 2 more API calls).
 * @returns {{liquidityUsd: number, feeBps: number}}
 */
export function fitQuote(sizeUsd, lossPct, { liquidityUsd = 0, buyTaxPct = 0, sellTaxPct = 0, maxFeeBps = 30 } = {}) {
  const est = (liq, fee) => estimateRoundTrip({ sizeUsd, liquidityUsd: liq, buyTaxPct, sellTaxPct, dexFeeBps: fee }).lossPct;
  if (liquidityUsd > 0 && lossPct >= est(liquidityUsd, 0)) {
    if (est(liquidityUsd, maxFeeBps) >= lossPct) {
      let lo = 0;
      let hi = maxFeeBps;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (est(liquidityUsd, mid) < lossPct) lo = mid;
        else hi = mid;
      }
      return { liquidityUsd, feeBps: (lo + hi) / 2 };
    }
    return { liquidityUsd: effectiveLiquidity(sizeUsd, lossPct, { buyTaxPct, sellTaxPct, dexFeeBps: maxFeeBps }), feeBps: maxFeeBps };
  }
  return { liquidityUsd: effectiveLiquidity(sizeUsd, lossPct, { buyTaxPct, sellTaxPct, dexFeeBps: 0 }), feeBps: 0 };
}

/**
 * Largest buy size whose round trip stays under `limitPct`.
 * Loss falls with size at first (fixed gas) and then rises (price impact), so we scan for the
 * last size that meets the limit and bisect between it and the first one that breaks it.
 * @returns {{usd: number|null, reason: 'ok'|'cap'|'taxes'|'fees', baseLossPct: number}}
 */
export function maxSafeSize(limitPct, params) {
  const base = baseLossPct(params);
  if (base >= limitPct) return { usd: null, reason: 'taxes', baseLossPct: base };
  const loss = (s) => estimateRoundTrip({ ...params, sizeUsd: s }).lossPct;
  const MAX = 1e7;
  let ok = null;
  let s = 1;
  while (s <= MAX) {
    if (loss(s) <= limitPct) ok = s;
    else if (ok !== null) break;
    s *= 1.25;
  }
  if (ok === null) return { usd: null, reason: 'fees', baseLossPct: base };
  if (s > MAX) return { usd: loss(MAX) <= limitPct ? MAX : ok, reason: loss(MAX) <= limitPct ? 'cap' : 'ok', baseLossPct: base };
  let lo = ok;
  let hi = s;
  for (let i = 0; i < 100 && hi / lo > 1.0001; i++) {
    const mid = (lo + hi) / 2;
    if (loss(mid) <= limitPct) lo = mid;
    else hi = mid;
  }
  return { usd: lo, reason: 'ok', baseLossPct: base };
}

/**
 * Cost gate: an automatic entry must aim for at least `mult` x the round-trip loss.
 * @returns {{ok: boolean, reason: string}}
 */
export function costGate({ tpPct, lossPct, mult = 3 }) {
  if (tpPct === null || tpPct === undefined || lossPct === null || lossPct === undefined || !Number.isFinite(lossPct)) {
    return { ok: true, reason: 'no target to compare with the round trip' };
  }
  const need = lossPct * mult;
  if (tpPct >= need) {
    return { ok: true, reason: `target +${tpPct.toFixed(1)}% covers ${mult}x the ${lossPct.toFixed(1)}% round trip` };
  }
  return { ok: false, reason: `target +${tpPct.toFixed(1)}% barely covers a ${lossPct.toFixed(1)}% round trip (needs ${mult}x = +${need.toFixed(1)}%)` };
}

const TF_MIN = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '12h': 720, '1d': 1440 };

/**
 * Advisory only (never blocks): the typical candle move is too small for the round-trip cost.
 * Candle range is assumed to grow with sqrt(time).
 * @returns {string|null}
 */
export function atrHint({ atrPct, lossPct, timeframe, mult = 3 }) {
  if (!(atrPct > 0) || !(lossPct > 0)) return null;
  if (atrPct * mult >= lossPct) return null;
  const cur = TF_MIN[timeframe];
  const head = `price moves ~${atrPct.toFixed(1)}% per ${timeframe} candle but a round trip costs ${lossPct.toFixed(1)}%`;
  if (!cur) return head;
  for (const tf of ['15m', '1h', '4h', '1d']) {
    if (TF_MIN[tf] <= cur) continue;
    if (atrPct * Math.sqrt(TF_MIN[tf] / cur) * mult >= lossPct) return `${head}; ${tf} fits better`;
  }
  return `${head}; even 1d candles move less than the cost`;
}

/** Net USD edge if the target is hit: what you get back at TP after round-trip costs, minus what you put in. */
export function netEdgeAtTarget({ sizeUsd, tpPct, lossPct }) {
  if (tpPct === null || tpPct === undefined || lossPct === null || lossPct === undefined) return null;
  const usd = sizeUsd * (1 + tpPct / 100) * (1 - lossPct / 100) - sizeUsd;
  return { usd, pct: (usd / sizeUsd) * 100 };
}

export const METHOD_LABEL = {
  jupiter: 'Jupiter quote',
  kyber: 'KyberSwap quote',
  '0x': '0x quote',
  estimate: 'estimate from pool size',
  'estimate (mock)': 'pool-size estimate, mock data',
};

/**
 * Build the costs block of an analysis from market + security + an optional quote/round-trip result.
 * @param {{market: any, security: any, sizeUsd: number, p: any, quote?: {getBackUsd: number, lossPct: number,
 *   sellRoute?: boolean|null, method: string, rawLossPct?: number}|null}} args
 */
export function buildCosts({ market, security, sizeUsd, p, quote = null }) {
  const buyTaxPct = security?.buyTaxPct ?? 0;
  const sellTaxPct = security?.sellTaxPct ?? 0;
  const taxesKnown = security?.buyTaxPct !== null && security?.buyTaxPct !== undefined
    && security?.sellTaxPct !== null && security?.sellTaxPct !== undefined;
  const networkFeeUsd = gasUsdFor(market?.chain, p.gasUsd);
  const liq = market?.liquidityUsd ?? 0;
  const dexFeeBps = p.dexFeeBps ?? 30;
  const isQuote = quote && !String(quote.method).startsWith('estimate');
  let getBackUsd;
  let effLiq;
  let fitFeeBps;
  if (isQuote) {
    // A quote already contains pool fees and real impact; gas is added on top (quotes exclude it).
    getBackUsd = Math.max(0, quote.getBackUsd - 2 * networkFeeUsd);
    const quotedLoss = quote.rawLossPct ?? ((sizeUsd - quote.getBackUsd) / sizeUsd) * 100;
    const fit = fitQuote(sizeUsd, quotedLoss, { liquidityUsd: liq, buyTaxPct, sellTaxPct, maxFeeBps: dexFeeBps });
    fitFeeBps = fit.feeBps;
    effLiq = fit.liquidityUsd;
  } else {
    const est = estimateRoundTrip({ sizeUsd, liquidityUsd: liq, buyTaxPct, sellTaxPct, dexFeeBps, networkFeeUsd });
    getBackUsd = est.getBackUsd;
    effLiq = liq;
    fitFeeBps = dexFeeBps;
  }
  if (quote?.sellRoute === false) getBackUsd = 0; // no route back: nothing comes out
  const lossUsd = sizeUsd - getBackUsd;
  const lossPct = sizeUsd > 0 ? (lossUsd / sizeUsd) * 100 : 0;
  const safeLimitPct = p.safeRoundtripPct ?? 3;
  const safe = maxSafeSize(safeLimitPct, { liquidityUsd: effLiq, buyTaxPct, sellTaxPct, dexFeeBps: fitFeeBps, networkFeeUsd });
  // Impact the paper executor should use for this size (instead of a flat SLIPPAGE_BPS).
  const fill = estimateRoundTrip({ sizeUsd, liquidityUsd: effLiq, buyTaxPct, sellTaxPct, dexFeeBps: fitFeeBps });
  return {
    sizeUsd,
    getBackUsd,
    lossUsd,
    lossPct,
    breakevenPct: getBackUsd > 0 ? (sizeUsd / getBackUsd - 1) * 100 : Infinity,
    maxSafeUsd: safe.usd,
    maxSafeReason: safe.reason,
    baseLossPct: safe.baseLossPct,
    safeLimitPct,
    method: quote?.method ?? 'estimate',
    sellRoute: quote ? (quote.sellRoute ?? null) : null,
    buyTaxPct,
    sellTaxPct,
    taxesKnown,
    networkFeeUsd,
    effLiquidityUsd: effLiq,
    feeBps: fitFeeBps,
    buyImpactPct: fill.buyImpactPct,
    sellImpactPct: fill.sellImpactPct,
  };
}

/** Round trip at another size, reusing the effective liquidity of a costs block (for the /cost ladder). */
export function costsAtSize(costs, sizeUsd) {
  return estimateRoundTrip({
    sizeUsd, liquidityUsd: costs.effLiquidityUsd, buyTaxPct: costs.buyTaxPct, sellTaxPct: costs.sellTaxPct,
    dexFeeBps: costs.feeBps, networkFeeUsd: costs.networkFeeUsd,
  });
}

/** Paper-fill impact for one leg at a given USD size (percent). */
export function legImpactPct(costs, usd) {
  if (!costs?.effLiquidityUsd) return null;
  return cpImpact(usd, costs.effLiquidityUsd) * 100;
}
