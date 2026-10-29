// Plain-language explanations. Pure (no I/O).
//  - TEMPLATES.en: reason code -> one money-terms sentence. Codes are the analyzer's risk codes (camelCase),
//    its hard codes, and the event reason codes (UPPER_CASE) this bot writes to the event log. English only.
//  - trafficLight / coverage / disagreements / formatCard: the verdict card (RED / YELLOW / GREEN).
//  - renderAlert: the one alert layout used by every notification (shared contract).
import { escapeHtml, fmtPrice, fmtUsd, htmlToText, money, pctText, shortAddr } from './format.js';
import { identityLine } from './data/identity.js';
import { METHOD_LABEL } from './costs.js';

const age = (h) => (h === null || h === undefined ? 'an unknown time' : h < 1 ? `${Math.max(1, Math.round(h * 60))} minutes` : h < 48 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`);
const size = (c) => c?.sizeUsd ?? 50;
const keep = (sz, lossPct) => sz * (1 - Math.min(100, Math.max(0, lossPct ?? 0)) / 100);

/** Hard (instant AVOID) reason codes produced by analyzer.scoreRisk. */
export const HARD_CODES = [
  'honeypot', 'cannotBuy', 'nonTransferable', 'defaultFrozen', 'sellTaxOverLimit', 'buyTaxOverLimit',
  'lowLiquidityHard', 'noPair', 'noSellRoute', 'roundTripTooHigh',
];

/**
 * Event reason codes this bot emits (machine-readable; text lives only in the templates), with their default severity.
 * Only codes this repo can produce are listed (the shared event format allows other bots their own codes).
 */
export const SUITE_CODES = {
  // shared event-format codes
  STALE_DATA: 'warn', FEES_EAT_PROFIT: 'bad', PRICE_ABOVE_MAX: 'bad', LIMIT_DAILY_BUDGET: 'warn', LIMIT_HOURLY: 'warn',
  LIMIT_EXPOSURE: 'warn', DRY_RUN: 'warn', PAUSED: 'warn', SHADOW_RULE: 'warn', MUTED: 'warn',
  // trading (repo-specific, agreed)
  HONEYPOT: 'bad', SELL_TAX_HIGH: 'bad', MINTABLE: 'bad', OWNER_CAN_CHANGE: 'bad', LP_UNLOCKED: 'bad',
  TOP10_CONCENTRATED: 'warn', LOW_LIQUIDITY: 'warn', EMA_CROSS_UP: 'good', RSI_OVERBOUGHT: 'warn', VOLUME_SPIKE: 'good',
  // repo-local extensions
  NO_SELL_ROUTE: 'bad', ROUND_TRIP_HIGH: 'warn', CONTRACT_RISK: 'warn', YOUNG_PAIR: 'warn', LOW_VOLUME: 'warn',
  SELL_PRESSURE: 'warn', PRICE_CRASH: 'warn', FEW_HOLDERS: 'warn', NO_SECURITY_DATA: 'warn', NO_PAIR: 'bad',
  POSSIBLE_CLONE: 'bad', RISK_SCORE_HIGH: 'bad', LOSS_BUDGET: 'warn', LOSS_STREAK: 'warn', REVENGE_BLOCK: 'warn',
  AVOID_ADD_ON: 'bad', PANIC: 'warn', LIMIT_DAILY_LOSS: 'warn', NOT_ENOUGH_CASH: 'warn', POSITION_OPEN: 'warn',
  CONFIRM_REQUIRED: 'warn', GUARDIAN_EXIT: 'bad', TAKE_PROFIT: 'good', STOP_LOSS: 'bad', TRAILING_STOP: 'warn',
  SIGNAL_EXIT: 'warn', MANUAL: 'good', NO_GOOD_SETUP: 'warn', CLEAN_CONTRACT: 'good', EXECUTOR_ERROR: 'bad',
  IDENTITY_UNKNOWN: 'warn', BALANCE_DROP: 'bad',
};

/** Analyzer risk code -> suite event code. */
export const RISK_TO_SUITE = {
  honeypot: 'HONEYPOT', cannotSellAll: 'HONEYPOT', cannotBuy: 'CONTRACT_RISK', nonTransferable: 'HONEYPOT', defaultFrozen: 'HONEYPOT',
  sellTax: 'SELL_TAX_HIGH', buyTax: 'SELL_TAX_HIGH', sellTaxOverLimit: 'SELL_TAX_HIGH', buyTaxOverLimit: 'SELL_TAX_HIGH',
  mintable: 'MINTABLE', hiddenOwner: 'OWNER_CAN_CHANGE', takeBackOwnership: 'OWNER_CAN_CHANGE', ownerChangeBalance: 'OWNER_CAN_CHANGE',
  taxModifiable: 'OWNER_CAN_CHANGE', personalTaxModifiable: 'OWNER_CAN_CHANGE', ownerNotRenounced: 'OWNER_CAN_CHANGE',
  proxy: 'OWNER_CAN_CHANGE', blacklist: 'OWNER_CAN_CHANGE', transferPausable: 'OWNER_CAN_CHANGE', freezable: 'OWNER_CAN_CHANGE',
  balanceMutable: 'OWNER_CAN_CHANGE', closedSource: 'CONTRACT_RISK', selfDestruct: 'CONTRACT_RISK', externalCall: 'CONTRACT_RISK',
  honeypotSameCreator: 'CONTRACT_RISK', closable: 'CONTRACT_RISK', transferHook: 'CONTRACT_RISK', metadataMutable: 'CONTRACT_RISK',
  tradingCooldown: 'CONTRACT_RISK', lpUnlockedYoung: 'LP_UNLOCKED', topHoldersHigh: 'TOP10_CONCENTRATED',
  topHoldersMid: 'TOP10_CONCENTRATED', creatorHeavy: 'TOP10_CONCENTRATED', lowLiquidity: 'LOW_LIQUIDITY',
  lowLiquidityHard: 'LOW_LIQUIDITY', veryYoungPair: 'YOUNG_PAIR', youngPair: 'YOUNG_PAIR', lowVolume: 'LOW_VOLUME',
  sellPressure: 'SELL_PRESSURE', crash24h: 'PRICE_CRASH', fewHolders: 'FEW_HOLDERS', noSecurityData: 'NO_SECURITY_DATA',
  roundTripHigh: 'ROUND_TRIP_HIGH', roundTripTooHigh: 'ROUND_TRIP_HIGH', noSellRoute: 'NO_SELL_ROUTE', noPair: 'NO_PAIR',
};

const taxSell = (d, c) => `Selling costs a ${pctText(d.sellTaxPct ?? d.taxPct)} tax: from ${money(size(c))} you would get back about ${money(keep(size(c), d.sellTaxPct ?? d.taxPct))} before any price move.`;
const taxBuy = (d, c) => `Buying costs a ${pctText(d.buyTaxPct ?? d.taxPct)} tax: of ${money(size(c))} only about ${money(keep(size(c), d.buyTaxPct ?? d.taxPct))} turns into tokens.`;
const roundTrip = (d, c) => `Buying ${money(d.sizeUsd ?? size(c))} and selling right away gives back about ${money(d.getBackUsd)}: ${pctText(d.lossPct)} lost to fees, taxes and price impact.`;

export const TEMPLATES = {
  en: {
    // ---- analyzer risk codes (RISK_WEIGHTS keys) ----
    noSecurityData: () => 'We could not check the contract. Unknown is treated as risky.',
    cannotSellAll: () => 'You may not be able to sell all your tokens at once; part of your money could get stuck.',
    buyTax: taxBuy,
    sellTax: taxSell,
    mintable: () => 'The creator can create new tokens, which makes yours worth less.',
    hiddenOwner: () => 'A hidden owner can change the rules without you seeing it.',
    takeBackOwnership: () => 'The creator can take back control of the contract after giving it up.',
    ownerChangeBalance: () => 'The owner can change wallet balances, including yours.',
    selfDestruct: () => 'The contract can delete itself; your tokens would be worth nothing.',
    externalCall: () => 'Transfers call other contracts, which can be used to block or tax sells.',
    taxModifiable: () => 'The creator can raise the tax at any time, even after you buy.',
    personalTaxModifiable: () => 'The creator can set a special tax for single wallets, including yours.',
    transferPausable: () => 'The creator can pause all transfers, so you could not sell for a while.',
    tradingCooldown: () => 'There is a waiting time between trades, so you may not be able to sell quickly.',
    ownerNotRenounced: () => 'The creator still controls the contract and can change it.',
    proxy: () => 'The contract code can be replaced at any time (upgradeable).',
    blacklist: () => 'The creator can block wallets from selling.',
    closedSource: () => 'The contract code is not published, so nobody can check what it does.',
    honeypotSameCreator: () => 'The same creator made tokens before that could not be sold.',
    freezable: () => 'The creator can freeze your tokens so you cannot move or sell them.',
    balanceMutable: () => 'The creator can change balances, including yours.',
    closable: () => 'The creator can close the token account.',
    transferHook: () => 'Every transfer runs custom code that can block or tax it.',
    metadataMutable: () => 'The name and logo can still be changed by the creator.',
    topHoldersHigh: (d) => `The 10 biggest wallets own ${pctText(d.top10Pct, 0)}; one of them selling can crash the price.`,
    topHoldersMid: (d) => `The 10 biggest wallets own ${pctText(d.top10Pct, 0)}; a few big sellers can move the price a lot.`,
    creatorHeavy: (d, c) => `The creator holds ${pctText(d.insiderPct)} of the supply; if they sell, your ${money(size(c))} can drop fast.`,
    lpUnlockedYoung: () => 'The money in the trading pool is not locked; the creators can pull it out and the price would collapse.',
    lowLiquidity: (d) => `The trading pool is small (${fmtUsd(d.liquidityUsd)}); bigger sells move the price against you.`,
    veryYoungPair: (d) => `It started trading ${age(d.ageHours)} ago; most scams fail in the first day.`,
    youngPair: (d) => `It is only ${age(d.ageHours)} old; there is little history to judge it.`,
    lowVolume: (d) => `Only ${fmtUsd(d.volume24h)} traded in 24 hours; it may be hard to sell at a fair price.`,
    sellPressure: (d) => `Sellers outnumber buyers ${d.sells ?? '?'} to ${d.buys ?? '?'} in the last hour.`,
    crash24h: (d) => `The price fell ${pctText(Math.abs(d.changePct ?? 0), 0)} in 24 hours.`,
    fewHolders: (d) => `Only ${d.holders ?? '?'} wallets hold it; a few people control the price.`,
    roundTripHigh: roundTrip,
    // ---- hard codes ----
    honeypot: () => 'You can buy this token but you cannot sell it.',
    cannotBuy: () => 'This token cannot be bought right now.',
    nonTransferable: () => 'This token cannot be moved or sold once you hold it.',
    defaultFrozen: () => 'New holders start frozen: you could not move or sell what you buy.',
    sellTaxOverLimit: taxSell,
    buyTaxOverLimit: taxBuy,
    lowLiquidityHard: (d) => `The trading pool holds only ${fmtUsd(d.liquidityUsd)}; too little to get your money back out.`,
    noPair: () => 'We found no trading pool for this address.',
    noSellRoute: () => 'No route to sell this token back: you could not get your money out.',
    roundTripTooHigh: (d, c) => `Buying ${money(d.sizeUsd ?? size(c))} and selling right away gives back only about ${money(d.getBackUsd)} (${pctText(d.lossPct)} lost).`,
    // ---- verdict caps ----
    possibleClone: (d) => `Possible copycat of ${d.symbol ?? 'a well-known token'}${d.address ? ` ${shortAddr(d.address)}` : ''}; the bot will not auto-buy it.`,
    costGate: (d) => `The target (+${pctText(d.tpPct)}) barely covers the ${pctText(d.lossPct)} round trip, so the bot will not auto-buy.`,
    netProfitLow: (d) => `At the target you would make only ${money(d.netUsd)} net, below your minimum.`,
    unlisted: () => 'Not on CoinGecko yet, normal for new tokens.',
    // ---- suite event codes ----
    STALE_DATA: (p) => `Market data is ${p.ageSec ?? '?'} s old; waiting for fresh data.`,
    FEES_EAT_PROFIT: (p) => `Fees eat the profit: target +${pctText(p.tpPct)} vs a ${pctText(p.lossPct)} round trip.`,
    PRICE_ABOVE_MAX: (p) => `Size ${money(p.usd)} is above the per-trade limit ${money(p.max)}.`,
    LIMIT_DAILY_BUDGET: (p) => `Daily budget used: ${money(p.spent)} of ${money(p.budget)} (resets 00:00 UTC).`,
    LIMIT_HOURLY: (p) => `Hourly cap reached: ${p.count ?? '?'} of ${p.max ?? '?'} buys in the last hour.`,
    LIMIT_EXPOSURE: (p) => `Already ${p.open ?? '?'} open positions (max ${p.max ?? '?'}).`,
    DRY_RUN: () => 'DRY_RUN=true: nothing real was bought.',
    PAUSED: () => 'Trading is paused.',
    SHADOW_RULE: () => 'Shadow rule: recorded what it would have bought; nothing was spent.',
    MUTED: () => 'Muted by you.',
    HONEYPOT: () => 'You can buy this token but you cannot sell it.',
    SELL_TAX_HIGH: (p) => `Token tax: buy ${pctText(p.buyTaxPct ?? 0)} / sell ${pctText(p.sellTaxPct ?? 0)}.`,
    MINTABLE: () => 'The creator can create new tokens.',
    OWNER_CAN_CHANGE: () => 'The creator can still change the contract rules.',
    LP_UNLOCKED: () => 'Pool money is not locked.',
    TOP10_CONCENTRATED: (p) => `Top wallets own ${pctText(p.top10Pct ?? p.insiderPct ?? 0, 0)}.`,
    LOW_LIQUIDITY: (p) => `Small trading pool (${fmtUsd(p.liquidityUsd)}).`,
    EMA_CROSS_UP: (p) => `Uptrend just started (fast average crossed above slow${p.barsAgo === undefined ? '' : p.barsAgo === 0 ? ' on the last bar' : `, ${p.barsAgo} bar(s) ago`}).`,
    RSI_OVERBOUGHT: (p) => `Overbought (RSI ${p.rsi ?? '?'}).`,
    VOLUME_SPIKE: (p) => `Trading volume x${p.mult ?? '?'} above normal.`,
    NO_SELL_ROUTE: () => 'No route to sell it back.',
    ROUND_TRIP_HIGH: (p) => `Round trip costs ${pctText(p.lossPct)} at ${money(p.sizeUsd)}.`,
    CONTRACT_RISK: () => 'Risky contract feature.',
    YOUNG_PAIR: (p) => `Only ${age(p.ageHours)} old.`,
    LOW_VOLUME: (p) => `Low 24h volume (${fmtUsd(p.volume24h)}).`,
    SELL_PRESSURE: () => 'More sellers than buyers.',
    PRICE_CRASH: () => 'Price crashed in the last 24 hours.',
    FEW_HOLDERS: (p) => `Only ${p.holders ?? '?'} holders.`,
    NO_SECURITY_DATA: () => 'Contract could not be checked.',
    NO_PAIR: () => 'No trading pool found.',
    POSSIBLE_CLONE: () => 'Possible copycat of a well-known token.',
    RISK_SCORE_HIGH: (p) => `Risk score ${p.score ?? '?'} is above the buy limit ${p.max ?? '?'}.`,
    LOSS_BUDGET: (p) => `Monthly loss budget used up: ${p.lostUsd === undefined ? 'lost all' : `lost ${money(p.lostUsd)}`} of a ${money(p.budgetUsd)} budget.`,
    LOSS_STREAK: (p) => `Paused after ${p.streak ?? '?'} losses in a row.`,
    REVENGE_BLOCK: () => 'Recently stopped out on this token; no revenge trade.',
    AVOID_ADD_ON: () => 'Not adding to a token rated AVOID.',
    PANIC: () => 'Panic stop is on: all buying is stopped.',
    LIMIT_DAILY_LOSS: (p) => `Daily loss limit hit (${money(p.pnlUsd)}).`,
    NOT_ENOUGH_CASH: () => 'Not enough practice cash.',
    POSITION_OPEN: () => 'A position is already open.',
    CONFIRM_REQUIRED: (p) => `Above ${money(p.above)}: needs your confirmation.`,
    GUARDIAN_EXIT: (p) => `Guardian exit: ${p.type ?? 'danger'}.`,
    TAKE_PROFIT: () => 'Target reached.',
    STOP_LOSS: () => 'Stop-loss hit.',
    TRAILING_STOP: () => 'Trailing stop hit.',
    SIGNAL_EXIT: () => 'Trend turned down.',
    MANUAL: () => 'Your own decision.',
    NO_GOOD_SETUP: () => 'No clear entry right now.',
    CLEAN_CONTRACT: () => 'No known red flags (not a guarantee).',
    EXECUTOR_ERROR: () => 'The swap failed.',
    IDENTITY_UNKNOWN: () => 'Could not check whether this is the well-known token; no automatic buy until the check works.',
    BALANCE_DROP: (p) => `The hot wallet lost ${p.unexplainedUsd === undefined ? 'money' : money(p.unexplainedUsd)}${p.pct === undefined ? '' : ` (${p.pct}%)`} that the bot's own trades do not explain; check the wallet before resuming.`,
  },
};

