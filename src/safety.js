// Safety envelope (same commands and keys in every bot of the suite):
//  /panic (persisted kv.panic), auto-pause, doctor (PASS/WARN/FAIL), risk presets with a confirmed diff.
import { money } from './format.js';

// ------------------------------------------------------------------ panic

/** kv.panic survives restarts. While on: no buying at all, pending confirmations cancelled, mode forced to practice. */
export function panicState(storage) {
  return storage.getKv('panic', null);
}

export function setPanic(storage, { now = Date.now(), prevMode = 'paper', reason = 'manual /panic' } = {}) {
  const st = { on: 1, at: now, prevMode, reason };
  storage.setKv('panic', st);
  return st;
}

export function clearPanic(storage) {
  storage.setKv('panic', null);
}

// ------------------------------------------------------------------ live gate

/**
 * kv 'live_confirmed' is written only by a confirmed switch to live with DRY_RUN=false (graduation checklist plus the
 * Confirm LIVE button) and cleared by every other mode change and by /panic.
 */
export function liveConfirmed(storage) {
  return !!storage.getKv('live_confirmed', null);
}

/**
 * The mode the bot actually trades in. A stored mode 'live' (set while DRY_RUN=true) or TRADING_MODE=live is
 * practice when DRY_RUN=false until the live switch was confirmed in the bot.
 */
export function effectiveMode(storage, cfg) {
  const m = storage.getKv('mode', cfg.mode);
  return m === 'live' && !cfg.dryRun && !liveConfirmed(storage) ? 'paper' : m;
}

// ------------------------------------------------------------------ auto-pause

/**
 * Decide an auto-pause. Pure.
 * @param {{consecutiveErrors: number, maxErrors: number, balanceNowUsd?: number|null, balance24hAgoUsd?: number|null,
 *   ownSpend24hUsd?: number, balanceRefAt?: number|null, dropPct: number, dataAgeSec?: number|null, staleSec: number}} s
 *   ownSpend24hUsd is the bot's own net real spend since the reference balance (buys minus sells); dropPct 0 = off.
 * @returns {{pause: boolean, code: string|null, reason: string, p?: any}}
 */
export function autoPauseCheck(s) {
  if (s.maxErrors > 0 && s.consecutiveErrors >= s.maxErrors) {
    return { pause: true, code: 'EXECUTOR_ERROR', reason: `${s.consecutiveErrors} swaps failed in a row (AUTO_PAUSE_ERRORS=${s.maxErrors}). Check /doctor before resuming.` };
  }
  if (s.dropPct > 0 && s.balanceNowUsd !== null && s.balanceNowUsd !== undefined && s.balance24hAgoUsd > 0) {
    const own = s.ownSpend24hUsd ?? 0;
    const unexplained = s.balance24hAgoUsd - own - s.balanceNowUsd;
    const pct = (unexplained / s.balance24hAgoUsd) * 100;
    if (pct > s.dropPct) {
      const at = Number.isFinite(s.balanceRefAt) ? ` at ${new Date(s.balanceRefAt).toISOString().slice(11, 16)} UTC` : ' in the last 24 h';
      return {
        pause: true, code: 'BALANCE_DROP',
        p: { pct: Math.round(pct), unexplainedUsd: unexplained, fromUsd: s.balance24hAgoUsd, nowUsd: s.balanceNowUsd, ownUsd: own },
        reason: `Hot-wallet balance is ${money(s.balanceNowUsd)}, down from ${money(s.balance24hAgoUsd)}${at}. The bot's own trades explain ${money(Math.max(0, own))} of that, ` +
          `so ${money(unexplained)} (${pct.toFixed(0)}%) left the wallet some other way (AUTO_PAUSE_BALANCE_DROP_PCT=${s.dropPct}). ` +
          'Check the wallet (a withdrawal, a manual trade or a leaked key) before resuming.',
      };
    }
  }
  if (s.dataAgeSec !== null && s.dataAgeSec !== undefined && s.dataAgeSec > s.staleSec) {
    return {
      pause: true, code: 'STALE_DATA', p: { ageSec: Math.round(s.dataAgeSec), staleSec: s.staleSec },
      reason: `Market data is ${Math.round(s.dataAgeSec)} s old (STALE_DATA_SEC=${s.staleSec}); new entries are paused until fresh data arrives, then the bot resumes on its own.`,
    };
  }
  return { pause: false, code: null, reason: 'ok' };
}

