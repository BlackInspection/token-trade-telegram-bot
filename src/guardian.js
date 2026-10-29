// Position Guardian: "what changed since you bought". Pure (no I/O).
// Early warning, not insurance: polling cannot beat a same-block rug; it limits damage from slow rugs
// (tax hikes, LP unlocks, gradual drains).
import { money, pctText, fmtUsd } from './format.js';

/** @typedef {{type: string, severity: 'critical'|'warn', before: any, after: any, text: string}} GuardianEvent */

export const EVENT_TYPES = [
  'TAX_UP', 'HONEYPOT_ON', 'SELL_ROUTE_LOST', 'MINT_ON', 'OWNER_BACK', 'LP_LOCK_DOWN', 'LIQ_DRAIN', 'PAIR_GONE',
  'DEV_SELLING', 'TOP10_UP', 'SELL_BURST',
];

/** Plain-language names of the event types, for alerts and /guardian (the codes stay in the event log). */
export const EVENT_LABEL = {
  TAX_UP: 'Tax', HONEYPOT_ON: 'Selling', SELL_ROUTE_LOST: 'Sell route', MINT_ON: 'Supply', OWNER_BACK: 'Contract owner',
  LP_LOCK_DOWN: 'Locked pool money', LIQ_DRAIN: 'Pool money', PAIR_GONE: 'Trading pool', DEV_SELLING: 'Creator share',
  TOP10_UP: 'Top-10 wallets', SELL_BURST: 'Sells in 5 min',
};
export const eventLabel = (type) => EVENT_LABEL[type] ?? String(type);

/** What the bot did about an event, in plain words (the guardian_events.action values). */
const ACTION_LABEL = {
  exit: 'sold', exit_failed: 'sell failed', link_exit: 'sell link sent', tighten: 'stop tightened', alert: 'alert sent',
  suppressed: 'muted', pending: 'checking',
};
export const actionLabel = (action) => ACTION_LABEL[action] ?? String(action);

/** Snapshot of everything the guardian compares. Unknown values stay null. */
export function snapshotFrom(a) {
  const m = a?.market;
  const s = a?.security;
  if (!m) return { marketMissing: true };
  const v = (x) => (x === undefined ? null : x);
  return {
    priceUsd: v(m.priceUsd),
    liquidityUsd: v(m.liquidityUsd),
    pairAddress: v(m.pairAddress),
    buyTaxPct: v(s?.buyTaxPct),
    sellTaxPct: v(s?.sellTaxPct),
    isHoneypot: v(s?.isHoneypot),
    cannotSellAll: v(s?.cannotSellAll),
    isMintable: v(s?.isMintable),
    ownerAddress: v(s?.ownerAddress),
    ownerRenounced: v(s?.ownerRenounced),
    canTakeBackOwnership: v(s?.canTakeBackOwnership),
    isProxy: v(s?.isProxy),
    taxModifiable: v(s?.taxModifiable),
    lpLockedPct: v(s?.lpLockedPct),
    top10Pct: v(s?.top10Pct),
    m5Buys: v(m.txns?.m5?.buys),
    m5Sells: v(m.txns?.m5?.sells),
    sellRoute: v(a?.costs?.sellRoute),
    devHoldingPct: v(s?.creatorPct),
  };
}

const known = (x) => x !== null && x !== undefined;

/**
 * Compare two snapshots. Rules fire only when both values are known; unknowns are reported in `missing`.
 * @param {any} prev last snapshot (or null)
 * @param {any} next current snapshot
 * @param {any} entry snapshot taken when the position opened (or null)
 * @param {{taxUpPts: number, maxSellTaxPct: number, lpLockDropPts: number, liqDropPct: number, liqDropEntryPct: number,
 *   top10UpPts: number}} th
 * @param {{positionValueUsd?: number|null, positionCostUsd?: number|null, sizeUsd?: number, pending?: string[]}} [ctx]
 *   pending: event types seen once already (LIQ_DRAIN and PAIR_GONE need two consecutive observations).
 * @returns {{events: GuardianEvent[], missing: string[], pending: string[]}}
 */