/** Templates for a language (falls back to English). */
export const templatesFor = (lang = 'en') => TEMPLATES[lang] ?? TEMPLATES.en;

/** One sentence for a code. Unknown codes render as the code itself (never 'undefined'). */
export function sentence(code, data = {}, ctx = {}, lang = 'en') {
  const t = templatesFor(lang)[code] ?? TEMPLATES.en[code];
  if (!t) return String(code);
  try {
    return t(data ?? {}, ctx);
  } catch {
    return String(code);
  }
}

// ------------------------------------------------------------------ coverage / light

/** The checks behind "Checked 12/12". Null always counts as missing, never as a pass. */
export function coverage(a) {
  const s = a.security;
  const m = a.market;
  const known = (v) => v !== null && v !== undefined;
  const sellSim = known(s?.honeypotIs?.isHoneypot) || (a.costs?.sellRoute === true || a.costs?.sellRoute === false);
  const evm = (s?.kind ?? a.kind) !== 'solana';
  const checks = [
    ['sell simulation', sellSim],
    ['buy tax', known(s?.buyTaxPct)],
    ['sell tax', known(s?.sellTaxPct)],
    ['mint', known(s?.isMintable)],
    evm ? ['owner powers', known(s?.isProxy) && known(s?.ownerRenounced)] : ['freeze authority', known(s?.freezable) && known(s?.balanceMutable)],
    ['LP lock', known(s?.lpLockedPct)],
    ['top holders', known(s?.top10Pct)],
    ['holders', known(s?.holderCount)],
    ['liquidity', known(m?.liquidityUsd)],
    ['pair age', known(m?.pairAgeHours)],
    ['candles', !!a.ta?.ok],
    ['identity', !!a.identity && a.identity.status !== 'unknown'],
  ];
  const missing = checks.filter(([, ok]) => !ok).map(([n]) => n);
  return { checked: checks.length - missing.length, total: checks.length, missing };
}