/**
 * The worst unexplained wallet drop against every balance sample of the last 24 h. Pure.
 * For each earlier sample: expected now = sample - the bot's own real buys since + its real sells since;
 * unexplained = expected - now. A deposit followed by a drain is caught too (the deposit sample is a reference).
 * @param {{samples: {ts: number, usd: number}[], nowUsd: number, flows: {ts: number, side: 'BUY'|'SELL', usd: number}[],
 *   now: number, windowMs?: number}} s flows = the bot's own real-funds trades (and reserved, unconfirmed buys)
 * @returns {{refUsd: number, refAt: number, ownSpendUsd: number, unexplainedUsd: number, pct: number}|null}
 *   null when there is no earlier sample to compare with
 */
export function worstBalanceDrop({ samples, nowUsd, flows = [], now, windowMs = 24 * 3_600_000 }) {
  let worst = null;
  for (const s of samples) {
    if (!(s.usd > 0) || s.ts > now || now - s.ts > windowMs) continue;
    const own = flows.filter((f) => f.ts >= s.ts).reduce((x, f) => x + (f.side === 'SELL' ? -f.usd : f.usd), 0);
    const unexplainedUsd = s.usd - own - nowUsd;
    const pct = (unexplainedUsd / s.usd) * 100;
    if (!worst || pct > worst.pct) worst = { refUsd: s.usd, refAt: s.ts, ownSpendUsd: own, unexplainedUsd, pct };
  }
  return worst;
}

// ------------------------------------------------------------------ presets

/** MAX_PRICE (max_trade_usd), daily budget, per-hour cap and the minimum quality (max_buy_risk). */
export const PRESETS = {
  careful: { max_trade_usd: 25, daily_budget: 50, max_trades_h: 2, max_buy_risk: 25 },
  normal: { max_trade_usd: 50, daily_budget: 150, max_trades_h: 5, max_buy_risk: 40 },
  bold: { max_trade_usd: 200, daily_budget: 500, max_trades_h: 10, max_buy_risk: 50 },
};

/**
 * Which preset the current limits equal, or null for a custom mix. The out-of-box limits (MAX_TRADE_USD 200,
 * DAILY_BUDGET_USD 500, MAX_TRADES_PER_HOUR 10) are the bold preset's except max_buy_risk, so this also names a
 * near match: {name, exact}.
 * @returns {{name: string, exact: boolean}|null}
 */
export function matchingPreset(cfg, TUNABLE) {
  let near = null;
  for (const name of Object.keys(PRESETS)) {
    const off = presetDiff(cfg, name, TUNABLE);
    if (!off.length) return { name, exact: true };
    if (off.length === 1 && off[0].key === 'max_buy_risk' && !near) near = { name, exact: false };
  }
  return near;
}

/** Before/after diff of a preset against the current config. @returns {{key: string, from: any, to: any}[]} */
export function presetDiff(cfg, name, TUNABLE) {
  const p = PRESETS[name];
  if (!p) throw new Error(`unknown preset "${name}" (careful|normal|bold)`);
  return Object.entries(p).map(([key, to]) => {
    const [g, f] = TUNABLE[key];
    return { key, from: cfg[g][f], to };
  }).filter((d) => d.from !== d.to);
}

// ------------------------------------------------------------------ doctor

/**
 * @typedef {{name: string, status: 'PASS'|'WARN'|'FAIL', detail: string, hint?: string}} DoctorRow
 * @param {{cfg: any, storage: any, mode: string, probes: {name: string, check: () => Promise<{ok: boolean, dateHeader?: string|null, detail?: string}>}[],
 *   walletBalanceUsd?: () => Promise<number|null>, now?: () => number, configError?: string|null}} deps
 * @returns {Promise<DoctorRow[]>}
 */
