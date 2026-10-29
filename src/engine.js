// Engine: watchlist loop, strategy signals, position management (SL/TP/trailing/guardian), execution,
// explained decisions (decisions table + suite events), shadow rules, seatbelts, safety envelope.
import { randomBytes } from 'node:crypto';
import { analyzeToken, entryBlock } from './analyzer.js';
import {
  checkEntryAllowed, checkExit, checkSeatbelts, computeLevels, effectiveStop, isLoosening, positionSizeUsd, seatbeltStatus,
  startOfUtcMonth, updateTrailHigh,
} from './risk.js';
import { Portfolio, paperBuyFill, paperSellFill, startOfUtcDay } from './portfolio.js';
import { chainKind } from './chains.js';
import { LOOSEN_DIRECTION, SEATBELT_KEYS, TUNABLE, TUNABLE_BOOL } from './config.js';
import { timeframeToGecko } from './data/geckoterminal.js';
import { fmtPct, fmtPrice, fmtUsd, money, pctText, shortAddr } from './format.js';
import { getLogger } from './log.js';
import { costsAtSize, legImpactPct, METHOD_LABEL } from './costs.js';
import { confidenceOf, costSentence, renderAlert, sentence, SUITE_CODES, suiteReasons, topReasons } from './explain.js';
import { actionFor, actionLabel, diff as guardianDiff, eventLabel, inCooldown, snapshotFrom, tightenStop } from './guardian.js';
import { Tracker, seenBeforeLine, summarize } from './tracker.js';
import { Shadow, ruleIdFor } from './shadow.js';
import { autoPauseCheck, clearPanic, effectiveMode, liveConfirmed, matchingPreset, panicState, PRESETS, presetDiff, setPanic, worstBalanceDrop } from './safety.js';
import { makeEvent, MemoryEventLog } from './events.js';
import { buildDigest, digestDue, readPeerFiles } from './digest.js';
import { LinkExecutor } from './executors/link.js';
import { ExecutionError } from './executors/base.js';
import { Fx } from './fx.js';

const log = getLogger('engine');
const MIN = 60_000;
const H = 3_600_000;
const PENDING_TTL_MS = 120_000;
const LINK_PENDING_TTL_MS = 24 * H;
/** A real buy that may have landed without being recorded holds an open-position slot this long. */
const UNCONFIRMED_SLOT_MS = 24 * H;
const UNCONFIRMED_KEEP_MS = 7 * 24 * H;
/** The hot-wallet balance is read at most this often (balance-drop auto-pause). */
const BALANCE_CHECK_MS = 5 * MIN;

/** A trade that was refused by a rule (not a crash). Message is user-facing; code is a suite reason code. */
export class TradeRefused extends Error {
  constructor(message, code = 'REFUSED', p = {}) {
    super(message);
    this.name = 'TradeRefused';
    this.code = code;
    this.p = p;
  }
}

const fmtQty = (q) => (q >= 1000 ? q.toLocaleString('en-US', { maximumFractionDigits: 0 }) : q.toPrecision(6));

/** A buy/sell reason ('signal: ...', 'TAKE_PROFIT', 'GUARDIAN: TAX_UP', 'manual /sell') as an alert's Why line. */
function reasonText(reason) {
  const r = String(reason ?? '');
  if (SUITE_CODES[r]) return sentence(r);
  const g = /^GUARDIAN( button)?: (\w+)/.exec(r);
  if (g) return g[1] ? `Guardian alert (${eventLabel(g[2]).toLowerCase()}): you tapped Sell.` : `Guardian exit (${eventLabel(g[2]).toLowerCase()} danger).`;
  if (r.startsWith('signal: ')) return `Strategy signal: ${r.slice(8)}`;
  return r ? r.charAt(0).toUpperCase() + r.slice(1) : 'see the numbers below';
}

/** "venue jupiter", "venue 0x (dry)", "venue practice (simulated)". */
const venueLine = (fill) => `venue ${String(fill.venue).replace(/^paper\b/, 'practice (simulated)')}${fill.dry ? ' (dry)' : ''}`;
const newId = () => randomBytes(4).toString('hex');
const EXIT_LABEL = { STOP_LOSS: 'stop hit', TRAILING_STOP: 'trailing stop hit', TAKE_PROFIT: 'take-profit' };
const STRATEGY_LABEL = { ema_cross_rsi: 'EMA cross with an RSI filter' };

export class Engine {
  /**
   * @param {{cfg: any, storage: import('./storage.js').Storage, dataSource: import('./data/index.js').DataSource,
   *          notifier: {send(text: string, opts?: any): Promise<void>, adminIds?: number[]}, executors: {paper: any, solana?: any, evm?: any, link?: any},
   *          strategyFactory: (p?: any) => import('./strategy.js').Strategy, now?: () => number, eventLog?: any, fx?: Fx,
   *          wallet?: import('./wallet.js').WalletReader|null}} deps
   *   executors.solana / .evm may be lazy getters: they are only touched in live mode (never in link mode).
   *   strategyFactory gets the current cfg.analysis, so tuned settings reach the strategy.
   *   wallet reads the hot-wallet balance for the balance-drop auto-pause (null: no reader, the check is skipped).
   */
  constructor({ cfg, storage, dataSource, notifier, executors, strategyFactory, now = () => Date.now(), eventLog = null, fx = null, wallet = null }) {
    this.baseCfg = cfg;
    this.storage = storage;
    this.ds = dataSource;
    this.notifier = notifier;
    this.executors = executors;
    this.strategyFactory = strategyFactory;
    this.now = now;
    this.events = eventLog ?? new MemoryEventLog();
    this.portfolio = new Portfolio(storage, { startEquity: cfg.trading.startEquity, now });
    this.tracker = new Tracker({ storage, ds: dataSource, cfg });
    this.shadow = new Shadow({ storage, cfg, now });
    /** @type {Map<string, import('./strategy.js').Strategy>} */
    this.strategies = new Map();
    this.lastAnalysis = new Map();
    this.lastSignal = new Map();
    this.lastVerdict = new Map();
    this.lastError = new Map();
    /** Pending manual-buy confirmations (in memory, 120 s TTL): id -> {...}. Callback data 'cb:<id>:<action>'. */
    this.pending = new Map();
    /** Link-mode buys waiting for [I bought]. */
    this.linkPending = new Map();
    this.consecutiveErrors = 0;
    this.lastMarketOkAt = now();
    this.wallet = wallet;
    this.lastBalanceCheckAt = 0;
    this.running = false;
    /** buy() runs one at a time: limits are checked and the trade recorded before the next buy is checked. */
    this.buyQueue = Promise.resolve();
    /** Shadow fills already recorded per rule + signal bar (a re-emitted BUY is not a second fill). */
    this.shadowSignals = new Map();
    /** Display currency next to USD amounts (DISPLAY_CURRENCY); never blocks a decision. */
    this.fx = fx ?? new Fx({ currency: cfg.ui?.displayCurrency ?? 'usd', cacheSec: cfg.ui?.fxCacheSec ?? 300, now });
    this.applySettings();
  }

  // ---------- settings / mode ----------
  applySettings() {
    const pend = this.storage.getKv('pending_settings', {});
    let changed = false;
    for (const [key, ch] of Object.entries(pend)) {
      if (ch.effectiveAt <= this.now()) {
        this.storeSetting(key, ch.value);
        delete pend[key];
        changed = true;
      }
    }
    if (changed) this.storage.setKv('pending_settings', pend);
    const before = this.cfg ? JSON.stringify(this.cfg.analysis) : null;
    this.cfg = structuredClone(this.baseCfg);
    const all = { ...this.storage.getKv('settings', {}), ...this.storage.getKv('seatbelts', {}) };
    for (const [key, value] of Object.entries(all)) {
      const path = TUNABLE[key];
      if (path) this.cfg[path[0]][path[1]] = value;
    }
    // Strategies are built from cfg.analysis: rebuild them when an analysis setting changed (max_buy_risk, timeframe...).
    if (before !== null && before !== JSON.stringify(this.cfg.analysis)) this.strategies?.clear();
  }

  storeSetting(key, value) {
    const bucket = SEATBELT_KEYS.has(key) ? 'seatbelts' : 'settings';
    const s = this.storage.getKv(bucket, {});
    s[key] = value;
    this.storage.setKv(bucket, s);
  }