/** Sources that contradict each other. Any disagreement is treated as risky. */
export function disagreements(a) {
  const out = [];
  const s = a.security;
  const g = s?.goplusView;
  const hp = s?.honeypotIs;
  if (g && hp) {
    if (hp.isHoneypot === false && (g.cannotSellAll === true || g.isHoneypot === true)) out.push('Sources disagree on selling (honeypot.is could sell, GoPlus says not); treated as risky');
    if (g.buyTaxPct !== null && g.buyTaxPct !== undefined && hp.buyTaxPct !== null && hp.buyTaxPct !== undefined && Math.abs(g.buyTaxPct - hp.buyTaxPct) > 5) {
      out.push(`Sources disagree on buy tax (GoPlus ${pctText(g.buyTaxPct)}, honeypot.is ${pctText(hp.buyTaxPct)}); treated as risky`);
    }
    if (g.sellTaxPct !== null && g.sellTaxPct !== undefined && hp.sellTaxPct !== null && hp.sellTaxPct !== undefined && Math.abs(g.sellTaxPct - hp.sellTaxPct) > 5) {
      out.push(`Sources disagree on sell tax (GoPlus ${pctText(g.sellTaxPct)}, honeypot.is ${pctText(hp.sellTaxPct)}); treated as risky`);
    }
  }
  if (a.costs?.sellRoute === true && s?.isHoneypot === true) out.push('Sources disagree on selling (a sell route exists, the simulation says honeypot); treated as risky');
  return out;
}