export async function runDoctor({ cfg, storage, mode, probes = [], walletBalanceUsd = null, now = () => Date.now(), configError = null }) {
  const rows = [];
  const add = (name, status, detail, hint) => rows.push({ name, status, detail, ...(hint ? { hint } : {}) });

  add('config', configError ? 'FAIL' : 'PASS', configError ?? '.env parsed and validated', configError ? 'fix the key named above in .env (see .env.example)' : undefined);
  if (!cfg) return rows;
  add('DRY_RUN', cfg.dryRun ? 'WARN' : 'PASS', cfg.dryRun ? 'DRY_RUN=true: practice lock on, nothing real can be bought' : 'DRY_RUN=false: live spending is possible after the live gate',
    cfg.dryRun ? 'expected while practising; set DRY_RUN=false only after graduation' : undefined);

  const keys = [
    ['BOT_TOKEN', cfg.botToken], ['GOPLUS_ACCESS_TOKEN', cfg.api.goplusToken], ['JUPITER_API_KEY', cfg.live.jupiterApiKey],
    ['ZEROX_API_KEY', cfg.live.zeroxApiKey], ['SOLANA_PRIVATE_KEY', cfg.live.solanaPrivateKey], ['EVM_PRIVATE_KEY', cfg.live.evmPrivateKey],
    ['ANTHROPIC_API_KEY', cfg.llm.apiKey],
  ];
  // Names only: no part of a key or token is ever printed (doctor output goes to Telegram).
  const present = keys.filter(([, v]) => v).map(([k]) => k);
  if (cfg.botToken && !cfg.adminIds.length) add('keys', 'FAIL', 'BOT_TOKEN is set but ADMIN_IDS is empty', 'set ADMIN_IDS to your numeric Telegram user id');
  else if (mode === 'live' && !cfg.dryRun && !cfg.live.solanaPrivateKey && !cfg.live.evmPrivateKey) {
    add('keys', 'FAIL', 'live mode without SOLANA_PRIVATE_KEY or EVM_PRIVATE_KEY', 'use link mode (/mode link) to trade without keys, or add a hot-wallet key');
  } else add('keys', 'PASS', present.length ? `present: ${present.join(', ')}` : 'no optional keys (fine for practice and link mode)');

  let skewMs = null;
  for (const p of probes) {
    try {
      const r = await p.check();
      const st = r.status ?? (r.ok ? 'PASS' : 'FAIL');
      add(`api ${p.name}`, st, r.detail ?? (r.ok ? 'reachable' : 'unreachable'), st === 'PASS' ? undefined : r.hint ?? 'check the network and the URL in .env');
      if (r.dateHeader && skewMs === null) {
        const t = Date.parse(r.dateHeader);
        if (Number.isFinite(t)) skewMs = now() - t;
      }
    } catch (err) {
      add(`api ${p.name}`, 'FAIL', String(err.message ?? err).slice(0, 120), 'check the network and the URL in .env');
    }
  }

  try {
    storage.setKv('doctor_probe', now());
    const ok = storage.getKv('doctor_probe') !== null;
    add('database', ok ? 'PASS' : 'FAIL', ok ? 'writable' : 'write did not persist', ok ? undefined : 'check DB_PATH and disk space');
  } catch (err) {
    add('database', 'FAIL', err.message, 'check DB_PATH permissions and disk space');
  }

  if (skewMs === null) add('clock', 'PASS', 'no server time to compare (offline or mock); local clock used');
  else {
    const s = Math.abs(skewMs) / 1000;
    add('clock', s < 5 ? 'PASS' : s < 60 ? 'WARN' : 'FAIL', `skew ${s.toFixed(1)} s vs API server time`, s < 5 ? undefined : 'sync the system clock (NTP)');
  }

  const budget = cfg.trading.dailyBudgetUsd;
  if (mode === 'live' && !cfg.dryRun && !walletBalanceUsd) {
    add('hot wallet', 'WARN', 'no balance reader: the hot-wallet balance and DAILY_BUDGET <= balance are not checked',
      'add SOLANA_PRIVATE_KEY or EVM_PRIVATE_KEY (with its RPC URL), or check the hot-wallet balance by hand and keep only what you can lose');
  } else if (mode === 'live' && !cfg.dryRun) {
    const bal = await walletBalanceUsd().catch(() => null);
    if (bal === null) add('hot wallet', 'WARN', 'balance unknown (the wallet read failed)', 'check the RPC URLs in .env and that the optional live packages are installed');
    else if (budget > 0 && bal > cfg.safety.hotWalletWarnX * budget) add('hot wallet', 'WARN', `balance $${bal.toFixed(0)} > ${cfg.safety.hotWalletWarnX}x daily budget`, 'keep only what you can lose in the hot wallet');
    else add('hot wallet', 'PASS', `balance $${bal.toFixed(0)}`);
    if (bal !== null && budget > bal) add('limits: budget vs balance', 'FAIL', `DAILY_BUDGET_USD $${budget} > wallet $${bal.toFixed(0)}`, 'lower DAILY_BUDGET_USD or fund the wallet');
  } else add('hot wallet', 'PASS', 'skipped (not live)');

  const issues = [];
  if (budget > 0 && cfg.trading.maxTradeUsd > budget) issues.push(`MAX_TRADE_USD $${cfg.trading.maxTradeUsd} > DAILY_BUDGET_USD $${budget}`);
  if (cfg.trading.sizeUsd > cfg.trading.maxTradeUsd) issues.push(`POSITION_SIZE_USD $${cfg.trading.sizeUsd} > MAX_TRADE_USD $${cfg.trading.maxTradeUsd}`);
  add('limits', issues.length ? 'FAIL' : 'PASS', issues.length ? issues.join('; ') : `max trade $${cfg.trading.maxTradeUsd} <= daily budget $${budget || 'off'} · ${cfg.trading.maxTradesPerHour}/h cap`,
    issues.length ? 'make MAX_TRADE_USD <= DAILY_BUDGET_USD and POSITION_SIZE_USD <= MAX_TRADE_USD' : undefined);
  return rows;
}