  parseSetting(key, raw) {
    if (key === 'timeframe') {
      timeframeToGecko(raw); // validates
      return raw;
    }
    if (TUNABLE_BOOL.has(key)) {
      const s = String(raw).toLowerCase();
      if (['1', 'true', 'on', 'yes'].includes(s)) return true;
      if (['0', 'false', 'off', 'no'].includes(s)) return false;
      throw new TradeRefused(`"${raw}" is not on/off`);
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new TradeRefused(`"${raw}" is not a non-negative number`);
    return value;
  }

  /**
   * Change a tunable. Loosening a seatbelt / limit takes effect after LOOSEN_DELAY_HOURS; tightening is instant.
   * @returns {{key: string, value: any, effectiveAt: number|null}}
   */
  changeSetting(key, raw) {
    const path = TUNABLE[key];
    if (!path) throw new TradeRefused(`unknown setting "${key}". Tunable: ${Object.keys(TUNABLE).join(', ')}`);
    const value = this.parseSetting(key, raw);
    const current = this.cfg[path[0]][path[1]];
    const pend = this.storage.getKv('pending_settings', {});
    if (isLoosening(LOOSEN_DIRECTION[key], current, value)) {
      const effectiveAt = this.now() + this.cfg.seatbelts.loosenDelayHours * H;
      pend[key] = { value, effectiveAt };
      this.storage.setKv('pending_settings', pend);
      return { key, value, effectiveAt };
    }
    if (pend[key]) {
      delete pend[key];
      this.storage.setKv('pending_settings', pend);
    }
    if (key === 'timeframe') this.strategies.clear();
    this.storeSetting(key, value);
    this.applySettings();
    return { key, value, effectiveAt: null };
  }

  /** Backwards-compatible: returns the value (pending loosening changes are not applied yet). */
  setSetting(key, raw) {
    return this.changeSetting(key, raw).value;
  }

  /**
   * The mode the bot trades in. With DRY_RUN=false a stored 'live' (set while DRY_RUN=true) or TRADING_MODE=live is
   * practice until /mode live was confirmed in the bot (graduation + Confirm LIVE): see safety.effectiveMode.
   */
  get mode() {
    return effectiveMode(this.storage, { mode: this.baseCfg.mode, dryRun: (this.cfg ?? this.baseCfg).dryRun });
  }

  get liveConfirmed() {
    return liveConfirmed(this.storage);
  }

  /**
   * 'LIVE' whenever real money moves (shared contract), 'PRACTICE' otherwise. Link mode is LIVE even with DRY_RUN=true:
   * the bot never spends there, but you sign real swaps with your own money. Live mode with DRY_RUN=true is PRACTICE.
   */
  tag(mode = this.mode) {
    if (mode === 'link') return 'LIVE';
    return mode === 'live' && !this.cfg.dryRun ? 'LIVE' : 'PRACTICE';
  }

  /** User-facing name of a mode ('paper' is the config value; people see "practice"). */
  modeName(mode = this.mode) {
    return mode === 'paper' ? 'practice' : mode;
  }

  modeLabel(mode = this.mode) {
    if (mode === 'paper') return 'practice (paper)';
    if (mode === 'link') return 'link (you sign in your wallet)';
    return this.cfg.dryRun ? 'live route, DRY_RUN=true (simulated)' : 'LIVE (real funds)';
  }

  /**
   * Low-level mode switch. With DRY_RUN=false, `confirm` is the Confirm LIVE button: only requestLiveMode passes it,
   * after the graduation checklist, and only then is kv 'live_confirmed' written. Any other switch clears it.
   * Pending /buy cards are cancelled on a mode change (they were priced for the old mode).
   */
  setMode(mode, { confirm = false } = {}) {
    if (mode === 'practice') mode = 'paper';
    if (!['paper', 'link', 'live'].includes(mode)) throw new TradeRefused('mode must be "paper" (practice), "link" or "live"');
    if (mode === 'live' && panicState(this.storage)) throw new TradeRefused('panic stop is on: /resume first', 'PANIC');
    if (mode === 'live' && !this.cfg.dryRun && !confirm) {
      throw new TradeRefused('DRY_RUN=false: live mode spends real funds. Use /mode live: the graduation checklist, then confirm with the Confirm LIVE button.');
    }
    const prev = this.mode;
    this.storage.setKv('mode', mode);
    this.storage.setKv('live_confirmed', mode === 'live' && !this.cfg.dryRun ? { at: this.now() } : null);
    if (prev !== mode) for (const p of this.pending.values()) p.cancelled = `the mode changed (${p.mode} -> ${mode})`;
    this.strategies.clear();
    return mode;
  }

  /**
   * Startup check (run loop): a stored mode 'live' or TRADING_MODE=live that was never confirmed with DRY_RUN=false
   * is switched to practice, with a notification. The mode getter already treats it as practice; this makes it visible.
   * @returns {Promise<boolean>} true when the mode was forced to practice
   */
  async checkLiveGate() {
    const stored = this.storage.getKv('mode', null);
    const m = stored ?? this.baseCfg.mode;
    if (m !== 'live' || this.cfg.dryRun || this.liveConfirmed) return false;
    this.storage.setKv('mode', 'paper');
    const src = stored === null ? 'TRADING_MODE=live in .env' : 'the saved mode "live" (set while DRY_RUN=true)';
    const text = `Live gate: ${src} was never confirmed with DRY_RUN=false, so the bot runs in practice. ` +
      'Real funds need /mode live: the graduation checklist, then the Confirm LIVE button.';
    log.warn(text);
    await this.notify(text);
    return true;
  }

  /** Graduation checklist for real autopilot (/mode live with DRY_RUN=false). */
  graduation({ phrase = '' } = {}) {
    const g = this.cfg.graduation;
    const closed = this.storage.closedPositionStats('paper');
    const paperPnl = closed.pnl ?? 0;
    const paperCost = this.storage.db.prepare(`SELECT COALESCE(SUM(usd), 0) AS c FROM trades WHERE mode = 'paper' AND side = 'BUY'`).get().c;
    const items = [
      { label: `closed practice trades: ${closed.n}/${g.minPaperTrades}`, done: closed.n >= g.minPaperTrades },
      { label: `monthly loss budget set (${this.cfg.seatbelts.lossBudgetMonthUsd > 0 ? money(this.cfg.seatbelts.lossBudgetMonthUsd) : 'not set: /settings loss_budget 50'})`, done: this.cfg.seatbelts.lossBudgetMonthUsd > 0 },
      // The phrase counts only as part of the command itself, each time: /mode live I can lose this money
      { label: `phrase typed with the command: /mode live ${g.phrase}`, done: String(phrase).trim().toLowerCase() === g.phrase.trim().toLowerCase() },
      { label: 'wallet key present in .env (SOLANA_PRIVATE_KEY or EVM_PRIVATE_KEY)', done: !!(this.cfg.live.solanaPrivateKey || this.cfg.live.evmPrivateKey) },
    ];
    const done = items.filter((i) => i.done).length;
    const pct = paperCost > 0 ? (paperPnl / paperCost) * 100 : 0;
    const text = [
      `Graduation checklist ${done}/${items.length} done:`,
      ...items.map((i) => `  [${i.done ? 'x' : ' '}] ${i.label}`),
      `practice: ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% over ${closed.n} trades (net of fees)`,
    ].join('\n');
    return { items, done, total: items.length, complete: done === items.length, text };
  }

  /**
   * /mode live from the bot. DRY_RUN=true: the checklist is shown but the switch is allowed (nothing real happens).
   * DRY_RUN=false: refused until the checklist is complete; then it still needs the confirm button.
   */
  requestLiveMode({ phrase = '', confirmed = false } = {}) {
    const grad = this.graduation({ phrase });
    if (this.cfg.dryRun) {
      this.setMode('live');
      return {
        mode: 'live',
        text: `Mode set to live (DRY_RUN=true: swaps are simulated and flagged dry). After DRY_RUN=false the bot starts in practice until you pass graduation and confirm /mode live again.\n${grad.text}`,
      };
    }
    if (!grad.complete) {
      throw new TradeRefused(`live autopilot is locked until graduation.\n${grad.text}\nWhen the rest is done, send the phrase with the command in one message: /mode live ${this.cfg.graduation.phrase}`, 'CONFIRM_REQUIRED');
    }
    if (!confirmed) return { needConfirm: true, text: `${grad.text}\nAll done. Tap Confirm LIVE to spend real funds.` };
    this.setMode('live', { confirm: true });
    return { mode: 'live', text: 'Mode set to live - REAL FUNDS. Limits, seatbelts and the guardian stay on.' };
  }

  get paused() {
    return this.storage.getKv('paused', false);
  }

  /** The current pause: {id, at, reason, code} (code is set for auto-pauses), or null when running. */
  get pauseInfo() {
    return this.paused ? this.storage.getKv('pause_info', null) : null;
  }

  /**
   * Pause or resume. Every pause gets a new id: a Resume button carries it, so a button from an earlier pause cannot
   * end a newer one. `code` marks an auto-pause (STALE_DATA resumes on its own when fresh data arrives).
   */
  setPaused(v, reason = null, { code = null } = {}) {
    this.storage.setKv('paused', !!v);
    this.storage.setKv('pause_info', v ? { id: newId(), at: this.now(), reason, code } : null);
    // Resuming after a balance-drop pause means the wallet was checked: the next reading starts a new baseline.
    if (!v && this.storage.getKv('balance_drop', null)) {
      this.storage.setKv('balance_drop', null);
      this.storage.setKv('wallet_balance', []);
    }
    try {
      this.emitEvent({ kind: v ? 'pause' : 'resume', address: 'engine', symbol: 'engine', codes: [{ code: 'PAUSED', sev: 'warn', p: {} }], text: reason ?? (v ? 'paused' : 'resumed') });
    } catch (err) {
      log.debug(`pause event: ${err.message}`);
    }
  }

  get panicOn() {
    return !!panicState(this.storage);
  }

  /** /panic: stop all buying, cancel pending confirmations, force practice mode until /resume + confirm. */
  async panic(reason = 'manual /panic') {
    const prevMode = this.mode;
    setPanic(this.storage, { now: this.now(), prevMode, reason });
    const cancelled = this.pending.size + this.linkPending.size;
    this.pending.clear();
    this.linkPending.clear();
    this.storage.setKv('mode', 'paper');
    this.storage.setKv('live_confirmed', null);
    this.strategies.clear();
    this.setPaused(true, `PANIC: ${reason}`);
    const text = `PANIC: all buying stopped. ${cancelled} pending confirmation(s) cancelled. Mode forced to practice (was ${prevMode}). ` +
      'Stop-loss, take-profit and trailing exits keep running for every open position, real-funds ones included; guardian alerts keep coming ' +
      `(real-funds auto-exit ${this.cfg.guardian.liveExit ? 'on' : 'off: tap Sell'}). /resume (with confirm) to undo.`;
    await this.notify(text);
    return text;
  }

  /** Id of the current panic stop (its start time, base 36): the /resume confirm button carries it. */
  panicId() {
    const p = panicState(this.storage);
    return p ? Number(p.at).toString(36) : null;
  }

  /**
   * Second step of /resume after panic (the confirm button). With `panicId` (the button's), it only clears the panic
   * that prompt was made for, and only within 120 s of the prompt (`promptAt`, ms).
   */
  resumeFromPanic({ panicId = null, promptAt = null } = {}) {
    if (panicId !== null) {
      if (!this.panicOn) return 'Panic is not on. Nothing to resume.';
      if (panicId !== this.panicId()) throw new TradeRefused('this button is for an earlier panic stop; send /resume again');
      if (!(this.now() - promptAt <= PENDING_TTL_MS)) throw new TradeRefused('this confirmation expired (120 s); send /resume again');
    }
    clearPanic(this.storage);
    this.setPaused(false, 'resume after panic');
    return 'Panic cleared. Mode stays practice; switch with /mode when you are ready.';
  }

  /** [Resume] on an AUTO-PAUSE alert: ends that pause only (not a newer one, not a panic stop). */
  resumeFromButton(pauseId = null) {
    if (this.panicOn) throw new TradeRefused('panic stop is on: send /resume and confirm');
    const info = this.pauseInfo;
    if (!this.paused) return 'Already running.';
    if (!pauseId || info?.id !== pauseId) {
      throw new TradeRefused(`this Resume button is from an earlier pause; the bot was paused again since (${info?.reason ?? 'paused'}). Send /resume to resume.`);
    }
    this.setPaused(false, 'resume button');
    return 'Resumed.';
  }

  executorFor(chain, mode = this.mode) {
    if (mode === 'paper') return this.executors.paper;
    if (mode === 'link') return this.executors.link ?? (this.executors.link = new LinkExecutor());
    const ex = chainKind(chain) === 'solana' ? this.executors.solana : this.executors.evm;
    if (!ex) throw new TradeRefused(`no live executor for chain "${chain}"`);
    return ex;
  }

  /** Send a notification. Alerts (objects) go through explain.renderAlert (one layout everywhere). */
  async notify(textOrAlert, { address = null, critical = false } = {}) {
    try {
      if (address && !critical && this.storage.isMuted(address, this.now())) return;
      if (typeof textOrAlert === 'string') return await this.notifier.send(textOrAlert);
      const r = renderAlert(await this.withFx(textOrAlert));
      await this.notifier.send(r.text, { html: r.html, buttons: r.buttons });
    } catch (err) {
      log.warn(`notify failed: ${err.message}`);
    }
  }

  /** DISPLAY_CURRENCY: alerts with `fxUsd` get "$50.00 (~4,600 RUB)" on their net line. FX failure shows USD only. */
  async withFx(alert) {
    if (!(alert?.fxUsd > 0)) return alert;
    const base = `$${alert.fxUsd.toFixed(2)}`;
    const f = await this.fx.format(alert.fxUsd).catch(() => base);
    if (f === base) return alert;
    return { ...alert, net: alert.net ? `${alert.net} · ${f}` : f };
  }

  // ---------- decisions & events ----------
  eventMode(mode = this.mode, shadow = false) {
    if (shadow) return 'shadow';
    return this.tag(mode) === 'LIVE' ? 'live' : 'dry';
  }

  moneyOf(a, usd = null) {
    if (!a?.market) return null;
    const c = a.costs;
    const size = usd ?? c?.sizeUsd ?? this.cfg.trading.sizeUsd;
    const rt = c ? (usd && usd !== c.sizeUsd ? costsAtSize(c, usd) : c) : null;
    return {
      ccy: 'USDC', price: a.market.priceUsd ?? null, ref_price: a.levels?.takeProfit ?? null,
      fees: rt ? Math.round((size - rt.getBackUsd) * 100) / 100 : null,
      net_edge: c?.netEdge ? Math.round(c.netEdge.usd * 100) / 100 : null, usd: size,
    };
  }

  /** Append a suite event (not for plain evaluations). */
  emitEvent({ kind, address, symbol, chain = null, a = null, codes = [], text = '', usd = null, verdict = null, mode = this.mode, shadow = false, decisionId = null, ruleId = null, tx = null }) {
    const id = decisionId ? `ctb-${decisionId}` : `ctb-${kind}-${this.now()}-${newId()}`;
    const ev = makeEvent({
      ts: this.now(), kind, mode: this.eventMode(mode, shadow), id,
      subject: { type: 'token', ref: address, title: symbol ?? address, url: a?.market?.url ?? '' },
      money: kind === 'pause' || kind === 'resume' ? null : this.moneyOf(a, usd),
      verdict, score: a?.risk ? a.risk.score : null, confidence: confidenceOf(a), reasons: codes, rule_id: ruleId, tx,
    });
    void text;
    try {
      this.events.append(ev);
    } catch (err) {
      log.warn(`event not written: ${err.message}`);
    }
    return ev;
  }

  /**
   * Log one decision (every evaluation, including skips) for /why; non-eval kinds also become suite events.
   * @returns {number} decision id
   */
  logDecision({ kind, a = null, address, symbol, chain = null, action = null, verdict = null, codes = [], text = '', usd = null, mode = this.mode, shadow = false, ruleId = null, tx = null }) {
    const id = this.storage.insertDecision({
      ts: this.now(), address, chain, symbol, kind, action, verdict, mode: this.eventMode(mode, shadow), codes, text,
    });
    if (kind !== 'eval') {
      const evVerdict = kind === 'skip' ? 'SKIP' : kind === 'buy' ? 'BUY' : ['BUY', 'WATCH', 'AVOID'].includes(verdict) ? verdict : null;
      const ev = this.emitEvent({ kind, address, symbol, chain, a, codes, text, usd, verdict: evVerdict, mode, shadow, decisionId: id, ruleId, tx });
      this.storage.setDecisionEvent(id, ev.id);
    }
    return id;
  }

  /** Suite reason list for a refusal + the analysis context. */
  codesFor(a, code, p = {}) {
    return suiteReasons(a, code ? [{ code, p }] : []);
  }

  // ---------- analysis / watchlist ----------
  /**
   * @param {{source?: 'analyze'|'watch'|'signal', held?: boolean, allowQuote?: boolean}} [opts]
   *   Quotes only on analyze, /buy, /cost and for open positions - never for every watched token on every tick.
   */
  async analyze(address, chain = null, { source = 'analyze', held = false, allowQuote } = {}) {
    const p = this.cfg.analysis;
    const now = this.now();
    const a = await analyzeToken(this.ds, address, {
      chain, p, timeframe: p.timeframe, limit: p.ohlcvLimit, sizeUsd: this.cfg.trading.sizeUsd,
      securityMaxAgeMs: held ? this.cfg.guardian.securitySec * 1000 : undefined,
      allowQuote: allowQuote ?? (source !== 'watch' || held), now,
    });
    if (!a.market) return a;
    this.lastAnalysis.set(a.address.toLowerCase(), a);
    try {
      const prev = this.storage.lastObservation(a.address, { before: now - MIN });
      if (prev) a.seenBefore = seenBeforeLine(prev, a.market.priceUsd, now);
      const t = this.cfg.track;
      if (t.enabled && !this.storage.lastObservation(a.address, { since: now - t.dedupeMin * MIN })) {
        this.storage.insertObservation({
          ts: now, address: a.address, chain: a.chain, symbol: a.market.token.symbol, verdict: a.verdict.verdict, light: a.light?.color,
          riskScore: a.risk.score, hardAvoid: a.risk.hardAvoid, price: a.market.priceUsd, liquidityUsd: a.market.liquidityUsd,
          levels: a.levels ? { stopLoss: a.levels.stopLoss, takeProfit: a.levels.takeProfit } : null,
          features: {
            codes: [...a.risk.hard.map((h) => h.code), ...a.risk.reasons.map((r) => r.code)],
            costs: a.costs ? { lossPct: a.costs.lossPct, method: a.costs.method, gateOk: a.costs.gate?.ok } : null,
            identity: a.identity?.status ?? 'unknown', coverage: a.coverage?.checked,
          },
          source,
        });
      }
    } catch (err) {
      log.warn(`observation not recorded: ${err.message}`);
    }
    return a;
  }

  async watch(address, chain = null) {
    const a = await this.analyze(address, chain, { source: 'watch' });
    if (!a.market) throw new TradeRefused(`no DEX pair found for ${address}${chain ? ` on ${chain}` : ''}`, 'NO_PAIR');
    this.storage.addWatch({
      address: a.address, chain: a.chain, symbol: a.market.token.symbol, state: this.cfg.shadow.newRules ? 'shadow' : 'live', now: this.now(),
    });
    this.strategies.delete(a.address.toLowerCase());
    if (!this.storage.getSnapshot(a.address, 'last')) this.storage.setSnapshot(a.address, a.chain, 'last', this.now(), snapshotFrom(a));
    return a;
  }

  unwatch(address) {
    this.strategies.delete(String(address).toLowerCase());
    return this.storage.removeWatch(address);
  }

  priceMap() {
    const m = new Map();
    for (const [k, a] of this.lastAnalysis) if (a.market?.priceUsd) m.set(k, a.market.priceUsd);
    return m;
  }

  // ---------- main loop ----------
  async tick() {
    this.applySettings(); // applies loosening changes whose delay has passed
    // Balance-drop auto-pause: only where real funds can move. Runs before any buy of this tick.
    if (this.mode === 'live' && !this.cfg.dryRun) await this.checkBalance();
    const results = [];
    const analyses = [];
    const watch = this.storage.listWatch();
    for (const w of watch) {
      try {
        const r = await this.processToken(w);
        results.push(r);
        if (r.analysis) analyses.push(r.analysis);
        delete r.analysis;
      } catch (err) {
        log.error(`${w.symbol ?? w.address}: ${err.message}`);
        results.push({ address: w.address, symbol: w.symbol, action: 'ERROR', note: err.message });
        this.logDecision({ kind: 'error', address: w.address, symbol: w.symbol, chain: w.chain, codes: [{ code: 'EXECUTOR_ERROR', sev: 'bad', p: {} }], text: err.message });
        const k = w.address.toLowerCase();
        if (this.lastError.get(k) !== err.message) {
          this.lastError.set(k, err.message);
          await this.notify(`Error on ${w.symbol ?? w.address}: ${err.message}`);
        }
      }
    }
    // Shadow marks (net of fees) + hindsight cards.
    try {
      this.shadow.markAll(analyses);
      for (const card of this.shadow.dueCards()) await this.sendHindsightCard(card);
    } catch (err) {
      log.warn(`shadow: ${err.message}`);
    }
    // Auto-pause on stale primary data; a STALE_DATA pause ends on its own once fresh market data arrives again.
    const ageSec = (this.now() - this.lastMarketOkAt) / 1000;
    if (watch.length && !this.paused) {
      const ap = autoPauseCheck({ consecutiveErrors: 0, maxErrors: 0, dataAgeSec: ageSec, staleSec: this.cfg.safety.staleDataSec, dropPct: 100 });
      if (ap.pause) await this.autoPause(ap);
    } else if (this.pauseInfo?.code === 'STALE_DATA' && !this.panicOn && ageSec <= this.cfg.safety.staleDataSec) {
      this.setPaused(false, 'auto-resume: fresh market data');
      this.logDecision({ kind: 'alert', address: 'engine', symbol: 'engine', action: 'AUTO_RESUME', codes: [{ code: 'STALE_DATA', sev: 'good', p: { ageSec: Math.round(ageSec) } }], text: 'fresh market data: auto-resumed' });
      await this.notify(`AUTO-RESUME: market data is fresh again (${Math.round(ageSec)} s old), so the STALE_DATA pause ended. New entries are allowed again.`);
    }
    return results;
  }

  async autoPause(ap) {
    this.setPaused(true, `auto-pause: ${ap.code}`, { code: ap.code });
    const balance = ap.code === 'BALANCE_DROP';
    const stale = ap.code === 'STALE_DATA';
    if (balance) this.storage.setKv('balance_drop', { at: this.now(), ...ap.p });
    const code = stale || balance ? ap.code : 'EXECUTOR_ERROR';
    const decisionId = this.logDecision({ kind: 'alert', address: 'engine', symbol: 'engine', action: 'AUTO_PAUSE', codes: [{ code, sev: 'bad', p: ap.p ?? {} }], text: ap.reason });
    await this.notify({
      tag: this.tag(), title: `AUTO-PAUSE: ${ap.code}`, why: [ap.reason],
      decisionId,
      risk: balance
        ? 'Autopilot stopped and real-funds buys refused until you check the wallet and tap Resume; stop-loss, take-profit and guardian exits keep running.'
        : stale
          ? 'New entries stopped until fresh data arrives (the bot resumes on its own); stop-loss, take-profit and guardian exits keep running.'
          : 'New entries stopped; stop-loss, take-profit and guardian exits keep running.',
      buttons: [[{ text: 'Resume', data: `resume:${this.pauseInfo?.id ?? ''}` }, { text: 'Why?', data: `why:${decisionId}` }]],
    });
  }

  // ---------- balance-drop auto-pause ----------
  /**
   * Read the hot wallet (at most every 5 min unless `force`) and auto-pause with an alert when its USDC balance is more
   * than AUTO_PAUSE_BALANCE_DROP_PCT below any reading of the last 24 h, beyond what the bot's own real trades explain
   * (buys and unconfirmed buys spend, sells bring money back). That points at a withdrawal, a manual trade or a leaked
   * key. A failed or missing read never pauses and never becomes a sample. tick() runs this only in live mode with
   * DRY_RUN=false; the mock calls it directly with a simulated wallet.
   * @returns {Promise<{checked: boolean, balanceUsd?: number|null, drop?: any, pause?: any}>}
   */
  async checkBalance({ force = false } = {}) {
    const dropPct = this.cfg.safety.autoPauseBalanceDropPct;
    if (!this.wallet || !(dropPct > 0)) return { checked: false };
    const now = this.now(); // taken before the read: a trade that lands during the read counts as after this sample
    if (!force && now - this.lastBalanceCheckAt < BALANCE_CHECK_MS) return { checked: false };
    this.lastBalanceCheckAt = now;
    let usd = null;
    try {
      usd = await this.wallet.balanceUsd();
    } catch (err) {
      log.warn(`hot-wallet balance read failed: ${err.message}`);
    }
    if (!(Number.isFinite(usd) && usd >= 0)) return { checked: true, balanceUsd: null };
    const samples = (this.storage.getKv('wallet_balance', []) ?? []).filter((x) => now - x.ts <= 24 * H);
    const since = samples.length ? Math.min(...samples.map((x) => x.ts)) : now;
    const flows = [
      ...this.storage.realFlowsSince(since),
      ...this.unconfirmedBuys('live').filter((r) => r.ts >= since).map((r) => ({ ts: r.ts, side: 'BUY', usd: r.usd })),
    ];
    const drop = worstBalanceDrop({ samples, nowUsd: usd, flows, now });
    this.storage.setKv('wallet_balance', [...samples, { ts: now, usd }].slice(-400));
    const ap = autoPauseCheck({
      consecutiveErrors: 0, maxErrors: 0, dropPct, staleSec: Infinity,
      balanceNowUsd: usd, balance24hAgoUsd: drop?.refUsd ?? null, ownSpend24hUsd: drop?.ownSpendUsd ?? 0, balanceRefAt: drop?.refAt ?? null,
    });
    // One alert per drop, even when the bot was already paused for another reason.
    if (ap.pause && !this.storage.getKv('balance_drop', null)) await this.autoPause(ap);
    return { checked: true, balanceUsd: usd, drop, pause: ap.pause ? ap : null };
  }

  /** /safety line for the balance-drop auto-pause. */
  balanceWatchLine() {
    const pct = this.cfg.safety.autoPauseBalanceDropPct;
    if (!(pct > 0)) return 'Balance watch: off (AUTO_PAUSE_BALANCE_DROP_PCT=0)';
    const hit = this.storage.getKv('balance_drop', null);
    const last = (this.storage.getKv('wallet_balance', []) ?? []).at(-1);
    const where = this.wallet
      ? `${this.wallet.label}${last ? `, last ${money(last.usd)} at ${new Date(last.ts).toISOString().slice(11, 16)} UTC` : ', not read yet'}`
      : 'no wallet reader (needs DRY_RUN=false and a wallet key)';
    return `Balance watch: pause if the hot wallet drops >${pct}% in 24 h beyond the bot's own trades (live mode) · ${where}` +
      (hit ? ` · TRIGGERED: ${hit.pct}% unexplained, real-funds buys refused until /resume` : '');
  }

  /** One watchlist step for a token: analyze -> guardian -> exits -> strategy -> entries. */
  async processToken(w) {
    const key = w.address.toLowerCase();
    const held = this.storage.listOpenPositionsFor(w.address);
    const a = await this.analyze(w.address, w.chain, { source: 'watch', held: held.length > 0 });
    if (!a.market) {
      if (held.length && this.cfg.guardian.enabled) await this.guardianMissing(w, held);
      this.logDecision({ kind: 'eval', address: w.address, symbol: w.symbol, chain: w.chain, action: 'NONE', codes: [{ code: 'NO_PAIR', sev: 'bad', p: {} }], text: a.errors.join('; ') });
      return { address: w.address, symbol: w.symbol, action: 'NONE', note: a.errors.join('; ') };
    }
    this.lastMarketOkAt = this.now();
    const sym = a.market.token.symbol;
    const price = a.market.priceUsd;
    const mode = this.mode;
    const base = { address: a.address, symbol: sym, verdict: a.verdict.verdict, risk: a.risk.score, analysis: a };
    const ctxD = { a, address: a.address, symbol: sym, chain: a.chain, verdict: a.verdict.verdict };

    const prevVerdict = this.lastVerdict.get(key);
    if (prevVerdict !== a.verdict.verdict) {
      this.lastVerdict.set(key, a.verdict.verdict);
      if (prevVerdict !== undefined || a.verdict.verdict !== 'WATCH') {
        const id = this.logDecision({ ...ctxD, kind: 'alert', action: 'VERDICT', codes: suiteReasons(a), text: a.verdict.why });
        await this.notify(this.verdictAlert(a, id), { address: a.address, critical: a.verdict.verdict === 'AVOID' && held.length > 0 });
      }
    }

    let pos = this.storage.getOpenPosition(a.address, mode);

    // Strategy: feed candles not seen yet (plus the still-forming last candle). The signal is the newest bar's: a BUY
    // from an older bar (or the re-fed previous candle) is stale once the newest bar says HOLD. A SELL from an earlier
    // bar in the batch still counts (the cross down happened).
    let signal = { action: 'HOLD', reason: 'no candles', price, t: null };
    if (a.candles.length) {
      let st = this.strategies.get(key);
      if (!st) {
        st = this.strategyFactory(this.cfg.analysis);
        st.warmup(a.candles.slice(0, -1));
        this.strategies.set(key, st);
      }
      const ctx = { position: pos, risk: a.risk };
      let sell = null;
      let last = null;
      for (const c of a.candles.filter((c) => c.t >= st.lastT)) {
        last = st.onCandle(c, ctx);
        if (last.action === 'SELL') sell = last;
      }
      if (last) signal = last.action === 'HOLD' && sell ? sell : last;
    }

    // Guardian runs before SL/TP, for open positions and watchlist tokens, even while paused.
    if (this.cfg.guardian.enabled) {
      const g = await this.runGuardian(a, held);
      if (g.exit) return { ...base, action: 'SELL', reason: g.exit.reason, pnlUsd: g.exit.pnlUsd };
      if (g.linkExit) return { ...base, action: 'ALERT', reason: `${g.linkExit} (link)` };
      pos = this.storage.getOpenPosition(a.address, mode);
    }

    // Protective exits for positions of other modes (after a mode switch or /panic) keep running.
    for (const op of held.filter((p) => p.mode !== mode)) await this.protectiveExit(op, a);

    // Protective exits run even when paused.
    if (pos && price) {
      const trailHigh = updateTrailHigh(pos, price);
      if (trailHigh !== pos.trailHigh) {
        this.storage.updatePosition(pos.id, { trailHigh });
        pos = { ...pos, trailHigh };
      }
      const exit = checkExit(pos, { price }, this.cfg.trading.trailingPct);
      if (exit) {
        if (mode === 'link') {
          await this.linkExitAlert(pos, a, exit.reason);
          return { ...base, action: 'ALERT', reason: `${exit.reason} (link)` };
        }
        const r = await this.sell(a.address, 100, exit.reason, { analysis: a });
        return { ...base, action: 'SELL', reason: exit.reason, pnlUsd: r.pnlUsd };
      }
    }

    if (signal.action !== 'HOLD') {
      const sigKey = `${signal.action}:${signal.t}`;
      if (this.lastSignal.get(key) !== sigKey) {
        this.lastSignal.set(key, sigKey);
        this.storage.insertSignal({
          address: a.address, symbol: sym, action: signal.action, verdict: a.verdict.verdict,
          riskScore: a.risk.score, price, reason: signal.reason,
        });
        const id = this.logDecision({ ...ctxD, kind: 'alert', action: `SIGNAL_${signal.action}`, codes: suiteReasons(a), text: signal.reason });
        await this.notify(this.signalAlert(a, signal, id), { address: a.address });
      }
    }

    if (this.paused) {
      this.logDecision({ ...ctxD, kind: signal.action === 'BUY' && !pos ? 'skip' : 'eval', action: 'PAUSED', codes: this.codesFor(a, 'PAUSED'), text: 'trading is paused' });
      return { ...base, action: 'PAUSED', signal: signal.action };
    }

    if (signal.action === 'SELL' && pos) {
      if (mode === 'link') {
        await this.linkExitAlert(pos, a, 'SIGNAL_EXIT');
        return { ...base, action: 'ALERT', reason: 'signal exit (link)' };
      }
      const r = await this.sell(a.address, 100, `signal: ${signal.reason}`, { analysis: a });
      return { ...base, action: 'SELL', reason: signal.reason, pnlUsd: r.pnlUsd };
    }
    if (signal.action === 'BUY' && !pos) return this.autoEntry(w, a, signal, base, ctxD);

    this.logDecision({ ...ctxD, kind: 'eval', action: 'HOLD', codes: this.codesFor(a, pos ? null : 'NO_GOOD_SETUP'), text: signal.reason });
    return { ...base, action: 'HOLD', note: signal.reason };
  }

  /** BUY signal on a flat token: every refusal is a logged skip with its reason code. */
  async autoEntry(w, a, signal, base, ctxD) {
    const mode = this.mode;
    const skip = (code, note, p = {}, extra = {}) => {
      this.logDecision({ ...ctxD, kind: 'skip', action: 'SKIP', codes: this.codesFor(a, code, p), text: note, usd: this.cfg.trading.sizeUsd, ...extra });
      return { ...base, action: 'SKIP', note, code };
    };
    if (this.panicOn) return skip('PANIC', 'panic stop is on');
    if (this.storage.isMuted(a.address, this.now())) return skip('MUTED', 'muted by you');
    if (a.verdict.verdict === 'AVOID') {
      const first = a.risk.hard[0]?.code;
      return skip(first ? undefined : 'RISK_SCORE_HIGH', `verdict AVOID: ${a.verdict.why}`, { score: a.risk.score, max: this.cfg.analysis.avoidRisk });
    }
    // The strategy's BUY is not enough: copycat, identity, risk limit (as tuned now), cost gate and minimum net profit
    // are checked whatever the analyzer's TA said (its verdict caps are only set on a bullish setup).
    const block = entryBlock(a, this.cfg.analysis);
    if (block) return skip(block.suite, block.code === 'costGate' ? `cost gate: ${block.text}` : block.text, block.data);
    const state = w.state ?? 'live';
    if (state === 'paused') return skip('PAUSED', 'auto-buy paused for this token');
    const ruleId = ruleIdFor(a.address);
    if (state === 'shadow' && mode === 'live') {
      // One shadow fill per signal bar: a BUY re-emitted on later ticks is the same decision, not another buy.
      const sk = `${signal.t ?? 'na'}`;
      if (this.shadowSignals.get(ruleId) === sk) return { ...base, action: 'SHADOW', note: 'shadow rule: already recorded for this signal' };
      this.shadowSignals.set(ruleId, sk);
      this.shadow.record({ ruleId, a, sizeUsd: this.cfg.trading.sizeUsd });
      const note = 'shadow rule: recorded what it would have bought; nothing was spent';
      const decisionId = this.logDecision({ ...ctxD, kind: 'skip', action: 'SHADOW', codes: this.codesFor(a, 'SHADOW_RULE'), text: note, usd: this.cfg.trading.sizeUsd, shadow: true, ruleId });
      await this.notify({
        tag: this.tag(), title: `SHADOW BUY ${a.market.token.symbol} (${a.chain}) ${money(this.cfg.trading.sizeUsd)} @ ${fmtPrice(a.market.priceUsd)}`,
        net: costSentence(a.costs, { compact: true }), fxUsd: this.cfg.trading.sizeUsd, why: [sentence('SHADOW_RULE')], risk: `${a.light.color} · ${a.light.action}`,
        details: ['The rule is in its trial period: a hindsight card will show how it would have done.'],
        decisionId,
        buttons: [[{ text: 'Why?', data: `why:${decisionId}` }, { text: 'Mute 24h', data: `mute:${a.address}` }]],
      }, { address: a.address });
      return { ...base, action: 'SHADOW', note };
    }
    try {
      const r = await this.buy(a.address, null, { reason: `signal: ${signal.reason}`, analysis: a, auto: true });
      if (state === 'shadow' && !r.pending) this.shadow.record({ ruleId, a, sizeUsd: r.fill?.usd ?? this.cfg.trading.sizeUsd });
      if (r.link) return { ...base, action: 'LINK', note: 'waiting for [I bought]', pendingId: r.pendingId };
      if (r.pending) return { ...base, action: 'CONFIRM', note: `above CONFIRM_ABOVE: waiting for your confirmation`, pendingId: r.pendingId };
      return { ...base, action: 'BUY', usd: r.fill.usd, dry: r.fill.dry };
    } catch (err) {
      if (err instanceof TradeRefused) {
        log.info(`skip BUY ${a.market.token.symbol}: ${err.message}`);
        // Limit-skipped deals are marked in shadow so the digest can show "missed net profit".
        if (/^LIMIT_|PRICE_ABOVE_MAX/.test(err.code)) this.shadow.record({ ruleId: `skip:${err.code}`, a, sizeUsd: this.cfg.trading.sizeUsd, reasonCode: err.code });
        return skip(err.code, err.message, err.p);
      }
      throw err;
    }
  }

  // ---------- guardian ----------
  guardianThresholds() {
    const g = this.cfg.guardian;
    return {
      taxUpPts: g.taxUpPts, maxSellTaxPct: this.cfg.analysis.maxSellTaxPct, lpLockDropPts: g.lpLockDropPts, liqDropPct: g.liqDropPct,
      liqDropEntryPct: g.liqDropEntryPct, top10UpPts: g.top10UpPts,
    };
  }

  async runGuardian(a, held) {
    const now = this.now();
    const prev = this.storage.getSnapshot(a.address, 'last');
    const entry = this.storage.getSnapshot(a.address, 'entry');
    const pos = held.find((p) => p.mode === this.mode) ?? held[0] ?? null;
    const price = a.market.priceUsd;
    const ctx = { positionCostUsd: pos?.costUsd ?? null, positionValueUsd: pos && price ? pos.qty * price : null, sizeUsd: this.cfg.trading.sizeUsd };
    const snap = snapshotFrom(a);
    // LIQ_DRAIN / PAIR_GONE need two consecutive observations (one glitchy read must not trigger a critical exit):
    // a type seen once is kept in the 'last' snapshot (_pending) and confirmed on the NEXT tick, with the pre-drop
    // liquidity kept as the reference meanwhile.
    const r = guardianDiff(prev, snap, entry, this.guardianThresholds(), { ...ctx, pending: prev?._pending ?? [] });
    if (r.missing.length) log.debug(`guardian ${a.market.token.symbol}: data missing for ${[...new Set(r.missing)].join(', ')}`);
    const store = { ...snap };
    if (r.pending.length) store._pending = r.pending;
    if (r.pending.includes('LIQ_DRAIN') && prev?.liquidityUsd !== null && prev?.liquidityUsd !== undefined) store.liquidityUsd = prev.liquidityUsd;
    this.storage.setSnapshot(a.address, a.chain, 'last', now, store);
    const out = { exit: null, linkExit: null };
    const retried = await this.retryGuardianExit(a, snap, entry, ctx);
    if (retried?.exit) out.exit = retried.exit;
    for (const ev of r.events) {
      const res = await this.handleGuardianEvent(ev, a, pos, { prev });
      if (res?.exit && !out.exit) out.exit = res.exit;
      if (res?.linkExit && !out.linkExit) out.linkExit = res.linkExit;
    }
    return out;
  }

  /** PAIR_GONE: a held token whose market disappeared on two consecutive ticks. */
  async guardianMissing(w, held) {
    const prev = this.storage.getSnapshot(w.address, 'last');
    const r = guardianDiff(prev, { marketMissing: true }, null, this.guardianThresholds(), { pending: prev?._pending ?? [] });
    this.storage.setSnapshot(w.address, w.chain, 'last', this.now(), { marketMissing: true });
    const a = { address: w.address, chain: w.chain, market: { token: { symbol: w.symbol }, priceUsd: null } };
    for (const ev of r.events) await this.handleGuardianEvent(ev, a, held[0] ?? null);
  }

  /**
   * A guardian auto-exit that failed (e.g. a sell reverting during a rug) is retried on later ticks while the same
   * danger still shows against the snapshot from before the event. @returns {Promise<{exit?: any}|null>}
   */
  async retryGuardianExit(a, snap, entry, ctx) {
    const k = `guardian_retry:${a.address.toLowerCase()}`;
    const retry = this.storage.getKv(k, null);
    if (!retry) return null;
    const pos = this.storage.getPosition(retry.posId);
    if (!pos || pos.status !== 'open') {
      this.storage.setKv(k, null);
      return null;
    }
    const still = guardianDiff(retry.prev, snap, entry, this.guardianThresholds(), { ...ctx, pending: [retry.type] }).events.some((e) => e.type === retry.type);
    if (!still) {
      this.storage.setKv(k, null);
      await this.notify(`GUARDIAN [${pos.symbol}] the ${eventLabel(retry.type).toLowerCase()} danger no longer shows; the bot stopped retrying the exit. The position is still open.`, { address: a.address });
      return null;
    }
    if (!a.market.priceUsd) return null;
    try {
      const r = await this.sell(pos.address, 100, `GUARDIAN: ${retry.type}`, { analysis: a, mode: pos.mode });
      this.storage.setKv(k, null);
      this.storage.db.prepare('UPDATE guardian_events SET action = ? WHERE id = ?').run('exit', retry.eventId);
      return { exit: { reason: `GUARDIAN: ${retry.type}`, pnlUsd: r.pnlUsd } };
    } catch (err) {
      log.warn(`guardian retry ${pos.symbol}: ${err.message}`);
      if (err.message !== retry.error) {
        this.storage.setKv(k, { ...retry, error: err.message, tries: (retry.tries ?? 1) + 1 });
        await this.notify(`GUARDIAN [${pos.symbol}] exit retry failed again: ${err.message}. Sell in your wallet if you can; the bot keeps retrying while the ${eventLabel(retry.type).toLowerCase()} danger shows.`, { address: a.address, critical: true });
      }
      return null;
    }
  }

  async handleGuardianEvent(ev, a, pos, { prev = null } = {}) {
    const now = this.now();
    // An earlier event (or a retried exit) in this tick may have closed the position already.
    if (pos && this.storage.getPosition(pos.id)?.status !== 'open') pos = null;
    const sym = a.market.token.symbol;
    const last = this.storage.lastGuardianAlertAt(a.address, ev.type);
    const id = this.storage.insertGuardianEvent({ ts: now, address: a.address, symbol: sym, type: ev.type, severity: ev.severity, before: ev.before, after: ev.after, action: 'pending', text: ev.text });
    const setAction = (act) => this.storage.db.prepare('UPDATE guardian_events SET action = ? WHERE id = ?').run(act, id);
    if (inCooldown(last, now, this.cfg.guardian.alertCooldownMin)) {
      setAction('suppressed');
      return null;
    }
    if (ev.severity === 'warn' && this.storage.isMuted(`guardian:${a.address}`, now)) {
      setAction('suppressed');
      return null;
    }
    const posMode = pos?.mode ?? this.mode;
    let act = actionFor(ev, { hasPosition: !!pos, mode: posMode, dryRun: this.cfg.dryRun, liveExit: this.cfg.guardian.liveExit });
    let actionText = 'alert only (you hold no position)';
    const result = {};
    let exitError = null;
    if (act === 'exit' && a.market.priceUsd) {
      try {
        const r = await this.sell(a.address, 100, `GUARDIAN: ${ev.type}`, { analysis: a, mode: posMode });
        const label = posMode === 'paper' ? 'practice' : this.cfg.dryRun ? 'dry live' : 'live';
        actionText = `${label} SELL 100% (got back ${money(r.fill.usd)})`;
        result.exit = { reason: `GUARDIAN: ${ev.type}`, pnlUsd: r.pnlUsd };
      } catch (err) {
        // The alert (before -> after, Sell buttons) must still go out, and the exit is retried on later ticks.
        exitError = err;
        act = 'exit_failed';
        actionText = `auto-exit FAILED (${err.message}). Tap Sell to retry or sell in your wallet; the bot retries while the danger shows.`;
        if (prev) this.storage.setKv(`guardian_retry:${a.address.toLowerCase()}`, { type: ev.type, eventId: id, posId: pos.id, prev, at: now, error: err.message, tries: 1 });
        log.warn(`guardian exit ${sym} failed: ${err.message}`);
      }
    } else if (act === 'exit') {
      actionText = 'alert only: no current price to sell at. Tap Sell or sell in your wallet.';
    } else if (act === 'link_exit') {
      await this.linkExitAlert(pos, a, `GUARDIAN: ${ev.type}`);
      actionText = 'sell link sent (you sign it)';
      result.linkExit = `GUARDIAN: ${ev.type}`;
    } else if (act === 'tighten' && pos && a.market.priceUsd) {
      const stop = tightenStop(pos.stopLoss, a.market.priceUsd, this.cfg.guardian.tightenPct);
      this.storage.updatePosition(pos.id, { stopLoss: stop });
      actionText = `stop tightened to ${fmtPrice(stop)}`;
    } else if (pos && ev.severity === 'critical') {
      actionText = 'alert only: auto-exit is off for real funds (GUARDIAN_LIVE_EXIT=false). Tap Sell to exit.';
    } else if (pos) actionText = 'alert only';
    setAction(act);
    const decisionId = this.logDecision({
      kind: 'alert', a: a.risk ? a : null, address: a.address, symbol: sym, chain: a.chain, action: `GUARDIAN_${ev.type}`, verdict: a.verdict?.verdict,
      codes: [{ code: 'GUARDIAN_EXIT', sev: ev.severity === 'critical' ? 'bad' : 'warn', p: {} }], text: ev.text,
    });
    const open = pos ? this.storage.getPosition(pos.id)?.status === 'open' : false;
    const buttons = [];
    if (open && posMode === 'link' && act !== 'link_exit') {
      const sl = this.executorFor(a.chain, 'link').prepareSell({ token: { address: a.address, chain: a.chain } }).links;
      buttons.push(sl.map((l) => ({ text: l.label, url: l.url })), [{ text: 'I sold', data: `ls:${pos.id}` }, { text: 'Ignore 24h', data: `g:${id}:ign` }]);
    } else if (open) {
      buttons.push([{ text: 'Sell 100%', data: `g:${id}:s100` }, { text: 'Sell 50%', data: `g:${id}:s50` }, { text: 'Ignore 24h', data: `g:${id}:ign` }]);
    }
    buttons.push([{ text: 'Why?', data: `why:${decisionId}` }]);
    await this.notify({
      tag: this.tag(posMode), title: `GUARDIAN [${sym}] ${ev.text} Action: ${actionText}`,
      why: [`${eventLabel(ev.type)}: ${ev.before} -> ${ev.after}.`, 'Early warning, not insurance: polling cannot beat a same-block rug.'],
      details: [`severity ${ev.severity}`, `guardian event #${id}`],
      decisionId,
      risk: ev.severity === 'critical' ? 'Critical: this can cost most of the position.' : 'Warning: the stop was tightened where a position is open.',
      buttons,
    }, { address: a.address, critical: ev.severity === 'critical' || !!exitError });
    return result;
  }

  /** Bot buttons on a guardian alert: s100 | s50 | ign. */
  async guardianAction(eventId, action) {
    const ev = this.storage.getGuardianEvent(Number(eventId));
    if (!ev) throw new TradeRefused('guardian event not found');
    if (action === 'ign') {
      this.storage.mute(`guardian:${ev.address}`, this.now() + 24 * H);
      return ev.severity === 'critical'
        ? 'Warnings for this token are muted for 24 h. Critical alerts are never muted.'
        : 'Warnings for this token are muted for 24 h (critical alerts still come through).';
    }
    const pct = action === 's50' ? 50 : 100;
    const pos = this.storage.listOpenPositionsFor(ev.address)[0];
    if (!pos) throw new TradeRefused('no open position for this token');
    const r = await this.sell(ev.address, pct, `GUARDIAN button: ${ev.type}`, { mode: pos.mode });
    return r.message;
  }

  // ---------- link mode ----------
  async linkExitAlert(pos, a, reasonCode) {
    const k = `link_exit:${pos.id}`;
    if (this.storage.getKv(k, null) === reasonCode) return;
    this.storage.setKv(k, reasonCode);
    const links = this.executorFor(pos.chain, 'link').prepareSell({ token: { address: pos.address, chain: pos.chain } }).links;
    const label = EXIT_LABEL[reasonCode] ?? (String(reasonCode).startsWith('GUARDIAN') ? String(reasonCode).toLowerCase().replace('guardian: ', 'guardian ') : 'trend turned down');
    const id = this.logDecision({ kind: 'alert', a, address: pos.address, symbol: pos.symbol, chain: pos.chain, action: 'LINK_SELL', codes: this.codesFor(a, reasonCode.startsWith('GUARDIAN') ? 'GUARDIAN_EXIT' : reasonCode in EXIT_LABEL ? reasonCode : 'SIGNAL_EXIT'), text: label, mode: 'link' });
    const value = a?.market?.priceUsd ? pos.qty * a.market.priceUsd : null;
    await this.notify({
      tag: this.tag('link'), title: `Time to sell ${pos.symbol} (${label}) -> ${links[0].url}`,
      net: value ? `Your position is worth about ${money(value)} before exit costs (entry ${money(pos.costUsd)}).` : undefined,
      why: [`${label}: the bot never signs; open the link, swap back to USDC, then tap I sold.`],
      risk: 'Prices move while you sign; check the amount in your wallet.',
      buttons: [links.map((l) => ({ text: l.label, url: l.url })), [{ text: 'I sold', data: `ls:${pos.id}` }, { text: 'Why?', data: `why:${id}` }]],
    }, { address: pos.address, critical: true });
  }

  /** [I bought] in link mode: record a position at the current price and the intended USD. */
  async confirmLinkBuy(pendingId) {
    const p = this.linkPending.get(pendingId);
    this.linkPending.delete(pendingId);
    if (!p || this.now() - p.at > LINK_PENDING_TTL_MS) throw new TradeRefused('this link buy expired or was already recorded');
    return this.recordLinkFill(p.address, p.usd, null, { chain: p.chain, reason: p.reason });
  }

  cancelLinkBuy(pendingId) {
    return this.linkPending.delete(pendingId);
  }

  /** /filled <addr> <usd> [price] or [I bought]: no executor fill, user-reported. */
  async recordLinkFill(address, usd, price = null, { chain = null, reason = 'link: you bought in your wallet' } = {}) {
    const a = this.lastAnalysis.get(String(address).toLowerCase()) ?? (await this.analyze(address, chain));
    if (!a.market) throw new TradeRefused(`no DEX pair found for ${address}`, 'NO_PAIR');
    const px = price ?? a.market.priceUsd;
    if (!(px > 0) || !(usd > 0)) throw new TradeRefused('usd and price must be positive');
    const token = { address: a.address, chain: a.chain, symbol: a.market.token.symbol };
    // User-reported fill; DEX fee, token tax and impact are estimated so P&L stays net of fees.
    const est = paperBuyFill({ usd, price: px, feeBps: this.cfg.analysis.dexFeeBps, ...(this.fillCosts(a, 'BUY', usd) ?? {}) });
    const fill = { ...est, price: px, venue: 'link (you signed)', txId: null, dry: false };
    const levels = computeLevels(px, a.ta?.ok ? a.ta.atr : null, this.cfg.analysis);
    const position = this.portfolio.recordBuy({ mode: 'link', dry: false, token, fill, levels, reason });
    this.storage.setSnapshot(a.address, a.chain, 'entry', this.now(), snapshotFrom(a));
    const id = this.logDecision({ kind: 'buy', a, address: a.address, symbol: token.symbol, chain: a.chain, action: 'BUY', verdict: a.verdict.verdict, codes: this.codesFor(a, 'MANUAL'), text: reason, usd, mode: 'link' });
    const msg = `Recorded LINK position ${token.symbol}: ${money(usd)} @ ${fmtPrice(px)} · stop ${fmtPrice(position.stopLoss)} · target ${fmtPrice(position.takeProfit)}. The bot will send a sell link when it is time.`;
    await this.notify({ tag: this.tag('link'), title: `LINK BOUGHT ${token.symbol} ${money(usd)} @ ${fmtPrice(px)}`, why: [msg], risk: `${a.light.color} · ${a.light.action}`, buttons: [[{ text: 'Why?', data: `why:${id}` }]] });
    return { position, message: msg };
  }

  /** [I sold] in link mode: close at the current (or given) price. */
  async confirmLinkSell(positionId, price = null) {
    const pos = this.storage.getPosition(Number(positionId));
    if (!pos || pos.status !== 'open') throw new TradeRefused('no open link position');
    const a = this.lastAnalysis.get(pos.address.toLowerCase());
    const px = price ?? a?.market?.priceUsd ?? (await this.ds.getMarket(pos.address, pos.chain))?.priceUsd;
    if (!px) throw new TradeRefused('no current price');
    const reason = this.storage.getKv(`link_exit:${pos.id}`, 'manual (link)');
    const est = paperSellFill({ qty: pos.qty, price: px, feeBps: this.cfg.analysis.dexFeeBps, ...(a ? this.fillCosts(a, 'SELL', pos.qty * px) ?? {} : {}) });
    const fill = { ...est, price: px, venue: 'link (you signed)', txId: null, dry: false };
    const { pnlUsd, closed } = this.portfolio.recordSell({ position: pos, fill, reason });
    this.logDecision({ kind: 'sell', a, address: pos.address, symbol: pos.symbol, chain: pos.chain, action: 'SELL', codes: this.codesFor(a, 'MANUAL'), text: reason, usd: fill.usd, mode: 'link' });
    const msg = `Recorded LINK sale ${pos.symbol}: ${money(fill.usd)} net @ ${fmtPrice(px)} (est. tax ${money(fill.taxUsd ?? 0)}, fee ${money(fill.feeUsd ?? 0)}) · PnL ${fmtUsd(pnlUsd, { compact: false })}${closed ? ' · closed' : ''} (${reason}).`;
    await this.notify(msg);
    return { pnlUsd, closed, message: msg };
  }

  // ---------- execution ----------
  /** Costs for a simulated fill (impact replaces SLIPPAGE_BPS, token taxes applied). */
  fillCosts(a, side, usd) {
    const c = a?.costs;
    if (!c) return null;
    return {
      impactPct: legImpactPct(c, usd),
      buyTaxPct: side === 'BUY' ? c.buyTaxPct : 0,
      sellTaxPct: side === 'SELL' ? c.sellTaxPct : 0,
    };
  }

  /**
   * Open (or add to) a position. usd = null -> configured sizing.
   * Order: panic -> hard avoid -> entry gates (auto) / clone ack (manual) -> limits -> daily budget -> seatbelts -> confirm-above -> execute.
   * Buys run one at a time (a tick's auto-buy and a [Confirm] tap cannot both pass the same limit).
   * @param {{reason?: string, analysis?: any, chain?: string|null, auto?: boolean, mode?: string, cloneAck?: boolean,
   *   override?: string|null, confirmed?: boolean}} [opts] mode: 'paper' forces the paper executor (Practice-buy).
   */
  buy(address, usd = null, opts = {}) {
    const run = this.buyQueue.then(() => this.buyNow(address, usd, opts));
    this.buyQueue = run.then(() => {}, () => {});
    return run;
  }

  // ---------- unconfirmed real buys (write-ahead) ----------
  /** Real buys written before the swap is sent; kept when the outcome is unknown so they count against the limits. */
  unconfirmedBuys(mode = null) {
    const now = this.now();
    const all = (this.storage.getKv('unconfirmed_buys', []) ?? []).filter((r) => now - r.ts < UNCONFIRMED_KEEP_MS);
    return mode ? all.filter((r) => r.mode === mode) : all;
  }

  reserveBuy(r) {
    const id = newId();
    this.storage.setKv('unconfirmed_buys', [...this.unconfirmedBuys(), { id, ts: this.now(), ...r }]);
    return id;
  }

  releaseBuy(id) {
    this.storage.setKv('unconfirmed_buys', this.unconfirmedBuys().filter((r) => r.id !== id));
  }

  markBuyUnconfirmed(id, err) {
    this.storage.setKv('unconfirmed_buys', this.unconfirmedBuys().map((r) => (r.id === id ? { ...r, error: String(err?.message ?? err).slice(0, 200), txId: err?.txId ?? null } : r)));
  }

  async buyNow(address, usd = null, { reason = 'manual', analysis = null, chain = null, auto = false, mode: forcedMode = null, cloneAck = false, override = null, confirmed = false } = {}) {
    const a = analysis ?? (await this.analyze(address, chain));
    if (!a.market) throw new TradeRefused(`no DEX pair found for ${address}`, 'NO_PAIR');
    const sym = a.market.token.symbol;
    const refuse = (msg, code, p = {}) => {
      if (!auto) this.logDecision({ kind: 'skip', a, address: a.address, symbol: sym, chain: a.chain, action: 'SKIP', codes: this.codesFor(a, code, p), text: msg, usd });
      return new TradeRefused(msg, code, p);
    };
    if (this.panicOn) throw refuse('panic stop is on: all buying is stopped (/resume to undo)', 'PANIC');
    if (a.risk.hardAvoid) throw refuse(`refused (hard avoid): ${a.risk.hardReasons.join('; ')}`, ({ honeypot: 'HONEYPOT', noSellRoute: 'NO_SELL_ROUTE' })[a.risk.hard[0]?.code] ?? 'RISK_SCORE_HIGH');
    if (auto) {
      // Includes a possible copycat, a failed identity check, the risk limit as tuned now and the cost gate.
      const block = entryBlock(a, this.cfg.analysis);
      if (block) throw new TradeRefused(block.text, block.suite, block.data);
    }
    if (!auto && a.identity?.status === 'possible_clone' && !cloneAck) {
      const o = a.identity.original;
      throw refuse(`possible copycat of the well-known ${o.symbol} ${shortAddr(o.address)}: confirm with "I know this is not the well-known ${o.symbol}"`, 'POSSIBLE_CLONE');
    }
    const price = a.market.priceUsd;
    if (!price) throw refuse('no current price', 'NO_PAIR');

    const mode = forcedMode ?? this.mode;
    if (mode === 'live' && !this.cfg.dryRun && this.storage.getKv('balance_drop', null)) {
      throw refuse('the hot-wallet balance dropped more than the bot\'s own trades explain: real-funds buys are refused until you check the wallet and /resume', 'BALANCE_DROP');
    }
    const t = this.cfg.trading;
    const token = { address: a.address, chain: a.chain, symbol: sym };
    const existing = this.storage.getOpenPosition(token.address, mode);
    const cash = mode === 'paper' ? this.portfolio.cash() : null;
    // TODO(verify): live sizing uses PAPER_START_EQUITY as notional equity; read wallet balance instead.
    const equity = mode === 'paper' ? this.portfolio.equity(this.priceMap()) : t.startEquity;
    const size = usd ?? positionSizeUsd({ equity, cash, sizeUsd: t.sizeUsd, sizePct: t.sizePct, maxTradeUsd: t.maxTradeUsd });
    if (usd !== null && cash !== null && usd > cash) throw refuse(`not enough paper cash (${fmtUsd(cash, { compact: false })})`, 'NOT_ENOUGH_CASH');

    // Limits: checked on every spend path (paper, link, dry live, live). Real buys whose outcome is unknown (the swap
    // may have landed but was not recorded) count as spent, as a buy this hour and as an open slot.
    const now = this.now();
    const unconf = this.unconfirmedBuys(mode);
    // A pause (/pause or an auto-pause) stops every new entry: manual /buy and confirmation cards made before it too.
    const check = checkEntryAllowed({
      paused: this.paused,
      hasPosition: auto && !!existing,
      openPositions: existing ? 0 : this.storage.listOpenPositions(mode).length + unconf.filter((r) => now - r.ts < UNCONFIRMED_SLOT_MS).length,
      maxOpenPositions: t.maxOpenPositions,
      dailyPnlUsd: this.portfolio.todayPnl(mode),
      dailyLossLimitUsd: t.dailyLossLimitUsd,
      tradesLastHour: this.storage.countTradesSince(mode, now - H, 'BUY') + unconf.filter((r) => r.ts >= now - H).length,
      maxTradesPerHour: t.maxTradesPerHour,
      sizeUsd: size,
      maxTradeUsd: t.maxTradeUsd,
    });
    if (!check.ok) throw refuse(check.reason, check.code, check.p);
    const dayStart = startOfUtcDay(now);
    const spent = this.storage.spentSince(mode, dayStart) + unconf.filter((r) => r.ts >= dayStart).reduce((x, r) => x + r.usd, 0);
    if (t.dailyBudgetUsd > 0 && spent + size > t.dailyBudgetUsd + 1e-9) {
      throw refuse(`daily budget: ${money(spent)} of ${money(t.dailyBudgetUsd)} spent today, ${money(size)} more would exceed it`, 'LIMIT_DAILY_BUDGET', { spent, budget: t.dailyBudgetUsd });
    }
    // Seatbelts (entries only, every mode, practice included).
    const sb = this.cfg.seatbelts;
    const belt = checkSeatbelts({
      now: this.now(), closedPositions: this.storage.listClosedPositions({ mode, limit: 50 }),
      monthPnlUsd: this.storage.realizedPnlSince(mode, startOfUtcMonth(this.now())), budgetUsd: sb.lossBudgetMonthUsd,
      streakPause: sb.lossStreakPause, cooldownMin: sb.lossStreakCooldownMin, revengeMin: sb.revengeBlockMin,
      address: a.address, verdict: a.verdict.verdict, override: !!override,
    });
    if (!belt.ok) throw refuse(belt.reason, belt.code, { streak: belt.streak, budgetUsd: sb.lossBudgetMonthUsd, lostUsd: belt.lostUsd });
    if (override) this.storage.insertSignal({ address: a.address, symbol: sym, action: 'OVERRIDE', verdict: a.verdict.verdict, riskScore: a.risk.score, price, reason: `seatbelt override: ${override}` });

    // Real-money buys (link or live mode) above CONFIRM_ABOVE always ask first: automatic ones, and manual /buy with
    // BUY_CONFIRM=false too. Practice buys never ask.
    if (!confirmed && mode !== 'paper' && size > t.confirmAboveUsd) {
      const id = this.createPendingBuy({ a, usd: size, reason, mode, override, cloneAck, codes: this.codesFor(a, 'CONFIRM_REQUIRED', { above: t.confirmAboveUsd }) });
      const msg = renderAlert(this.confirmCard(id)).text;
      await this.notify(this.confirmCard(id), { address: a.address });
      return { pending: true, pendingId: id, message: msg };
    }

    if (mode === 'link') return this.prepareLinkBuy(a, size, reason);

    const executor = this.executorFor(token.chain, mode);
    // Real funds: write the spend down BEFORE sending, so a swap that lands but is not recorded (an error after the
    // broadcast, a crash) still counts against the daily budget, the hourly cap and open slots.
    const resId = mode === 'live' && !this.cfg.dryRun ? this.reserveBuy({ mode, address: token.address, chain: token.chain, symbol: sym, usd: size }) : null;
    let fill;
    try {
      // slippageBps from the current settings (/settings slippage_bps), not the .env value the executor was built with.
      fill = await executor.buy({ token, usd: size, price, costs: this.fillCosts(a, 'BUY', size), slippageBps: t.slippageBps });
      this.consecutiveErrors = 0;
    } catch (err) {
      if (resId && err?.txSent) {
        this.markBuyUnconfirmed(resId, err);
        await this.notify(`UNCONFIRMED real BUY ${sym} ${money(size)}${err.txId ? ` (tx ${err.txId})` : ''}: the swap was sent but not confirmed (${err.message}). ` +
          'It counts against today\'s budget, the hourly cap and an open slot. Check your wallet.', { address: token.address, critical: true });
      } else if (resId) this.releaseBuy(resId);
      await this.onExecutorError(err);
      throw err;
    }
    const levels = computeLevels(fill.price, a.ta?.ok ? a.ta.atr : null, this.cfg.analysis);
    const position = this.portfolio.recordBuy({ mode, dry: fill.dry, token, fill, levels, reason });
    if (resId) this.releaseBuy(resId); // the trade row counts from here
    this.storage.setSnapshot(a.address, a.chain, 'entry', this.now(), snapshotFrom(a));
    const id = this.logDecision({ kind: 'buy', a, address: a.address, symbol: sym, chain: a.chain, action: 'BUY', verdict: a.verdict.verdict, codes: suiteReasons(a, auto ? [] : [{ code: 'MANUAL' }]), text: reason, usd: size, mode, tx: fill.txId });
    const alert = this.buyAlert({ a, fill, position, mode, reason, decisionId: id });
    const msg = renderAlert(alert).text;
    await this.notify(alert);
    return { fill, position, message: msg };
  }

  async onExecutorError(err) {
    if (!(err instanceof ExecutionError)) return;
    this.consecutiveErrors += 1;
    const ap = autoPauseCheck({ consecutiveErrors: this.consecutiveErrors, maxErrors: this.cfg.safety.autoPauseErrors, dropPct: this.cfg.safety.autoPauseBalanceDropPct, staleSec: this.cfg.safety.staleDataSec });
    if (ap.pause && !this.paused) await this.autoPause(ap);
  }

  /** Link mode: no fill; a card with swap links + [I bought] [Cancel]. */
  async prepareLinkBuy(a, usd, reason) {
    const token = { address: a.address, chain: a.chain, symbol: a.market.token.symbol };
    const { links } = this.executorFor(a.chain, 'link').prepareBuy({ token, usd });
    const id = newId();
    this.linkPending.set(id, { address: a.address, chain: a.chain, usd, at: this.now(), reason });
    const decisionId = this.logDecision({ kind: 'alert', a, address: a.address, symbol: token.symbol, chain: a.chain, action: 'LINK_BUY', verdict: a.verdict.verdict, codes: suiteReasons(a), text: reason, usd, mode: 'link' });
    const alert = {
      tag: this.tag('link'), title: `LINK BUY ${token.symbol}: open ${links[0].url}`,
      ref: `${money(usd)} of ${token.symbol} (${a.chain}) @ ~${fmtPrice(a.market.priceUsd)}`,
      net: costSentence(a.costs, { compact: true }),
      why: [reasonText(reason), 'You sign in your own wallet; the bot never sees a key.'],
      risk: `${a.light.color} · ${a.light.action}`,
      details: ['Phantom has no amount parameter: enter the amount in the wallet.', 'Tap I bought after the swap so the bot can watch the position.'],
      buttons: [links.map((l) => ({ text: l.label, url: l.url })), [{ text: 'I bought', data: `lb:${id}` }, { text: 'Cancel', data: `lx:${id}` }, { text: 'Why?', data: `why:${decisionId}` }]],
    };
    await this.notify(alert, { address: a.address });
    return { link: true, pendingId: id, links, message: renderAlert(alert).text };
  }

  /**
   * Sell `pct`% of the open position for this token. Never blocked by limits or /panic.
   * Without `mode` it sells the position of the current mode, or else the token's open position in any other mode
   * (after /panic or a mode switch, /sell and the Sell buttons still reach a real-funds position).
   */
  async sell(address, pct = 100, reason = 'manual', { analysis = null, mode: forcedMode = null } = {}) {
    let mode = forcedMode ?? this.mode;
    let pos = this.storage.getOpenPosition(address, mode);
    if (!pos && !forcedMode) {
      const other = this.storage.listOpenPositionsFor(address);
      pos = other.find((p) => p.mode !== 'link') ?? other[0] ?? null;
      if (pos) mode = pos.mode;
    }
    if (!pos) throw new TradeRefused(`no open ${this.modeName(mode)} position for ${shortAddr(address)}`, 'NO_POSITION');
    if (!(pct > 0 && pct <= 100)) throw new TradeRefused('percent must be in (0, 100]');
    if (mode === 'link') throw new TradeRefused('link mode: sell in your wallet with the sell link, then tap I sold');
    if (mode === 'live' && !pos.dry && this.cfg.dryRun) {
      // A simulated sell would close the record while the real tokens stay in the wallet.
      throw new TradeRefused(`${pos.symbol} was bought with real funds but DRY_RUN=true now: sell it in your wallet, or set DRY_RUN=false and restart`);
    }
    let a = analysis ?? this.lastAnalysis.get(pos.address.toLowerCase()) ?? null;
    if (!a?.market?.priceUsd) a = await this.analyze(pos.address, pos.chain, { held: true }).catch(() => null);
    const price = a?.market?.priceUsd ?? null;
    if (!price) throw new TradeRefused('no current price');

    const token = { address: pos.address, chain: pos.chain, symbol: pos.symbol };
    const qty = (pos.qty * pct) / 100;
    // A position opened under DRY_RUN=true holds no real tokens: close it with a simulated fill even when DRY_RUN=false
    // now (a real executor would sell real tokens of this mint that the wallet holds for other reasons).
    // Live executors sell at most `qty` (this position's share), never the rest of the wallet's balance.
    const simulated = mode === 'live' && pos.dry && !this.cfg.dryRun;
    let fill;
    try {
      const ex = simulated ? this.executors.paper : this.executorFor(pos.chain, mode);
      fill = await ex.sell({ token, qty, pct, price, costs: this.fillCosts(a, 'SELL', qty * price), slippageBps: this.cfg.trading.slippageBps });
      if (simulated) fill = { ...fill, dry: true, venue: `${fill.venue} (closing a DRY_RUN position)` };
      this.consecutiveErrors = 0;
    } catch (err) {
      await this.onExecutorError(err);
      throw err;
    }
    const costPart = pos.costUsd * Math.min(1, fill.qty / pos.qty);
    const { pnlUsd, closed } = this.portfolio.recordSell({ position: pos, fill, reason, dry: fill.dry });
    const exitCode = String(reason).startsWith('GUARDIAN') ? 'GUARDIAN_EXIT' : SUITE_CODES[reason] ? reason : String(reason).startsWith('signal') ? 'SIGNAL_EXIT' : 'MANUAL';
    const id = this.logDecision({ kind: 'sell', a, address: pos.address, symbol: pos.symbol, chain: pos.chain, action: 'SELL', codes: this.codesFor(a, exitCode), text: reason, usd: fill.usd, mode, tx: fill.txId });
    const alert = {
      tag: this.tag(mode),
      title: `SELL ${pct}% ${pos.symbol}: ${money(fill.usd)} @ ${fmtPrice(fill.price)} · PnL ${fmtUsd(pnlUsd, { compact: false })} (${fmtPct((pnlUsd / costPart) * 100)})${closed ? ' · closed' : ''}`,
      net: `Net of costs: fee ${money(fill.feeUsd ?? 0)} · token tax ${money(fill.taxUsd ?? 0)} · price impact ${money(fill.impactUsd ?? 0)} · bot fee $0`,
      fxUsd: fill.usd,
      why: [reasonText(reason)],
      details: [fill.note, fill.txId ? `tx: ${fill.txId}` : null, venueLine(fill)].filter(Boolean),
      risk: closed ? 'Position closed.' : `Still holding ${fmtQty(pos.qty - fill.qty)} ${pos.symbol}.`,
      decisionId: id,
      buttons: [[{ text: 'Why?', data: `why:${id}` }]],
    };
    const msg = renderAlert(alert).text;
    await this.notify(alert, { address: pos.address, critical: true });
    return { fill, pnlUsd, closed, message: msg };
  }

  /**
   * SL/TP/trailing for a position held in another mode (after /panic or a mode switch). The exit follows the
   * position's own mode: /panic and mode switches stop buying, never exits (GUARDIAN_LIVE_EXIT is only about guardian
   * auto-exits, not about stop-loss and take-profit).
   */
  async protectiveExit(pos, a) {
    const price = a.market.priceUsd;
    if (!price) return;
    const trailHigh = updateTrailHigh(pos, price);
    if (trailHigh !== pos.trailHigh) {
      this.storage.updatePosition(pos.id, { trailHigh });
      pos = { ...pos, trailHigh };
    }
    const exit = checkExit(pos, { price }, this.cfg.trading.trailingPct);
    if (!exit) return;
    if (pos.mode === 'link') return this.linkExitAlert(pos, a, exit.reason);
    try {
      await this.sell(pos.address, 100, exit.reason, { analysis: a, mode: pos.mode });
    } catch (err) {
      log.warn(`protective exit ${pos.symbol} (${pos.mode}): ${err.message}`);
      const k = `exit_fail:${pos.id}`;
      if (this.storage.getKv(k, null) !== err.message) {
        this.storage.setKv(k, err.message);
        await this.notify(`Exit level hit on your ${pos.mode === 'live' && !pos.dry ? 'LIVE' : pos.mode} ${pos.symbol} (${exit.reason}) but the sell failed: ${err.message}. ` +
          'The bot retries every tick; you can also sell in your wallet.', { address: pos.address, critical: true });
      }
    }
  }

  // ---------- manual-buy confirmations (bot /buy) ----------
  /**
   * A confirmation card's state. The card is logged as a decision (its Why? button); `codes` defaults to the
   * analysis plus MANUAL (a /buy), CONFIRM_REQUIRED is passed for buys above CONFIRM_ABOVE.
   */
  createPendingBuy({ a, usd, reason = 'manual /buy', mode = this.mode, override = null, cloneAck = false, codes = null }) {
    for (const [k, v] of this.pending) if (this.now() - v.at > PENDING_TTL_MS) this.pending.delete(k);
    const id = newId();
    const needsCloneAck = a.identity?.status === 'possible_clone' && !cloneAck;
    const decisionId = this.logDecision({
      kind: 'alert', a, address: a.address, symbol: a.market.token.symbol, chain: a.chain, action: 'CONFIRM', verdict: a.verdict?.verdict,
      codes: codes ?? suiteReasons(a, [{ code: 'MANUAL' }]), text: `waiting for confirmation (${reason})`, usd, mode,
    });
    this.pending.set(id, { id, address: a.address, chain: a.chain, usd, at: this.now(), reason, mode, override, needsCloneAck, cloneAck: !!cloneAck, a, decisionId });
    return id;
  }

  /** The /buy confirmation card. */
  confirmCard(id) {
    const p = this.pending.get(id);
    const a = p.a;
    const rt = costsAtSize(a.costs, p.usd);
    const small = Math.min(this.cfg.trading.sizeUsd, p.usd);
    const label = METHOD_LABEL[a.costs.method] ?? a.costs.method;
    const rows = [];
    if (p.needsCloneAck && !p.cloneAck) {
      rows.push([{ text: `I know this is not the well-known ${a.identity.original.symbol}`, data: `cb:${id}:clone` }]);
    } else {
      rows.push([{ text: `Confirm ${money(p.usd)}`, data: `cb:${id}:ok` }, ...(small < p.usd ? [{ text: `Make it ${money(small)}`, data: `cb:${id}:small` }] : []), { text: 'Cancel', data: `cb:${id}:no` }]);
    }
    if (p.decisionId) rows.push([{ text: 'Why?', data: `why:${p.decisionId}` }]);
    return {
      tag: this.tag(p.mode), title: `CONFIRM BUY ${a.market.token.symbol} (${a.chain}) ${money(p.usd)}`,
      ref: `Put in ${money(p.usd)}, sell right away, get back about ${money(Math.round(rt.getBackUsd))} (${label})`,
      net: `Round trip -${pctText(rt.lossPct)} · break-even +${pctText(rt.breakevenPct)}`,
      why: topReasons(a, 2).length ? topReasons(a, 2) : [`${a.light.action}.`],
      risk: `${a.light.color} · ${a.light.action}`,
      details: [p.needsCloneAck ? `Possible copycat: ${a.identity.original.symbol} ${shortAddr(a.identity.original.address)} is the well-known one.` : null, 'Expires in 120 s.'].filter(Boolean),
      fxUsd: p.usd,
      decisionId: p.decisionId,
      buttons: rows,
    };
  }

  /** Callback cb:<id>:<ok|small|no|clone>. Executes exactly once; Cancel and expiry execute nothing. */
  async resolvePending(id, action) {
    const p = this.pending.get(id);
    if (!p) throw new TradeRefused('this confirmation expired or was already used');
    if (this.now() - p.at > PENDING_TTL_MS) {
      this.pending.delete(id);
      throw new TradeRefused('this confirmation expired (120 s); nothing was bought');
    }
    if (p.cancelled && action !== 'no') {
      this.pending.delete(id);
      throw new TradeRefused(`this confirmation was cancelled: ${p.cancelled}. Nothing was bought; run /buy again.`);
    }
    if (action === 'no') {
      this.pending.delete(id);
      return { cancelled: true, message: 'Cancelled. Nothing was bought.' };
    }
    if (action === 'clone') {
      p.cloneAck = true;
      return { card: this.confirmCard(id) };
    }
    if (p.needsCloneAck && !p.cloneAck) throw new TradeRefused('confirm that this is not the well-known token first');
    if (p.mode !== this.mode) {
      this.pending.delete(id);
      throw new TradeRefused(`the mode changed since this card was made (${p.mode} -> ${this.mode}); nothing was bought. Run /buy again.`);
    }
    this.pending.delete(id); // exactly once
    const usd = action === 'small' ? Math.min(this.cfg.trading.sizeUsd, p.usd) : p.usd;
    return this.buy(p.address, usd, { reason: p.reason, chain: p.chain, mode: p.mode, cloneAck: p.cloneAck, override: p.override, confirmed: true });
  }

  /** [Practice-buy $X]: always the paper executor, whatever the mode. */
  async practiceBuy(address, chain = null) {
    return this.buy(address, this.cfg.ui.practiceBuyUsd, { reason: 'Practice-buy button', chain, mode: 'paper', cloneAck: true });
  }

  // ---------- alert builders ----------
  /** Symbol, plus the short address when the token may be a copycat of a well-known ticker. */
  nameOf(a) {
    const sym = a.market.token.symbol;
    return a.identity?.status === 'possible_clone' ? `${sym} (possible copycat ${shortAddr(a.address)})` : sym;
  }

  verdictAlert(a, decisionId) {
    const m = a.market;
    return {
      tag: this.tag(), title: `[${a.verdict.verdict}] ${this.nameOf(a)} (${a.chain}) ${fmtPrice(m.priceUsd)} USD`,
      ref: `${a.light.color} · ${a.light.action} · risk ${a.risk.score}/100 · checked ${a.coverage.checked}/${a.coverage.total}`,
      net: costSentence(a.costs, { compact: true }),
      why: [a.verdict.why].filter(Boolean),
      decisionId,
      details: a.levels ? [`stop ${fmtPrice(a.levels.stopLoss)} (${fmtPct(a.levels.slPct, 1)}) · target ${fmtPrice(a.levels.takeProfit)} (${fmtPct(a.levels.tpPct, 1)})`] : [],
      risk: topReasons(a, 2).join(' ') || 'No known red flags (not a guarantee).',
      dataAgeSec: (this.now() - a.at) / 1000,
      rule: `verdict change -> ${a.verdict.verdict}`,
      // RED: one "Don't buy (mute 24h)" button, the same action and label as on the verdict card (no separate Mute 24h).
      buttons: [a.light.color === 'RED'
        ? [{ text: "Don't buy (mute 24h)", data: `mute:${a.address}`, style: 'danger' }, { text: 'Why?', data: `why:${decisionId}` }]
        : [{ text: `Practice-buy ${money(this.cfg.ui.practiceBuyUsd)}`, data: `pb:${a.address}`, style: 'success' }, { text: 'Why?', data: `why:${decisionId}` }, { text: 'Mute 24h', data: `mute:${a.address}` }]],
    };
  }

  signalAlert(a, signal, decisionId) {
    const m = a.market;
    return {
      tag: this.tag(), title: `Signal ${signal.action} ${this.nameOf(a)} @ ${fmtPrice(m.priceUsd)} (${a.timeframe})`,
      decisionId,
      net: costSentence(a.costs, { compact: true }),
      why: [signal.reason],
      risk: `${a.light.color} · ${a.light.action} · risk ${a.risk.score}/100`,
      dataAgeSec: (this.now() - a.at) / 1000,
      rule: STRATEGY_LABEL[this.cfg.strategy] ?? this.cfg.strategy,
      buttons: [[{ text: `Practice-buy ${money(this.cfg.ui.practiceBuyUsd)}`, data: `pb:${a.address}` }, { text: 'Why?', data: `why:${decisionId}` }, { text: 'Mute 24h', data: `mute:${a.address}` }]],
    };
  }

  buyAlert({ a, fill, position, mode, reason, decisionId }) {
    const token = a.market.token;
    const rt = a.costs ? costsAtSize(a.costs, fill.usd) : null;
    const allInCosts = (fill.feeUsd ?? 0) + (fill.taxUsd ?? 0) + (fill.impactUsd ?? 0);
    const routeNote = mode === 'live' && this.cfg.dryRun ? ' (live route, DRY_RUN: simulated)' : '';
    return {
      tag: this.tag(mode),
      title: `BUY ${this.nameOf(a)} (${a.chain}): ${money(fill.usd)} @ ${fmtPrice(fill.price)}${routeNote}`,
      decisionId,
      ref: `stop ${fmtPrice(position.stopLoss)} · target ${fmtPrice(position.takeProfit)} · qty ${fmtQty(fill.qty)}`,
      net: rt ? `Net: all-in ${money(fill.usd)} incl. ${money(allInCosts)} costs · sell now ≈ ${money(rt.getBackUsd)} (-${pctText(rt.lossPct)}) · break-even +${pctText(rt.breakevenPct)}` : undefined,
      fxUsd: fill.usd,
      why: [reasonText(reason)],
      details: [fill.note, fill.txId ? `tx: ${fill.txId}` : null, venueLine(fill)].filter(Boolean),
      risk: `${a.light.color} · ${a.light.action} · risk ${a.risk.score}/100`,
      dataAgeSec: (this.now() - a.at) / 1000,
      buttons: [[{ text: 'Sell 100%', data: `s:${a.address}:100` }, { text: 'Why?', data: `why:${decisionId}` }, { text: 'Mute 24h', data: `mute:${a.address}` }]],
    };
  }

  async sendHindsightCard(card) {
    const text = this.shadow.cardText(card, { dryRun: this.cfg.dryRun, verdictRecord: this.verdictRecordLine() });
    this.shadow.markCardSent(card.ruleId);
    await this.notify({
      tag: this.tag(), title: `HINDSIGHT ${card.watch.symbol ?? card.watch.address}`, why: [text],
      risk: 'Shadow results ignore failed transactions and MEV.',
      buttons: [[{ text: 'Go live', data: `sh:${card.watch.address}:live` }, { text: 'Keep testing 24h', data: `sh:${card.watch.address}:keep` }, { text: 'Delete', data: `sh:${card.watch.address}:del` }]],
    });
    return text;
  }

  /** "Verdict track record (last N BUY verdicts): 24h up x, down y, rugged z ..." from tracker outcomes. */
  verdictRecordLine(n = 20) {
    const parts = [];
    for (const h of ['24h', '72h', '7d']) {
      if (!this.cfg.track.horizons.includes(h)) continue;
      const rows = this.storage.outcomeRows({ horizon: h }).filter((r) => r.verdict === 'BUY' && !r.synthetic).slice(-n);
      if (!rows.length) continue;
      const up = rows.filter((r) => r.ret_pct > 0).length;
      const rug = rows.filter((r) => r.status === 'rugged').length;
      parts.push(`${h}: up ${up}/${rows.length}, down ${rows.length - up - rug}/${rows.length}, rugged ${rug}/${rows.length}`);
      if (parts.length === 2) break;
    }
    return parts.length ? `Verdict track record (last BUY verdicts) - ${parts.join(' · ')}` : 'Verdict track record: no graded BUY verdicts yet.';
  }

  /**
   * [Go live] / [Keep testing 24h] / [Delete] on a hindsight card. Go live never promotes at once: it answers with a
   * confirmation ({text, buttons}) whose [Yes, go live] button ('ok', with the prompt time `arg`) works for 120 s only.
   * @returns {string|{text: string, buttons: any[][]}}
   */
  shadowAction(address, action, arg = null) {
    const ruleId = ruleIdFor(address);
    const w = this.storage.getWatch(address);
    if ((action === 'live' || action === 'ok') && w?.state !== 'shadow') {
      return w ? `This rule is already ${w.state}; nothing changed.` : 'This token is no longer on the watchlist; nothing changed.';
    }
    if (action === 'live') {
      const st = this.shadow.ruleStats(ruleId);
      const pct = st.spent ? (st.worth / st.spent - 1) * 100 : 0;
      const at = Math.floor(this.now() / 1000).toString(36);
      return {
        text: `Go live with auto-buy for ${w.symbol ?? address}? Shadow result so far: ${st.n} would-be buy(s) for ${money(st.spent)}, worth ${money(st.worth)} net now (${pct >= 0 ? '+' : ''}${pctText(pct)}). ` +
          `${this.cfg.dryRun ? 'Real buying also needs DRY_RUN=false in .env.' : 'In live mode the bot will then buy this token with real funds on its own (limits and seatbelts still apply).'} This confirmation expires in 120 s.`,
        buttons: [[{ text: 'Yes, go live', data: `sh:${address}:ok:${at}`, style: 'danger' }, { text: 'Keep testing 24h', data: `sh:${address}:keep` }]],
      };
    }
    if (action === 'ok') {
      const at = parseInt(String(arg ?? ''), 36) * 1000;
      if (!(Number.isFinite(at) && this.now() - at <= PENDING_TTL_MS && this.now() >= at - 5000)) {
        throw new TradeRefused('this confirmation expired (120 s); tap Go live on the hindsight card again');
      }
      this.shadow.promote(ruleId);
      return this.cfg.dryRun
        ? 'Rule promoted to live. Real buying also needs DRY_RUN=false in .env (nothing else changed).'
        : 'Rule promoted to live: in live mode this token can now be bought automatically (limits and seatbelts still apply).';
    }
    if (action === 'keep') {
      this.shadow.keepTesting(ruleId);
      return 'Keeping the shadow trial for 24 h more.';
    }
    this.unwatch(address);
    return 'Rule deleted (token removed from the watchlist).';
  }

  // ---------- reports ----------
  /** /start on a fresh DB: the 3-step practice tour plus one-tap loss budget buttons. */
  tourIntro() {
    const text = [
      '<b>Welcome. You start on a practice account (no real money).</b>',
      'Paste any token contract address (EVM or Solana) and the bot shows its red flags in plain words and what you would get back after every fee.',
      '',
      'Step 1: try a sample token and see the verdict card.',
      `Step 2: practice-buy it for ${money(this.cfg.ui.practiceBuyUsd)}.`,
      'Step 3: see your P&amp;L, net of every fee.',
      '',
      'Commands to try first: /analyze &lt;address&gt; · /cost &lt;address&gt; · /safety',
      '',
      'One more thing: how much are you OK to lose in a month? The bot pauses itself when that is gone.',
    ].join('\n');
    const buttons = [
      [{ text: 'Try a sample token', data: 'tour:sample' }],
      [{ text: '$20', data: 'budget:20' }, { text: '$50', data: 'budget:50' }, { text: '$100', data: 'budget:100' }, { text: 'Custom', data: 'budget:custom' }],
    ];
    return { text, buttons };
  }

  watchlistText() {
    const list = this.storage.listWatch();
    if (!list.length) return 'Watchlist is empty. Use /watch <address>.';
    return [
      `Watchlist (${list.length}), every ${this.cfg.trading.watchIntervalSec}s:`,
      ...list.map((w) => {
        const a = this.lastAnalysis.get(w.address.toLowerCase());
        const tail = a ? ` · ${a.verdict.verdict} · ${a.light?.color ?? ''} · risk ${a.risk.score} · ${fmtPrice(a.market?.priceUsd)}` : '';
        return `• ${w.symbol ?? '?'} (${w.chain}) ${w.address} · rule ${w.state ?? 'live'}${tail}`;
      }),
    ].join('\n');
  }

  async positionsText() {
    const mode = this.mode;
    const list = this.storage.listOpenPositions(mode);
    if (!list.length) return `No open ${this.modeName(mode)} positions.`;
    const lines = [`Open ${this.modeName(mode)} positions (${list.length}):`];
    for (const p of list) {
      let px = this.lastAnalysis.get(p.address.toLowerCase())?.market?.priceUsd ?? null;
      if (!px) px = (await this.ds.getMarket(p.address, p.chain).catch(() => null))?.priceUsd ?? null;
      const value = px ? p.qty * px : null;
      const upnl = value !== null ? value - p.costUsd : null;
      lines.push(
        `• ${p.symbol} (${p.chain})${p.dry ? ' [dry]' : ''}: qty ${fmtQty(p.qty)} · entry ${fmtPrice(p.entryPrice)} · now ${fmtPrice(px)}` +
          ` · uPnL ${fmtUsd(upnl, { compact: false })} (${fmtPct(upnl !== null ? (upnl / p.costUsd) * 100 : null)})` +
          ` · stop ${fmtPrice(effectiveStop(p, this.cfg.trading.trailingPct))} · TP ${fmtPrice(p.takeProfit)}`,
      );
    }
    return lines.join('\n');
  }

  async pnlText() {
    const mode = this.mode;
    const s = this.portfolio.stats(mode);
    const lines = [
      `PnL (${this.modeName(mode)}${mode === 'live' && this.cfg.dryRun ? ', DRY_RUN' : ''}) - net of fees:`,
      `Realized: ${fmtUsd(s.realizedPnl, { compact: false })} · today ${fmtUsd(s.todayPnl, { compact: false })}`,
      `Closed positions: ${s.closed} · win rate ${s.winRate === null ? 'n/a' : `${s.winRate.toFixed(1)}%`}`,
    ];
    if (mode === 'paper') {
      lines.push(`Cash: ${fmtUsd(this.portfolio.cash(), { compact: false })} · equity ${fmtUsd(this.portfolio.equity(this.priceMap()), { compact: false })} (start ${fmtUsd(this.cfg.trading.startEquity, { compact: false })})`);
    }
    const c = this.storage.costsPaid(mode);
    lines.push(`Costs paid: fees ${money(c.fees)} · token taxes ${money(c.taxes)} · price impact ${money(c.impact)} · bot fee $0`);
    if (mode === 'paper') lines.push('Practice results usually look better than real ones (no failed transactions, MEV or real slippage).');
    const trades = this.storage.listTrades({ mode, limit: 5 });
    if (trades.length) {
      lines.push('Last trades:');
      for (const t of trades) {
        lines.push(
          `  ${new Date(t.ts).toISOString().slice(5, 16)} ${t.side} ${t.symbol} ${fmtUsd(t.usd, { compact: false })} @ ${fmtPrice(t.price)}` +
            `${t.pnl_usd !== null ? ` pnl ${fmtUsd(t.pnl_usd, { compact: false })}` : ''}${t.dry ? ' [dry]' : ''} · ${t.reason ?? ''}`,
        );
      }
    }
    return lines.join('\n');
  }

  settingsText() {
    const c = this.cfg;
    const overrides = { ...this.storage.getKv('settings', {}), ...this.storage.getKv('seatbelts', {}) };
    const pend = this.storage.getKv('pending_settings', {});
    const rows = Object.entries(TUNABLE).map(([k, [g, f]]) => {
      const p = pend[k] ? ` (pending: ${pend[k].value} takes effect at ${new Date(pend[k].effectiveAt).toISOString().slice(0, 16).replace('T', ' ')} UTC)` : '';
      return `  ${k} = ${c[g][f]}${k in overrides ? ' (override)' : ''}${p}`;
    });
    return [
      `Mode: ${this.mode} · DRY_RUN: ${c.dryRun} · paused: ${this.paused} · strategy: ${c.strategy}`,
      `Limits: max open ${c.trading.maxOpenPositions} · daily loss ${fmtUsd(c.trading.dailyLossLimitUsd)} · daily budget ${fmtUsd(c.trading.dailyBudgetUsd)} · max trades/h ${c.trading.maxTradesPerHour}`,
      `Analysis: TF ${c.analysis.timeframe} · EMA ${c.analysis.emaFast}/${c.analysis.emaSlow} · RSI ${c.analysis.rsiPeriod} [${c.analysis.rsiMinEntry}-${c.analysis.rsiOverbought}] · max tax ${c.analysis.maxBuyTaxPct}/${c.analysis.maxSellTaxPct}% · min liq ${fmtUsd(c.analysis.minLiquidityUsd)}`,
      'Tunable (/settings <key> <value>; loosening a limit or seatbelt waits LOOSEN_DELAY_HOURS):',
      ...rows,
    ].join('\n');
  }

  /** /cost <addr> [usd]: the $50 / $250 / $1000 ladder and the max safe size. */
  async costText(address, usd = null, chain = null) {
    const a = await this.analyze(address, chain, { source: 'analyze', allowQuote: true });
    if (!a.market) throw new TradeRefused(`no DEX pair found for ${address}`, 'NO_PAIR');
    const sizes = [...new Set([50, 250, 1000, ...(usd ? [usd] : [])])].sort((x, y) => x - y);
    const label = METHOD_LABEL[a.costs.method] ?? a.costs.method;
    const L = [`Round trip for ${a.market.token.symbol} (${a.chain}) - buy and sell right away, net of fees, taxes, impact and gas:`];
    for (const s of sizes) {
      const r = costsAtSize(a.costs, s);
      L.push(`  ${money(s).padEnd(7)} -> get back ${money(Math.max(0, r.getBackUsd))} (-${pctText(r.lossPct)}) · break-even +${Number.isFinite(r.breakevenPct) ? pctText(r.breakevenPct) : 'never'}`);
    }
    L.push(costSentence(a.costs));
    if (a.costs.atrHint) L.push(`Cost check: ${a.costs.atrHint} (advisory).`);
    L.push(`Method: ${label}; the ladder scales the measured cost with pool math (an estimate; concentrated pools differ).`);
    return L.join('\n');
  }

  /** /guardian: a status line per held or watched token. */
  guardianText() {
    const now = this.now();
    const seen = new Set();
    const L = [`Guardian ${this.cfg.guardian.enabled ? 'on' : 'OFF'} · live auto-exit ${this.cfg.guardian.liveExit ? 'on' : 'off'} · early warning, not insurance`];
    const tokens = [...this.storage.listAllOpenPositions().map((p) => ({ address: p.address, symbol: p.symbol, held: true })), ...this.storage.listWatch().map((w) => ({ address: w.address, symbol: w.symbol, held: false }))];
    for (const t of tokens) {
      const k = t.address.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      const last = this.storage.getSnapshot(t.address, 'last');
      const ago = last?._ts ? `${Math.max(0, Math.round((now - last._ts) / MIN))} min ago` : 'not checked yet';
      const evs = this.storage.latestGuardianEvents(t.address, 2);
      if (evs.length) L.push(`• ${t.symbol}${t.held ? ' [held]' : ''}: ${evs.map((e) => `${eventLabel(e.type)} ${e.before} -> ${e.after} (${actionLabel(e.action)})`).join('; ')} · checked ${ago}`);
      else L.push(`• ${t.symbol}${t.held ? ' [held]' : ''}: ${t.held ? 'no changes since you bought' : 'no changes since you started watching'} (checked ${ago})`);
    }
    if (tokens.length === 0) L.push('Nothing held or watched.');
    return L.join('\n');
  }

  /** /why <id>: the decision trail for that subject. */
  whyText(idOrEvent) {
    const s = String(idOrEvent ?? '').trim();
    const d = /^\d+$/.test(s) ? this.storage.getDecision(Number(s)) : this.storage.getDecisionByEvent(s);
    if (!d) return `No decision #${s}. Use the Why? button on an alert, or /why <id>.`;
    const head = this.whyHeadline(d);
    const trail = this.storage.decisionsFor(d.address, 12).map((x) => {
      const codes = JSON.parse(x.codes ?? '[]');
      const first = codes[0];
      const when = new Date(x.ts).toISOString().slice(5, 16).replace('T', ' ');
      const what = `${(x.kind === 'eval' ? x.action : x.kind.toUpperCase()) ?? ''}${x.verdict ? ` (${x.verdict})` : ''}`;
      return `#${x.id} ${when}${x.repeat > 1 ? ` x${x.repeat}` : ''} ${what}: ${first ? `${first.code} - ${sentence(first.code, first.p)}` : ''} ${x.text ? `[${x.text}]` : ''}`.trim();
    });
    return [head, 'Trail (oldest first):', ...trail].join('\n');
  }

  whyHeadline(d) {
    const codes = JSON.parse(d.codes ?? '[]');
    const first = codes[0];
    const reason = first ? `${first.code} (${sentence(first.code, first.p)})` : d.text ?? '';
    if (d.kind === 'skip') return `Not bought: ${reason} - ${d.text ?? ''}`.trim();
    if (d.kind === 'buy') return `Bought ${d.symbol}: ${d.text ?? ''}. ${codes.filter((c) => c.sev === 'good').map((c) => sentence(c.code, c.p)).join(' ')}`.trim();
    if (d.kind === 'sell') return `Sold ${d.symbol}: ${d.text ?? ''}`;
    return `${d.symbol}: ${d.action ?? d.kind} - ${reason}${d.text ? ` [${d.text}]` : ''}`;
  }

  /** /safety: mode, every limit, spend today/hour, live-gate status. */
  safetyText() {
    const c = this.cfg;
    const t = c.trading;
    const mode = this.mode;
    const now = this.now();
    const spentDay = this.storage.spentSince(mode, startOfUtcDay(now));
    const buysHour = this.storage.countTradesSince(mode, now - H, 'BUY');
    const spentHour = this.storage.spentSince(mode, now - H);
    const sb = c.seatbelts;
    const grad = this.graduation();
    const p = panicState(this.storage);
    const gate = c.dryRun ? 'locked by DRY_RUN=true'
      : mode === 'live' ? 'OPEN: live confirmed in the bot, real funds'
        : grad.complete ? 'graduated (/mode live, then the Confirm LIVE button)' : `locked until graduation (${grad.done}/${grad.total})`;
    const unconf = this.unconfirmedBuys('live');
    const preset = matchingPreset(c, TUNABLE);
    const presetText = preset ? `your limits match ${preset.name}${preset.exact ? '' : ' (except max_buy_risk)'}` : 'your limits match no preset';
    return [
      `Mode: ${this.tag(mode)} - ${this.modeLabel(mode)} · paused: ${this.paused ? 'yes' : 'no'} · panic: ${p ? `ON since ${new Date(p.at).toISOString().slice(11, 16)} UTC` : 'off'}`,
      `DRY_RUN=${c.dryRun}${c.dryRun ? ' (hard lock: no command or setting can spend real funds)' : ''}`,
      `Live gate: ${gate}`,
      ...(unconf.length ? [`Unconfirmed real buys: ${unconf.map((r) => `${r.symbol} ${money(r.usd)}${r.txId ? ` tx ${shortAddr(r.txId)}` : ''}`).join(', ')} - counted against the limits; check your wallet`] : []),
      `Limits: max trade ${money(t.maxTradeUsd)} · daily budget ${t.dailyBudgetUsd > 0 ? money(t.dailyBudgetUsd) : 'off'} (spent today ${money(spentDay)}) · ` +
        `${t.maxTradesPerHour} buys/hour (last hour: ${buysHour}, ${money(spentHour)}) · max open ${t.maxOpenPositions} · daily loss limit ${money(t.dailyLossLimitUsd)} · confirm above ${money(t.confirmAboveUsd)}`,
      `Preset: ${presetText} · change with /preset careful|normal|bold`,
      `Entry gates: max round trip ${pctText(c.analysis.maxRoundtripPct)} · cost gate target >= ${c.analysis.costGateMult}x round trip · max risk ${c.analysis.maxBuyRisk}`,
      `${this.seatbeltLine(mode)} · cooldown ${sb.lossStreakCooldownMin} min · revenge block ${sb.revengeBlockMin} min`,
      `Guardian: ${c.guardian.enabled ? 'on' : 'off'} · live auto-exit ${c.guardian.liveExit ? 'on' : 'off'} · alert cooldown ${c.guardian.alertCooldownMin} min`,
      this.balanceWatchLine(),
    ].join('\n');
  }

  /** Seatbelt status line (mock + /safety). */
  seatbeltLine(mode = this.mode) {
    const closed = this.storage.listClosedPositions({ mode, limit: 50 });
    let streak = 0;
    for (const p of closed) {
      if ((p.realizedPnlUsd ?? 0) < 0) streak += 1;
      else break;
    }
    const sb = this.cfg.seatbelts;
    return seatbeltStatus({ streak, streakPause: sb.lossStreakPause, budgetUsd: sb.lossBudgetMonthUsd, monthPnlUsd: this.storage.realizedPnlSince(mode, startOfUtcMonth(this.now())) });
  }

  /** /scoreboard: practice results net of fees (paper trades + shadow fills). */
  scoreboardText() {
    const db = this.storage.db;
    const buys = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(usd), 0) AS usd FROM trades WHERE mode = 'paper' AND side = 'BUY'`).get();
    const closed = this.storage.closedPositionStats('paper');
    let openWorth = 0;
    for (const p of this.storage.listOpenPositions('paper')) {
      const a = this.lastAnalysis.get(p.address.toLowerCase());
      if (a?.costs && a.market?.priceUsd) openWorth += Math.max(0, costsAtSize(a.costs, p.qty * a.market.priceUsd).getBackUsd * (p.qty * a.market.priceUsd > 0 ? 1 : 0));
    }
    const sh = { rule: { n: 0, spent: 0, worth: 0 }, skip: { n: 0, spent: 0, worth: 0 } };
    for (const f of this.storage.listShadowFills()) {
      const meta = JSON.parse(f.meta ?? '{}');
      const g = f.rule_id.startsWith('skip:') ? sh.skip : sh.rule;
      g.n += 1;
      g.spent += meta.sizeUsd ?? 0;
      g.worth += meta.netValue ?? meta.sizeUsd ?? 0;
    }
    const pl = (g) => `${g.worth - g.spent >= 0 ? '+' : '-'}${money(Math.abs(g.worth - g.spent))} (${g.spent ? `${(((g.worth - g.spent) / g.spent) * 100).toFixed(1)}%` : 'n/a'})`;
    return [
      'Scoreboard - practice, net of fees, taxes, impact and gas:',
      `Practice buys: ${buys.n} for ${money(buys.usd)} · closed ${closed.n} · realized ${fmtUsd(closed.pnl ?? 0, { compact: false })} · open positions worth ${money(openWorth)} net if sold now`,
      `Shadow rules (would have bought, nothing spent): ${sh.rule.n} for ${money(sh.rule.spent)} · worth ${money(sh.rule.worth)} net now · would-be P&L ${pl(sh.rule)}`,
      `Skipped by limits: ${sh.skip.n} for ${money(sh.skip.spent)} · worth ${money(sh.skip.worth)} net now · would-be P&L ${pl(sh.skip)}`,
      'Races lost: 0 (DEX swaps have no first-come race for one listing; failed transactions and MEV are not simulated).',
      'This is the honest proof before going live: if practice loses after fees, live will lose more.',
    ].join('\n');
  }

  /** Digest text + tuning buttons. */
  digest({ since = this.now() - 24 * H, peerWarn = (m) => log.warn(m) } = {}) {
    const mode = this.mode;
    const events = this.events.read({ since });
    const shadowBySkip = new Map();
    for (const f of this.storage.listShadowFills()) {
      if (!f.rule_id.startsWith('skip:') || f.ts < since) continue;
      const code = f.rule_id.slice(5);
      const meta = JSON.parse(f.meta ?? '{}');
      const net = (meta.netValue ?? meta.sizeUsd) - meta.sizeUsd;
      const g = shadowBySkip.get(code) ?? { n: 0, positive: 0, netUsd: 0 };
      g.n += 1;
      if (net > 0) g.positive += 1;
      g.netUsd += net;
      shadowBySkip.set(code, g);
    }
    const settings = Object.fromEntries(Object.entries(TUNABLE).map(([k, [g, f]]) => [k, this.cfg[g][f]]));
    let unrealized = 0;
    for (const p of this.storage.listOpenPositions(mode)) {
      const px = this.lastAnalysis.get(p.address.toLowerCase())?.market?.priceUsd;
      if (px) unrealized += p.qty * px - p.costUsd;
    }
    const peer = readPeerFiles(this.cfg.events.peerFiles, { warn: peerWarn });
    return buildDigest({
      events, since, budgetUsd: this.cfg.trading.dailyBudgetUsd, realizedUsd: this.portfolio.todayPnl(mode), unrealizedUsd: unrealized,
      settings, shadowBySkip, peerEvents: peer.events, mode,
    });
  }

  mute(subject, hours = 24) {
    const until = this.now() + hours * H;
    this.storage.mute(subject, until);
    return until;
  }

  /** /preset: before/after diff (applied only after the confirm button). */
  presetPreview(name) {
    const diffs = presetDiff(this.cfg, name, TUNABLE);
    if (!diffs.length) return { diffs, text: `Preset ${name}: already active.` };
    const now = matchingPreset(this.cfg, TUNABLE);
    const current = now ? `Your limits now match the ${now.name} preset${now.exact ? '' : ' (except max_buy_risk)'}.` : 'Your limits now match no preset.';
    return { diffs, text: [current, `Preset ${name} would change:`, ...diffs.map((d) => `  ${d.key}: ${d.from} -> ${d.to}`), 'Loosening changes wait LOOSEN_DELAY_HOURS; tightening applies now.'].join('\n') };
  }

  applyPreset(name) {
    if (!PRESETS[name]) throw new TradeRefused(`unknown preset "${name}" (careful|normal|bold)`);
    return presetDiff(this.cfg, name, TUNABLE).map((d) => this.changeSetting(d.key, String(d.to)));
  }

  /** Track-record text (bot /trackrecord and CLI). */
  trackRecordText(window = 'all') {
    return this.tracker.report({ window, now: this.now(), sizeUsd: this.cfg.trading.sizeUsd }).text;
  }

  // ---------- run loop ----------
  async start() {
    this.running = true;
    await this.checkLiveGate();
    log.info(`engine started: mode=${this.mode} dry_run=${this.cfg.dryRun} interval=${this.cfg.trading.watchIntervalSec}s`);
    // Track record on its own timer; errors are logged, never thrown into the trading loop.
    const runTracker = async () => {
      try {
        const r = await this.tracker.runDue(this.now());
        if (r.written) log.info(`track record: ${r.written} outcome(s) written (${r.batchCalls} batch call(s))`);
      } catch (err) {
        log.warn(`tracker failed: ${err.message}`);
      }
    };
    if (this.cfg.track.enabled) this._trackTimer = setInterval(runTracker, this.cfg.track.intervalSec * 1000);
    this._digestTimer = setInterval(() => this.maybeSendDigest().catch((err) => log.warn(`digest failed: ${err.message}`)), 60_000);
    while (this.running) {
      const t0 = Date.now();
      const results = await this.tick();
      if (results.length) {
        log.info(`tick: ${results.map((r) => `${r.symbol ?? '?'} ${r.verdict ?? ''} r${r.risk ?? '?'} ${r.action}`).join(' | ')}`);
      }
      const wait = Math.max(1000, this.cfg.trading.watchIntervalSec * 1000 - (Date.now() - t0));
      await new Promise((resolve) => {
        this._wake = resolve;
        this._timer = setTimeout(resolve, wait);
      });
    }
  }

  async maybeSendDigest() {
    const e = this.cfg.events;
    const { due, day } = digestDue({ now: this.now(), digestAt: e.digestAt, tz: e.digestTz, lastSentDay: this.storage.getKv('digest_day', null) });
    if (!due) return false;
    this.storage.setKv('digest_day', day);
    const d = this.digest();
    await this.notify({ tag: this.tag(), title: 'DAILY DIGEST', why: [d.text], risk: 'Net of fees; practice ignores failed transactions and MEV.', buttons: d.buttons });
    return true;
  }

  stop() {
    this.running = false;
    clearTimeout(this._timer);
    clearInterval(this._trackTimer);
    clearInterval(this._digestTimer);
    this._wake?.();
  }
}

export { summarize };