export const LIGHT_ACTION = { RED: "Don't buy", YELLOW: 'Be careful', GREEN: 'No known red flags (not a guarantee)' };

/** @returns {{color: 'RED'|'YELLOW'|'GREEN', action: string, why: string[]}} */
export function trafficLight(a, p) {
  const r = a.risk;
  if (r.hardAvoid || r.score >= p.avoidRisk) {
    return { color: 'RED', action: LIGHT_ACTION.RED, why: [r.hardAvoid ? 'hard rule' : `risk ${r.score} >= ${p.avoidRisk}`] };
  }
  const why = [];
  const cov = a.coverage ?? coverage(a);
  const dis = a.disagreements ?? disagreements(a);
  if (r.score > (p.lightGreenMax ?? 20)) why.push(`risk ${r.score} > ${p.lightGreenMax ?? 20}`);
  if (cov.checked / cov.total < 0.8) why.push(`only ${cov.checked}/${cov.total} checks`);
  if (a.identity?.status === 'possible_clone') why.push('possible copycat');
  if (dis.length) why.push('sources disagree');
  if (why.length) return { color: 'YELLOW', action: LIGHT_ACTION.YELLOW, why };
  return { color: 'GREEN', action: LIGHT_ACTION.GREEN, why: [] };
}

// ------------------------------------------------------------------ cost line