export function formatDoctor(rows) {
  return rows.map((r) => `${r.status.padEnd(4)} ${r.name}: ${r.detail}${r.hint ? `\n     fix: ${r.hint}` : ''}`).join('\n');
}

export const doctorExitCode = (rows) => (rows.some((r) => r.status === 'FAIL') ? 1 : 0);

/** HTTP status -> doctor row: 2xx/3xx PASS, 429 WARN (rate limited), any other 4xx or 5xx FAIL. */
export function probeResult(status) {
  if (status < 400) return { ok: true, status: 'PASS', detail: `HTTP ${status}` };
  if (status === 429) return { ok: false, status: 'WARN', detail: `HTTP 429 (rate limited)`, hint: 'the free tier is busy right now; run doctor again in a minute' };
  if (status === 401 || status === 403) return { ok: false, status: 'FAIL', detail: `HTTP ${status} (request rejected)`, hint: 'the API rejected the request: check the API key and URL in .env' };
  return { ok: false, status: 'FAIL', detail: `HTTP ${status}`, hint: 'check the network and the URL in .env' };
}

/** Live HTTP probes for doctor (GET with a short timeout; the Date header gives the clock skew). */
export function liveProbes(cfg, fetchImpl = globalThis.fetch) {
  const probe = (name, url) => ({
    name,
    check: async () => {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'crypto-trading-bot/doctor' } });
      return { ...probeResult(res.status), dateHeader: res.headers.get('date') };
    },
  });
  return [
    probe('DexScreener', `${cfg.api.dexscreener}/latest/dex/tokens/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263`),
    probe('GoPlus', `${cfg.api.goplus}/api/v1/supported_chains`),
    probe('GeckoTerminal', `${cfg.api.geckoterminal}/networks?page=1`),
    probe('Jupiter', `${cfg.live.jupiterApiUrl}/quote?inputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&outputMint=So11111111111111111111111111111111111111112&amount=1000000`),
  ];
}