export function diff(prev, next, entry, th, ctx = {}) {
  const events = [];
  const missing = [];
  const pending = [];
  const seen = new Set(ctx.pending ?? []);
  const held = known(ctx.positionCostUsd) && ctx.positionCostUsd > 0;
  const value = ctx.positionValueUsd ?? ctx.positionCostUsd ?? ctx.sizeUsd ?? 50;
  const cost = ctx.positionCostUsd ?? ctx.sizeUsd ?? 50;
  const yourPos = held ? `of your ${money(cost)} position` : `on a ${money(cost)} buy`;
  const ev = (type, severity, before, after, text) => events.push({ type, severity, before, after, text });
  const both = (type, a, b) => {
    if (known(a) && known(b)) return true;
    missing.push(type);
    return false;
  };

  if (!next || !prev) return { events, missing: ['no previous snapshot'], pending };

  // PAIR_GONE: the market disappeared on two checks in a row.
  if (next.marketMissing) {
    if (prev.marketMissing || seen.has('PAIR_GONE')) {
      ev('PAIR_GONE', 'critical', 'trading pool', 'gone', 'The trading pool is gone: no market found on two checks in a row. You may not be able to sell.');
    } else pending.push('PAIR_GONE');
    return { events, missing, pending };
  }
  if (prev.marketMissing) return { events, missing: ['previous check had no market'], pending };

  // TAX_UP
  if (both('TAX_UP', prev.sellTaxPct, next.sellTaxPct) && both('TAX_UP', prev.buyTaxPct, next.buyTaxPct)) {
    const up = Math.max(next.sellTaxPct - prev.sellTaxPct, next.buyTaxPct - prev.buyTaxPct);
    const crossed = next.sellTaxPct > th.maxSellTaxPct && prev.sellTaxPct <= th.maxSellTaxPct;
    if (up >= th.taxUpPts || crossed) {
      const sellSide = next.sellTaxPct - prev.sellTaxPct >= next.buyTaxPct - prev.buyTaxPct;
      const [b, a] = sellSide ? [prev.sellTaxPct, next.sellTaxPct] : [prev.buyTaxPct, next.buyTaxPct];
      const lost = value * (next.sellTaxPct / 100);
      ev('TAX_UP', 'critical', `${pctText(b)}`, `${pctText(a)}`,
        `${sellSide ? 'Sell' : 'Buy'} tax went from ${pctText(b)} to ${pctText(a)}. Selling now would cost about ${money(Math.floor(lost))} ${yourPos}.`);
    }
  }
  // HONEYPOT_ON
  if (both('HONEYPOT_ON', prev.isHoneypot, next.isHoneypot) && prev.isHoneypot === false && next.isHoneypot === true) {
    ev('HONEYPOT_ON', 'critical', 'sellable', 'honeypot', `The token can no longer be sold (honeypot). Your ${money(value)} may be stuck.`);
  }
  // SELL_ROUTE_LOST
  if (both('SELL_ROUTE_LOST', prev.sellRoute, next.sellRoute) && prev.sellRoute === true && next.sellRoute === false) {
    ev('SELL_ROUTE_LOST', 'critical', 'route', 'no route', `No swap route can sell this token back any more. Your ${money(value)} may be stuck.`);
  }
  // MINT_ON
  if (both('MINT_ON', prev.isMintable, next.isMintable) && prev.isMintable === false && next.isMintable === true) {
    ev('MINT_ON', 'critical', 'fixed supply', 'mintable', 'The creator can now create new tokens, which would make yours worth less.');
  }
  // OWNER_BACK
  if (both('OWNER_BACK', prev.ownerRenounced, next.ownerRenounced)) {
    const back = prev.ownerRenounced === true && next.ownerRenounced === false;
    const changed = known(prev.ownerAddress) && known(next.ownerAddress) && String(prev.ownerAddress).toLowerCase() !== String(next.ownerAddress).toLowerCase();
    if (back || changed) {
      ev('OWNER_BACK', 'critical', prev.ownerAddress ?? 'renounced', next.ownerAddress ?? 'owner', 'Someone took back control of the contract. They can change the rules, including taxes.');
    }
  }
  // LP_LOCK_DOWN
  if (both('LP_LOCK_DOWN', prev.lpLockedPct, next.lpLockedPct) && prev.lpLockedPct - next.lpLockedPct >= th.lpLockDropPts) {
    ev('LP_LOCK_DOWN', 'critical', pctText(prev.lpLockedPct, 0), pctText(next.lpLockedPct, 0),
      `Locked pool money fell from ${pctText(prev.lpLockedPct, 0)} to ${pctText(next.lpLockedPct, 0)}; the creators can now pull it out.`);
  }
  // LIQ_DRAIN (vs last, or vs entry); two observations unless the drop is >= 80%
  if (both('LIQ_DRAIN', prev.liquidityUsd, next.liquidityUsd) && prev.liquidityUsd > 0) {
    const dropLast = (1 - next.liquidityUsd / prev.liquidityUsd) * 100;
    const dropEntry = entry && known(entry.liquidityUsd) && entry.liquidityUsd > 0 ? (1 - next.liquidityUsd / entry.liquidityUsd) * 100 : 0;
    if (dropLast >= th.liqDropPct || dropEntry >= th.liqDropEntryPct) {
      const ref = dropLast >= th.liqDropPct ? prev.liquidityUsd : entry.liquidityUsd;
      const drop = Math.max(dropLast, dropEntry);
      if (drop >= 80 || seen.has('LIQ_DRAIN')) {
        ev('LIQ_DRAIN', 'critical', fmtUsd(ref), fmtUsd(next.liquidityUsd),
          `Pool money fell from ${fmtUsd(ref)} to ${fmtUsd(next.liquidityUsd)} (-${pctText(drop, 0)}). Selling ${money(value)} now costs much more, and it may get worse.`);
      } else pending.push('LIQ_DRAIN');
    }
  }
  // DEV_SELLING
  if (both('DEV_SELLING', prev.devHoldingPct, next.devHoldingPct) && prev.devHoldingPct - next.devHoldingPct >= 1) {
    ev('DEV_SELLING', 'warn', pctText(prev.devHoldingPct), pctText(next.devHoldingPct),
      `The creator is selling: their share went from ${pctText(prev.devHoldingPct)} to ${pctText(next.devHoldingPct)}.`);
  }
  // TOP10_UP
  if (both('TOP10_UP', prev.top10Pct, next.top10Pct) && next.top10Pct - prev.top10Pct >= th.top10UpPts) {
    ev('TOP10_UP', 'warn', pctText(prev.top10Pct, 0), pctText(next.top10Pct, 0),
      `The 10 biggest wallets went from ${pctText(prev.top10Pct, 0)} to ${pctText(next.top10Pct, 0)}; a few sellers can now crash the price.`);
  }
  // SELL_BURST (current snapshot only)
  if (both('SELL_BURST', next.m5Sells, next.m5Buys) && next.m5Sells + next.m5Buys >= 15 && next.m5Sells > 3 * Math.max(1, next.m5Buys)) {
    ev('SELL_BURST', 'warn', `${prev.m5Sells ?? '?'} sells`, `${next.m5Sells} sells / ${next.m5Buys} buys`,
      `A wave of selling: ${next.m5Sells} sells vs ${next.m5Buys} buys in 5 minutes.`);
  }
  return { events, missing, pending };
}

/** Tighten a stop toward the price; never lowers it. */
export function tightenStop(stop, price, tightenPct) {
  const candidate = price * (1 - tightenPct / 100);
  if (stop === null || stop === undefined || !Number.isFinite(stop)) return candidate;
  return Math.max(stop, candidate);
}

/** True when an alert of this token+type was sent less than cooldownMin ago. */
export function inCooldown(lastSentAt, now, cooldownMin) {
  return lastSentAt !== null && lastSentAt !== undefined && now - lastSentAt < cooldownMin * 60_000;
}

/**
 * What to do with an event.
 * @returns {'exit'|'link_exit'|'tighten'|'alert'}
 */
export function actionFor(ev, { hasPosition, mode, dryRun, liveExit }) {
  if (!hasPosition) return 'alert';
  if (ev.severity === 'critical') {
    if (mode === 'link') return 'link_exit';
    if (mode === 'paper' || dryRun || (mode === 'live' && liveExit)) return 'exit';
    return 'alert';
  }
  return 'tighten';
}