const HARD_TWIN = { sellTax: 'sellTaxOverLimit', buyTax: 'buyTaxOverLimit', lowLiquidity: 'lowLiquidityHard', roundTripHigh: 'roundTripTooHigh' };

/** Top reasons as sentences: hard first, then by points; soft twins of shown hard reasons are skipped. */
export function topReasons(a, n = 3, lang = 'en') {
  const ctx = { sizeUsd: a.costs?.sizeUsd ?? 50 };
  const hard = (a.risk.hard ?? []).map((h) => ({ code: h.code, data: h.data }));
  const hardCodes = new Set(hard.map((h) => h.code));
  const soft = [...(a.risk.reasons ?? [])]
    .filter((r) => !(HARD_TWIN[r.code] && hardCodes.has(HARD_TWIN[r.code])))
    .sort((x, y) => y.points - x.points);
  const out = [...hard, ...soft].slice(0, n).map((r) => sentence(r.code, r.data, ctx, lang));
  if (out.length < n && a.verdict?.cap) out.push(sentence(a.verdict.cap.code, a.verdict.cap.data, ctx, lang));
  return out.slice(0, n);
}

const wholeUsd = (v) => (v >= 1e7 ? 'over $10,000,000' : `$${Math.floor(v).toLocaleString('en-US')}`);

