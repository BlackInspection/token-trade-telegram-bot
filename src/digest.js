// Daily digest at DIGEST_AT (DIGEST_TZ): counts, spend vs budget, PnL, top-3 skip reasons with tuning hints
// (from shadow marks of skipped deals), and an opt-in "Other bots" line from other bots' events.jsonl files
// (PEER_EVENT_FILES, same event format).
import { readEventsFile } from './events.js';
import { sentence } from './explain.js';
import { money } from './format.js';

/** Local date and HH:MM in a time zone. */
export function localParts(ts, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour;
  return { day: `${p.year}-${p.month}-${p.day}`, hm: `${hour}:${p.minute}` };
}

/** Is the digest due now (once per local day, at or after DIGEST_AT)? */
export function digestDue({ now, digestAt, tz, lastSentDay }) {
  const { day, hm } = localParts(now, tz);
  const [h, m] = digestAt.split(':').map(Number);
  const target = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return { due: hm >= target && lastSentDay !== day, day };
}

/** Count events. */
export function aggregate(events) {
  const out = { alerts: 0, buys: 0, sells: 0, skips: 0, errors: 0, spendUsd: 0, skipReasons: new Map(), lastP: new Map() };
  for (const e of events) {
    if (e.kind === 'alert') out.alerts += 1;
    else if (e.kind === 'buy') {
      out.buys += 1;
      out.spendUsd += Number(e.money?.usd ?? 0) || 0;
    } else if (e.kind === 'sell') out.sells += 1;
    else if (e.kind === 'error') out.errors += 1;
    else if (e.kind === 'skip') {
      out.skips += 1;
      const code = e.reasons?.[0]?.code ?? 'UNKNOWN';
      out.skipReasons.set(code, (out.skipReasons.get(code) ?? 0) + 1);
      out.lastP.set(code, e.reasons?.[0]?.p ?? {});
    }
  }
  out.topSkips = [...out.skipReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([code, n]) => ({ code, n }));
  return out;
}

/** Which setting a skip reason maps to, and how to loosen it. */
export const TUNE_FOR = {
  LIMIT_DAILY_BUDGET: { key: 'daily_budget', raise: (v) => Math.round(v * 1.5) },
  LIMIT_HOURLY: { key: 'max_trades_h', raise: (v) => v + 2 },
  LIMIT_EXPOSURE: { key: 'max_open', raise: (v) => v + 1 },
  PRICE_ABOVE_MAX: { key: 'max_trade_usd', raise: (v) => Math.round(v * 1.5) },
  FEES_EAT_PROFIT: { key: 'cost_gate_mult', raise: (v) => Math.max(1, Math.round(v * 0.75 * 10) / 10) },
};

/** Read other bots' event files; missing / unreadable / schema-mismatched files are skipped with one warning each. */
export function readPeerFiles(paths, { warn = () => {} } = {}) {
  const events = [];
  const skipped = [];
  for (const p of paths ?? []) {
    try {
      const r = readEventsFile(p);
      if (r.missing) {
        skipped.push(p);
        warn(`peer events file missing: ${p}`);
        continue;
      }
      if (!r.events.length && r.bad) {
        skipped.push(p);
        warn(`peer events file has no valid event lines: ${p}`);
        continue;
      }
      events.push(...r.events);
    } catch (err) {
      skipped.push(p);
      warn(`peer events file unreadable: ${p} (${err.message})`);
    }
  }
  return { events, skipped };
}

/**
 * @param {{events: any[], since: number, budgetUsd: number, realizedUsd: number, unrealizedUsd: number,
 *   settings: Record<string, number>, shadowBySkip?: Map<string, {n: number, positive: number, netUsd: number}>,
 *   peerEvents?: any[], mode: string}} a
 * @returns {{text: string, buttons: {text: string, data: string}[][], agg: any}}
 */
export function buildDigest({ events, since, budgetUsd, realizedUsd, unrealizedUsd, settings = {}, shadowBySkip = new Map(), peerEvents = [], mode = 'paper' }) {
  const agg = aggregate(events.filter((e) => e.ts >= since));
  const L = [`Daily digest (${mode === 'paper' ? 'PRACTICE' : mode.toUpperCase()})`];
  L.push(`Alerts ${agg.alerts} · buys ${agg.buys} · sells ${agg.sells} · skips ${agg.skips}${agg.errors ? ` · errors ${agg.errors}` : ''}`);
  L.push(`Spent ${money(agg.spendUsd)}${budgetUsd > 0 ? ` of the ${money(budgetUsd)} daily budget` : ' (no daily budget set)'}`);
  L.push(`PnL net of fees: realized ${money(realizedUsd)} · unrealized ${money(unrealizedUsd)}`);
  const buttons = [];
  if (agg.topSkips.length) {
    L.push('Top skip reasons:');
    for (const { code, n } of agg.topSkips) {
      let line = `  ${code} x${n}: ${sentence(code, agg.lastP.get(code) ?? {})}`;
      const sh = shadowBySkip.get(code);
      const tune = TUNE_FOR[code];
      if (sh && sh.n && tune && settings[tune.key] !== undefined) {
        const cur = settings[tune.key];
        const next = tune.raise(cur);
        const net = `${sh.netUsd >= 0 ? '+' : '-'}${money(Math.abs(sh.netUsd))}`;
        line += sh.n === 1
          ? ` 1 deal was skipped by ${tune.key}=${cur}; it would be ${sh.netUsd > 0 ? 'up' : 'down'} ${money(Math.abs(sh.netUsd))} net today.`
          : ` ${sh.n} deals were skipped by ${tune.key}=${cur}; ${sh.positive} of them would be up net today (${net} in total).`;
        // Offer to loosen a limit only when the skipped deals would have made money net of fees.
        if (sh.positive > 0 && sh.netUsd > 0) buttons.push([{ text: `Change to ${next}`, data: `tune:${tune.key}:${next}` }, { text: 'Keep', data: 'tune:keep' }]);
        else line += ' No change suggested.';
      }
      L.push(line);
    }
  } else L.push('Top skip reasons: none');
  if (peerEvents.length) {
    const byBot = new Map();
    for (const e of peerEvents.filter((x) => x.ts >= since)) {
      const b = byBot.get(e.bot) ?? { buys: 0, usd: 0, skips: 0 };
      if (e.kind === 'buy') {
        b.buys += 1;
        b.usd += Number(e.money?.usd ?? 0) || 0;
      }
      if (e.kind === 'skip') b.skips += 1;
      byBot.set(e.bot, b);
    }
    const total = [...byBot.values()].reduce((s, b) => s + b.usd, 0) + agg.spendUsd;
    L.push(`Other bots: ${[...byBot.entries()].map(([bot, b]) => `${bot} ${b.buys} buys ${money(b.usd)}`).join(' · ')} · total spent, this bot included, ${money(total)} (USD)`);
  }
  return { text: L.join('\n'), buttons, agg };
}