/** "If you buy $50 and sell right away ..." (long) or the compact card line. */
export function costSentence(costs, { compact = false } = {}) {
  if (!costs) return null;
  const label = METHOD_LABEL[costs.method] ?? costs.method;
  const back = `$${costs.getBackUsd.toFixed(2)}`;
  const loss = `-${pctText(costs.lossPct)}`;
  const be = Number.isFinite(costs.breakevenPct) ? `+${pctText(costs.breakevenPct)}` : 'never (nothing comes back)';
  let safe;
  if (costs.sellRoute === false) safe = 'no route to sell it back';
  else if (costs.maxSafeUsd === null && costs.maxSafeReason === 'taxes') {
    safe = `no buy size keeps the round trip under ${pctText(costs.safeLimitPct)}: the ${pctText(costs.buyTaxPct)}+${pctText(costs.sellTaxPct)} token tax alone is ~${pctText(costs.buyTaxPct + costs.sellTaxPct, 0)}`;
  } else if (costs.maxSafeUsd === null) safe = `no buy size keeps the round trip under ${pctText(costs.safeLimitPct)} (network fees)`;
  else safe = `${compact ? 'largest buy under' : 'Largest buy under'} ${pctText(costs.safeLimitPct)} round trip: ${wholeUsd(costs.maxSafeUsd)}`;
  if (compact) {
    return `Put in ${money(costs.sizeUsd)}, sell right away, get back ~${back} (${loss}) · break-even ${be} · ${safe} (${label})`;
  }
  const safeLong = safe.charAt(0).toUpperCase() + safe.slice(1);
  return `If you buy ${money(costs.sizeUsd)} and sell right away you get back ${back} (${loss}). Break-even: ${be}. ${safeLong} (${label}).`;
}

export function timingLine(ta) {
  if (!ta?.ok) return 'Timing: not enough price history';
  if (ta.signal === 'bullish') return ta.crossUpAgo !== null && ta.crossUpAgo !== undefined && ta.crossUpAgo <= 3 ? 'Timing: uptrend just started' : 'Timing: uptrend';
  if (ta.signal === 'bearish') return 'Timing: falling, no entry now';
  if (ta.trend === 'up') return 'Timing: uptrend already running, no fresh entry';
  return 'Timing: no clear entry right now';
}

/**
 * The verdict card (HTML). Kept <= 900 chars; the full report goes into an expandable blockquote after it.
 * @param {any} a analysis
 */
export function formatCard(a, { now = Date.now(), lang = 'en' } = {}) {
  const light = a.light ?? { color: 'RED', action: LIGHT_ACTION.RED };
  const m = a.market;
  const head = `<b>${light.color} · ${escapeHtml(light.action)}</b>${m ? ` · ${escapeHtml(m.token.symbol)} (${escapeHtml(m.chain)})` : ''}`;
  const reasons = topReasons(a, 3, lang);
  const lines = [head];
  for (const r of reasons) lines.push(`• ${escapeHtml(r)}`);
  if (light.color === 'GREEN' && !reasons.length) lines.push('• No known red flags in the checks below (not a guarantee).');
  for (const d of a.disagreements ?? []) lines.push(`• ${escapeHtml(d)}`);
  const cost = costSentence(a.costs, { compact: true });
  if (cost) lines.push(escapeHtml(cost));
  if (m) lines.push(escapeHtml(timingLine(a.ta)));
  const cov = a.coverage ?? coverage(a);
  lines.push(`Checked ${cov.checked}/${cov.total} · missing: ${cov.missing.length ? escapeHtml(cov.missing.join(', ')) : 'none'}`);
  if (m) lines.push(escapeHtml(identityLine(a.identity, m, now)));
  lines.push(`data ${Math.max(0, Math.round((now - (a.at ?? now)) / 1000))} s old`);
  let html = lines.join('\n');
  // Hard cap: drop reason lines from the end until the card fits.
  while (html.length > 900 && lines.length > 4) {
    lines.splice(Math.min(3, lines.length - 1), 1);
    html = lines.join('\n');
  }
  return html.slice(0, 900);
}

/** Confidence label from data coverage (this repo's "sample size"). */
export function confidenceOf(a) {
  const cov = a?.coverage;
  if (!cov) return 'low';
  if (cov.checked >= 11) return 'high';
  if (cov.checked >= 8) return 'med';
  return 'low';
}

/** Suite reasons [{code, sev, p}] from an analysis (+ optional extra codes). */
export function suiteReasons(a, extra = []) {
  const out = [];
  const seen = new Set();
  const push = (code, p = {}) => {
    if (!code || seen.has(code)) return;
    seen.add(code);
    const nums = Object.fromEntries(Object.entries(p ?? {}).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
    out.push({ code, sev: SUITE_CODES[code] ?? 'warn', p: nums });
  };
  for (const e of extra) push(e.code, e.p);
  for (const h of a?.risk?.hard ?? []) push(RISK_TO_SUITE[h.code], h.data);
  for (const r of [...(a?.risk?.reasons ?? [])].sort((x, y) => y.points - x.points)) push(RISK_TO_SUITE[r.code], r.data);
  const ta = a?.ta;
  if (ta?.ok && ta.signal === 'bullish') push('EMA_CROSS_UP', { barsAgo: ta.crossUpAgo ?? 0, rsi: ta.rsi });
  if (ta?.ok && ta.rsi !== null && ta.rsi !== undefined && ta.rsi > 70) push('RSI_OVERBOUGHT', { rsi: ta.rsi });
  if (ta?.ok && ta.volSpike >= 2) push('VOLUME_SPIKE', { mult: ta.volSpike });
  if (a?.risk && !a.risk.hardAvoid && a.risk.score === 0) push('CLEAN_CONTRACT');
  return out;
}

// ------------------------------------------------------------------ the shared alert layout

/**
 * Render one alert (shared contract + suite layout), <= 4096 chars, every value escaped.
 * @param {{tag: 'PRACTICE'|'LIVE', title: string, ref?: string, net?: string, why?: string[], details?: string[],
 *   risk?: string, dataAgeSec?: number|null, rule?: string, buttons?: any[][]}} alert
 * @returns {{html: string, text: string, buttons: any[][]}}
 */
export function renderAlert(alert) {
  const L = [`<b>${escapeHtml(alert.tag)} ${escapeHtml(alert.title)}</b>`];
  if (alert.ref) L.push(escapeHtml(alert.ref));
  if (alert.net) L.push(escapeHtml(alert.net));
  const inner = [];
  // Each Why item is a sentence: one without end punctuation gets a period, so joined items stay readable.
  const why = (alert.why ?? []).filter(Boolean).slice(0, 3).map((w) => (/[.!?]$/.test(String(w).trim()) ? String(w).trim() : `${String(w).trim()}.`));
  inner.push(`Why: ${why.length ? why.map(escapeHtml).join(' ') : 'see the numbers below.'}`);
  for (const d of alert.details ?? []) inner.push(escapeHtml(d));
  if (alert.rule) inner.push(`Rule: ${escapeHtml(alert.rule)}`);
  if (alert.decisionId) inner.push(`decision #${alert.decisionId} (/why ${alert.decisionId})`);
  if (alert.dataAgeSec !== undefined && alert.dataAgeSec !== null) inner.push(`data ${Math.max(0, Math.round(alert.dataAgeSec))} s old`);
  let block = inner.join('\n');
  const tail = `Risk: ${escapeHtml(alert.risk ?? 'n/a')}`;
  const budget = 4096 - L.join('\n').length - tail.length - 60;
  if (block.length > budget) block = `${block.slice(0, Math.max(0, budget - 1))}…`;
  L.push(`<blockquote expandable>${block}</blockquote>`);
  L.push(tail);
  const html = L.join('\n');
  const buttons = alert.buttons ?? [];
  const labels = buttons.flat().map((b) => `[${b.text}]`).join(' ');
  return { html, text: htmlToText(html) + (labels ? `\n${labels}` : ''), buttons };
}

/** Telegram inline keyboard from our button rows. */
export function toKeyboard(rows, { colors = false } = {}) {
  return {
    inline_keyboard: rows.map((row) =>
      row.map((b) => {
        const k = { text: b.text };
        if (b.url) k.url = b.url;
        else if (b.copy) k.copy_text = { text: b.copy };
        else k.callback_data = b.data;
        if (colors && b.style) k.style = b.style; // Bot API 9.4
        return k;
      })),
  };
}

export { fmtPrice };
