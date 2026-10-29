#!/usr/bin/env node
// CLI entry: node src/index.js <analyze|run|backtest|mock|trackrecord|doctor> [...]
import './warnings.js';
import './updater.js'; // Windows runtime refresh; no-op elsewhere

// This release ships as a Windows build (see README: Self-hosting).
if (process.platform !== 'win32' && process.env.ALLOW_UNSUPPORTED_OS !== '1') {
  console.error('This build is Windows-only. Install it on Windows 10/11, or set ALLOW_UNSUPPORTED_OS=1 to run it anyway (unsupported).');
  process.exit(1);
}
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, ROOT, loadConfig } from './config.js';
import { getLogger, mask, setLogLevel } from './log.js';
import { analyzeToken, formatAnalysis } from './analyzer.js';
import { LiveDataSource } from './data/index.js';
import { MOCK_TOKENS, MockDataSource } from './data/mock.js';
import { extractAddress, normalizeChain } from './chains.js';
import { strategyFactory } from './strategy.js';
import { formatBacktest, runBacktest } from './backtest.js';
import { Storage } from './storage.js';
import { Notifier } from './notifier.js';
import { Engine, TradeRefused } from './engine.js';
import { PaperExecutor } from './executors/paper.js';
import { JupiterExecutor } from './executors/jupiter.js';
import { EvmExecutor } from './executors/evm.js';
import { LinkExecutor } from './executors/link.js';
import { formatCard, renderAlert } from './explain.js';
import { htmlToText, money, shortAddr } from './format.js';
import { EventLog } from './events.js';
import { doctorExitCode, effectiveMode, formatDoctor, liveProbes, runDoctor } from './safety.js';
import { Fx } from './fx.js';
import { estimateRoundTrip, gasUsdFor } from './costs.js';
import { ruleIdFor } from './shadow.js';
import { hotWallet } from './wallet.js';

const log = getLogger('main');

const HELP = `crypto-trading-bot - token analyzer + practice / link / live trading bot

Usage: node src/index.js <command> [options]

Commands:
  analyze <address> [--chain C] [--timeframe 5m] [--json] [--mock]
        Verdict card (traffic light, reasons in money terms, round-trip cost, checks, identity) + full report:
        market (DexScreener) + security (GoPlus, honeypot.is, RugCheck) + round-trip quote (Jupiter / KyberSwap) + TA.
  run   Start the watchlist engine and the Telegram bot (BOT_TOKEN, ADMIN_IDS).
        Without BOT_TOKEN the engine runs alone on WATCHLIST from .env and prints notifications.
  backtest <address> [--chain C] [--timeframe 5m] [--limit 1000] [--ignore-risk] [--fixed-slippage] [--mock]
        Run the strategy over fetched OHLCV. Fills use pool price impact + token taxes (estimate) unless
        --fixed-slippage; prints how many trades the cost gate would have skipped.
  trackrecord [--window 7d|30d|all] [--json] [--mock]
        Grade past checks (1h/24h/7d after each) and print per-verdict stats with the baseline. Losers included.
  doctor [--mock]
        Self-check: config, DRY_RUN, keys present, API reachability, DB, clock, limits. Exit code 1 on any FAIL.
  mock [--cycles 2] [--mode paper|link|live] [--shadow-hours N] [--synthetic-history N]
        Offline end-to-end run with fixture tokens (no network, no credentials, DRY_RUN forced).
        Shows every feature: verdict cards, exit test, cost gate, copycat check, guardian, track record,
        seatbelts, /why trail, balance-drop auto-pause (simulated wallet), digest preview, doctor.
        --mode link shows swap links you would sign yourself.

Options:
  --chain       dexscreener chain id or alias (ethereum|eth, solana|sol, bsc, base, arbitrum, polygon, ...)
  --timeframe   1m 5m 15m 1h 4h 12h 1d (default TIMEFRAME from .env, 5m)
  -h, --help    this help

Modes: practice (paper, default) -> link (you sign swap links in your wallet, no keys; alerts say LIVE because
your own money moves) -> live (autopilot after graduation). DRY_RUN=true in .env is a hard lock: the bot itself
never spends real funds.

Examples:
  node src/index.js analyze 0x6982508145454Ce325dDbE47a25d4ec3d2311933
  node src/index.js analyze DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 --chain solana
  node src/index.js backtest DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 --timeframe 5m
  node src/index.js mock --cycles 2
  node src/index.js mock --cycles 3 --shadow-hours 0
  node src/index.js mock --mode link
  node src/index.js doctor
`;

/** Live signing executors are built lazily: never in practice or link mode. */
function buildExecutors(cfg, { offline = false } = {}) {
  let sol = null;
  let evm = null;
  return {
    paper: new PaperExecutor(cfg.trading),
    link: new LinkExecutor(),
    get solana() {
      return (sol ??= new JupiterExecutor(cfg, { dry: cfg.dryRun, offline }));
    },
    get evm() {
      return (evm ??= new EvmExecutor(cfg, { dry: cfg.dryRun, offline }));
    },
  };
}

/** A small engine for one-shot CLI commands (analyze, trackrecord): observations and Seen-before work. */
function cliEngine(cfg, ds, storage) {
  return new Engine({
    cfg, storage, dataSource: ds, notifier: { adminIds: [], send: async () => {} },
    executors: { paper: new PaperExecutor(cfg.trading) }, strategyFactory: strategyFactory(cfg.strategy, cfg.analysis),
  });
}

const mockProbes = () => ['DexScreener', 'GoPlus', 'GeckoTerminal', 'Jupiter'].map((name) => ({
  name: `${name} (mock)`, check: async () => ({ ok: true, detail: 'mock data source, offline' }),
}));

function requireAddress(positionals, cmd) {
  const address = extractAddress(positionals[1]);
  if (!address) throw new UsageError(`usage: node src/index.js ${cmd} <address> [--chain C]`);
  return address;
}

class UsageError extends Error {}

async function cmdAnalyze(cfg, { positionals, values }) {
  const address = requireAddress(positionals, 'analyze');
  const ds = values.mock ? new MockDataSource() : new LiveDataSource(cfg);
  if (values.timeframe) cfg.analysis.timeframe = values.timeframe;
  const storage = new Storage(values.mock ? ':memory:' : cfg.dbPath);
  try {
    const a = await cliEngine(cfg, ds, storage).analyze(address, normalizeChain(values.chain), { source: 'analyze', allowQuote: true });
    if (values.json) {
      const { candles, ...rest } = a;
      console.log(JSON.stringify({ ...rest, candles: candles.length, light: a.light, coverage: a.coverage, identity: a.identity }, null, 2));
    } else {
      console.log(`${htmlToText(formatCard(a))}\n\n${formatAnalysis(a)}`);
    }
  } finally {
    storage.close();
  }
}

async function cmdBacktest(cfg, { positionals, values }) {
  const address = requireAddress(positionals, 'backtest');
  const ds = values.mock ? new MockDataSource() : new LiveDataSource(cfg);
  const timeframe = values.timeframe ?? cfg.analysis.timeframe;
  const limit = Number(values.limit ?? 1000);
  const a = await analyzeToken(ds, address, { chain: normalizeChain(values.chain), timeframe, limit, p: cfg.analysis });
  if (!a.market) throw new UsageError(`no DEX pair found for ${address}`);
  if (!a.candles.length) throw new UsageError(`no OHLCV candles for ${a.market.token.symbol}: ${a.errors.join('; ')}`);
  const risk = values['ignore-risk'] ? null : a.risk;
  console.log(`${a.market.token.symbol} (${a.chain}) risk ${a.risk.score}/100 · verdict now ${a.verdict.verdict}`);
  if (risk?.hardAvoid || (risk && risk.score > cfg.analysis.maxBuyRisk)) {
    console.log(`Risk gate blocks entries (${risk.hardAvoid ? risk.hardReasons.join('; ') : `score ${risk.score} > ${cfg.analysis.maxBuyRisk}`}). Use --ignore-risk to test TA only.`);
  }
  const strategy = strategyFactory(cfg.strategy, cfg.analysis)();
  const costs = values['fixed-slippage'] ? null : {
    liquidityUsd: a.market.liquidityUsd ?? 0, buyTaxPct: a.security?.buyTaxPct ?? 0, sellTaxPct: a.security?.sellTaxPct ?? 0,
    dexFeeBps: cfg.analysis.dexFeeBps, networkFeeUsd: gasUsdFor(a.chain, cfg.analysis.gasUsd), costGateMult: cfg.analysis.costGateMult,
  };
  const res = runBacktest(a.candles, { strategy, analysis: cfg.analysis, trading: cfg.trading, risk, costs });
  console.log(formatBacktest(res, { symbol: a.market.token.symbol, timeframe, candles: a.candles }));
}

/** A whole-number CLI option (e.g. --cycles 2): a clear usage error instead of NaN. */
function intOption(values, name, { def, min = 0 }) {
  if (values[name] === undefined) return def;
  const n = Number(values[name]);
  if (!Number.isInteger(n) || n < min) throw new UsageError(`--${name} must be a whole number of ${min} or more (got "${values[name]}")`);
  return n;
}

/** Validate mock's numeric options before anything runs. */
function mockOptions(values) {
  const cycles = intOption(values, 'cycles', { def: 2, min: 1 });
  const synthetic = intOption(values, 'synthetic-history', { def: 0, min: 0 });
  let shadowHours;
  if (values['shadow-hours'] !== undefined) {
    shadowHours = Number(values['shadow-hours']);
    if (!Number.isFinite(shadowHours) || shadowHours < 0) throw new UsageError(`--shadow-hours must be a number of 0 or more (got "${values['shadow-hours']}")`);
  }
  return { cycles, synthetic, shadowHours };
}

async function cmdMock(cfg, { values }) {
  const { cycles, synthetic, shadowHours } = mockOptions(values);
  const mode = values.mode ?? 'paper';
  // Mock never touches the network or real funds.
  cfg.dryRun = true;
  cfg.mode = mode;
  cfg.events.peerFiles = [];
  if (shadowHours !== undefined) {
    cfg.shadow.minHours = shadowHours;
    cfg.shadow.maxHours = shadowHours;
  }
  const dbPath = path.join(ROOT, 'data', 'mock.db');
  const eventsPath = path.join(ROOT, 'data', 'mock-events.jsonl');
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, eventsPath, `${eventsPath}.1`]) fs.rmSync(f, { force: true });
  cfg.events.file = eventsPath;
  const storage = new Storage(dbPath);
  const ds = new MockDataSource();
  const notifier = new Notifier({ adminIds: [] }); // stdout
  const executors = buildExecutors(cfg, { offline: true });
  const engine = new Engine({
    cfg, storage, dataSource: ds, notifier, executors, eventLog: new EventLog({ file: eventsPath, maxMb: cfg.events.maxMb }),
    strategyFactory: strategyFactory(cfg.strategy, cfg.analysis),
    // Fixed FX rates offline (DISPLAY_CURRENCY=rub|eur shows them next to USD; usd shows USD only).
    fx: new Fx({ currency: cfg.ui.displayCurrency, fetchRates: async () => ({ rub: 90, eur: 0.92 }) }),
  });
  engine.setMode(mode);
  console.log(`=== MOCK run: ${cycles} cycle(s), mode=${mode} (${engine.tag()}), DRY_RUN=true, db=${path.relative(ROOT, dbPath)}, events=${path.relative(ROOT, eventsPath)} ===\n`);

  const symCount = new Map();
  for (const t of MOCK_TOKENS) symCount.set(t.symbol, (symCount.get(t.symbol) ?? 0) + 1);
  const label = (sym, addr) => (symCount.get(sym) > 1 ? `${sym} (${shortAddr(addr)})` : sym);

  for (const t of MOCK_TOKENS) {
    const a = await engine.watch(t.address, t.chain);
    console.log(`--- /watch ${t.label} ---\n${htmlToText(formatCard(a, { now: engine.now() }))}\n\n${formatAnalysis(a)}\n`);
  }
  for (let i = 1; i <= cycles; i++) {
    console.log(`=== cycle ${i} ===`);
    const results = await engine.tick();
    for (const r of results) {
      console.log(`  ${label(r.symbol, r.address).padEnd(9)} ${String(r.verdict).padEnd(5)} risk ${String(r.risk).padStart(3)}  -> ${r.action}${r.note ? ` (${r.note})` : ''}${r.reason ? ` (${r.reason})` : ''}`);
    }
    if (mode === 'link') {
      // Simulate the user's taps: [I bought] for every link buy, [I sold] for every sell link.
      for (const id of [...engine.linkPending.keys()]) {
        console.log(`  (mock) tap [I bought] -> ${(await engine.confirmLinkBuy(id)).message}`);
      }
      for (const p of storage.listOpenPositions('link')) {
        if (storage.getKv(`link_exit:${p.id}`, null)) console.log(`  (mock) tap [I sold] -> ${(await engine.confirmLinkSell(p.id)).message}`);
      }
    }
    ds.advance();
  }

  const tour = engine.tourIntro();
  console.log(`\n=== /start on a fresh DB (tour) ===\n${htmlToText(tour.text)}\n${tour.buttons.flat().map((b) => `[${b.text}]`).join(' ')}`);
  console.log(`Sample tokens: ${cfg.sampleTokens.map((t) => `${t.chain}:${shortAddr(t.address)}`).join(', ')} (mock uses MOCKGOOD)`);

  console.log('\n=== /buy MOCKGOOD 200 (confirmation card; the mock taps Cancel) ===');
  const good = MOCK_TOKENS[0];
  const ga = await engine.analyze(good.address, good.chain, { allowQuote: true });
  const pid = engine.createPendingBuy({ a: ga, usd: 200 });
  console.log(renderAlert(engine.confirmCard(pid)).text);
  console.log(`(mock) tap [Cancel] -> ${(await engine.resolvePending(pid, 'no')).message}`);

  console.log('\n=== /buy MOCKBASE 250 (over the per-trade limit) ===');
  let limitSkipId = null;
  try {
    await engine.buy(MOCK_TOKENS[1].address, 250, { reason: 'manual /buy' });
  } catch (err) {
    if (!(err instanceof TradeRefused)) throw err;
    console.log(`Refused: ${err.message}`);
    limitSkipId = storage.decisionsFor(MOCK_TOKENS[1].address, 1)[0]?.id ?? null;
    const ba = engine.lastAnalysis.get(MOCK_TOKENS[1].address.toLowerCase());
    engine.shadow.record({ ruleId: `skip:${err.code}`, a: ba, sizeUsd: 250, reasonCode: err.code });
    engine.shadow.markAll([ba]);
  }

  console.log('\n=== /cost MOCKTHIN ===');
  console.log(await engine.costText(MOCK_TOKENS[3].address));
  const ex = estimateRoundTrip({ sizeUsd: 500, liquidityUsd: 40_000, buyTaxPct: 5, sellTaxPct: 5, dexFeeBps: cfg.analysis.dexFeeBps, networkFeeUsd: 0.02 });
  console.log(`Net-of-fees example (5%+5% tax, $40K pool): if you buy $500 now you could sell back for about $${ex.getBackUsd.toFixed(2)}; needs +${ex.breakevenPct.toFixed(1)}% to break even (estimate).`);

  console.log(`\n${await engine.positionsText()}`);
  const closedRows = storage.db.prepare(`SELECT symbol, mode, realized_pnl_usd AS pnl, close_reason AS reason FROM positions WHERE status = 'closed' ORDER BY id`).all();
  if (closedRows.length) console.log(`Closed positions:\n${closedRows.map((r) => `  ${r.symbol} [${engine.modeName(r.mode)}] pnl ${r.pnl >= 0 ? '+' : '-'}$${Math.abs(r.pnl).toFixed(2)} · close_reason '${r.reason}'`).join('\n')}`);
  console.log(`\n${await engine.pnlText()}`);

  const thin = storage.decisionsFor(MOCK_TOKENS[3].address, 20).reverse().find((d) => d.kind === 'skip');
  if (thin) console.log(`\n=== /why ${thin.id} (MOCKTHIN) ===\n${engine.whyText(thin.id)}`);
  if (limitSkipId) console.log(`\n=== /why ${limitSkipId} (MOCKBASE limit) ===\n${engine.whyText(limitSkipId)}`);

  console.log(`\n=== /guardian ===\n${engine.guardianText()}`);

  const fills = storage.listShadowFills();
  if (fills.length) {
    console.log('\n=== shadow fills (would have bought; marked net of fees) ===');
    for (const f of fills) {
      const m = JSON.parse(f.meta ?? '{}');
      console.log(`  #${f.id} ${f.rule_id} ${m.symbol} $${m.sizeUsd.toFixed(2)} @ $${f.entry_price.toPrecision(4)} (entry costs $${f.entry_costs.toFixed(2)}) -> net now $${(m.netValue ?? m.sizeUsd).toFixed(2)} · ${f.outcome}`);
    }
  }

  console.log(`\n=== /scoreboard ===\n${engine.scoreboardText()}`);
  console.log(`\n=== /safety ===\n${engine.safetyText()}`);
  console.log(`\n${engine.graduation().text}`);

  console.log('\n=== /panic then /resume (confirm) ===');
  const pmode = engine.mode;
  await engine.panic('mock demo');
  try {
    await engine.buy(MOCK_TOKENS[0].address, 10);
  } catch (err) {
    console.log(`/buy during panic -> Refused: ${err.message}`);
  }
  console.log(`/resume -> [Confirm resume] -> ${engine.resumeFromPanic()}`);
  engine.setMode(pmode);

  // The run loop reads the real hot wallet every 5 min in live mode with DRY_RUN=false; here a simulated wallet.
  console.log('\n=== balance-drop auto-pause (simulated hot wallet, no bot trades in between) ===');
  const readings = [500, 470, 320];
  let reading = 0;
  engine.wallet = { label: 'simulated USDC', balanceUsd: async () => readings[reading] };
  for (; reading < readings.length; reading++) {
    const usd = readings[reading];
    console.log(`(mock) wallet reads ${money(usd)}${reading ? ` (${(((readings[0] - usd) / readings[0]) * 100).toFixed(0)}% below the first reading)` : ' (first reading: the baseline)'}`);
    const r = await engine.checkBalance({ force: true });
    if (!r.pause) console.log(`  -> no pause (threshold AUTO_PAUSE_BALANCE_DROP_PCT=${engine.cfg.safety.autoPauseBalanceDropPct})`);
  }
  console.log(`paused: ${engine.paused ? 'yes' : 'no'}\n${engine.balanceWatchLine()}`);
  const resumed = engine.resumeFromButton(engine.pauseInfo?.id);
  console.log(`(mock) tap [Resume] -> ${resumed} paused: ${engine.paused ? 'yes' : 'no'}; the next reading starts a new baseline`);
  engine.wallet = null;

  const d = engine.digest({ peerWarn: () => {} });
  console.log(`\n=== digest preview ===\n${d.text}${d.buttons.length ? `\n${d.buttons.flat().map((b) => `[${b.text}]`).join(' ')}` : ''}`);

  if (synthetic) {
    engine.tracker.insertSynthetic(synthetic, engine.now());
    console.log(`\n(synthetic) inserted ${synthetic} deterministic synthetic observations into the mock DB only`);
  }
  const travel = ds.now + 8 * 86_400_000;
  console.log('\ntime-travel: evaluating 1h/24h/7d horizons at current mock prices');
  const tr = await engine.tracker.runDue(travel);
  console.log(`  due ${tr.due} · outcomes written ${tr.written} · batch calls ${tr.batchCalls} · OHLCV calls ${tr.ohlcvCalls}`);
  console.log(`\n=== /trackrecord ===\n${engine.tracker.report({ window: 'all', now: travel, sizeUsd: cfg.trading.sizeUsd }).text}`);

  if (values['shadow-hours'] !== undefined) {
    console.log('\n=== hindsight cards (end of run, net of fees) ===');
    for (const w of storage.listWatch().filter((x) => x.state === 'shadow')) {
      const st = engine.shadow.ruleStats(ruleIdFor(w.address));
      if (st.n) console.log(engine.shadow.cardText({ watch: w, stats: st, hours: (engine.now() - w.addedAt) / 3_600_000 }, { dryRun: true, verdictRecord: engine.verdictRecordLine() }));
    }
  }

  const rows = await runDoctor({ cfg: engine.cfg, storage, mode, probes: mockProbes(), now: () => engine.now() });
  console.log(`\n=== doctor (mock clients) ===\n${formatDoctor(rows)}`);

  const counts = storage.db.prepare('SELECT side, dry, mode, COUNT(*) AS n FROM trades GROUP BY side, dry, mode').all();
  console.log(`\nSQLite trades: ${counts.map((c) => `${c.mode}:${c.side}${c.dry ? '(dry)' : ''}=${c.n}`).join(', ') || 'none'}`);
  console.log(`Event log: ${engine.events.read({}).length} lines in ${path.relative(ROOT, eventsPath)}`);
  console.log(`Live signing executors constructed: ${mode === 'live' ? 'only on demand (DRY_RUN)' : 'none'}`);
  storage.close();
  console.log('\nMock run finished OK.');
}

async function cmdTrackrecord(cfg, { values }) {
  const window = values.window ?? 'all';
  if (!['7d', '30d', 'all'].includes(window)) throw new UsageError('--window must be 7d, 30d or all');
  const storage = new Storage(values.mock ? path.join(ROOT, 'data', 'mock.db') : cfg.dbPath);
  try {
    const ds = values.mock ? new MockDataSource() : new LiveDataSource(cfg);
    const engine = cliEngine(cfg, ds, storage);
    try {
      await engine.tracker.runDue(Date.now());
    } catch (err) {
      log.warn(`could not grade new outcomes: ${err.message}`);
    }
    const r = engine.tracker.report({ window, sizeUsd: cfg.trading.sizeUsd });
    if (values.json) {
      const { byVerdict, ...rest } = r.summary;
      const slim = Object.fromEntries(Object.entries(byVerdict).map(([k, v]) => [k, { ...v, rows: v.rows.length }]));
      console.log(JSON.stringify({ ...rest, byVerdict: slim, caveat: 'Only tokens checked with this bot; not a promise of future results' }, null, 2));
    } else console.log(r.text);
  } finally {
    storage.close();
  }
}

async function cmdDoctor(cfg, { values }) {
  const storage = new Storage(values.mock ? ':memory:' : cfg.dbPath);
  try {
    const mode = effectiveMode(storage, cfg);
    const wallet = values.mock ? null : hotWallet(cfg, buildExecutors(cfg));
    const rows = await runDoctor({
      cfg, storage, mode, probes: values.mock ? mockProbes() : liveProbes(cfg), walletBalanceUsd: wallet ? () => wallet.balanceUsd() : null,
    });
    console.log(formatDoctor(rows));
    process.exitCode = doctorExitCode(rows);
  } finally {
    storage.close();
  }
}

async function cmdRun(cfg) {
  const storage = new Storage(cfg.dbPath);
  const notifier = new Notifier({ adminIds: cfg.adminIds, colors: cfg.ui.buttonColors });
  const executors = buildExecutors(cfg);
  // Hot-wallet reader for the balance-drop auto-pause and doctor: only with DRY_RUN=false and a wallet key.
  const wallet = hotWallet(cfg, executors);
  const engine = new Engine({
    cfg, storage, dataSource: new LiveDataSource(cfg), notifier, executors, wallet,
    strategyFactory: strategyFactory(cfg.strategy, cfg.analysis),
    eventLog: new EventLog({ file: cfg.events.file, maxMb: cfg.events.maxMb }),
  });
  for (const addr of cfg.watchlistSeed) {
    try {
      const a = await engine.watch(addr);
      log.info(`watching ${a.market.token.symbol} (${a.chain}) from WATCHLIST`);
    } catch (err) {
      log.warn(`WATCHLIST ${addr}: ${err.message}`);
    }
  }

  let bot = null;
  if (cfg.botToken) {
    if (!cfg.adminIds.length) throw new ConfigError('ADMIN_IDS is empty in .env: set your Telegram user id (comma-separated for several)');
    const { createBot, COMMANDS } = await import('./bot.js');
    bot = createBot({
      token: cfg.botToken, adminIds: cfg.adminIds, engine,
      doctor: () => runDoctor({
        cfg: engine.cfg, storage, mode: engine.mode, probes: liveProbes(engine.cfg), walletBalanceUsd: wallet ? () => wallet.balanceUsd() : null,
      }),
    });
    notifier.attach(bot.api);
    await bot.api.setMyCommands(COMMANDS.map(([command, description]) => ({ command, description: description.slice(0, 256) }))).catch((e) => log.warn(`setMyCommands: ${e.message}`));
    bot.start({ onStart: (me) => log.info(`telegram bot @${me.username} started (token ${mask(cfg.botToken)})`) }).catch((err) => {
      log.error(`telegram bot stopped: ${err.message}`);
      process.exitCode = 1;
      engine.stop();
    });
  } else {
    log.warn('BOT_TOKEN is empty: Telegram bot disabled, notifications go to stdout. Watchlist comes from WATCHLIST in .env.');
  }
  log.info(`mode=${engine.mode} DRY_RUN=${cfg.dryRun} watchlist=${storage.listWatch().length}`);

  const shutdown = async () => {
    log.info('shutting down...');
    engine.stop();
    if (bot) await bot.stop().catch(() => {});
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await engine.start();
  storage.close();
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      chain: { type: 'string' },
      timeframe: { type: 'string' },
      limit: { type: 'string' },
      cycles: { type: 'string' },
      mode: { type: 'string' },
      window: { type: 'string' },
      'shadow-hours': { type: 'string' },
      'synthetic-history': { type: 'string' },
      json: { type: 'boolean' },
      mock: { type: 'boolean' },
      'ignore-risk': { type: 'boolean' },
      'fixed-slippage': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const cmd = positionals[0];
  if (!cmd || values.help || cmd === 'help') {
    console.log(HELP);
    return;
  }
  if (values.mode === 'practice') values.mode = 'paper';
  if (values.mode && !['paper', 'link', 'live'].includes(values.mode)) throw new UsageError('--mode must be paper (practice), link or live');
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (cmd === 'doctor' && err instanceof ConfigError) {
      console.log(formatDoctor([{ name: 'config', status: 'FAIL', detail: err.message, hint: 'fix the key named above in .env (see .env.example)' }]));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  setLogLevel(cfg.logLevel);
  switch (cmd) {
    case 'analyze':
      return cmdAnalyze(cfg, { positionals, values });
    case 'backtest':
      return cmdBacktest(cfg, { positionals, values });
    case 'mock':
      return cmdMock(cfg, { values });
    case 'run':
      return cmdRun(cfg);
    case 'trackrecord':
      return cmdTrackrecord(cfg, { values });
    case 'doctor':
      return cmdDoctor(cfg, { values });
    default:
      throw new UsageError(`unknown command "${cmd}". See --help.`);
  }
}

main(process.argv.slice(2)).then(
  () => {
    // Let pending handles (keep-alive sockets) not block exit for one-shot commands.
    if (!['run'].includes(process.argv[2])) setImmediate(() => process.exit(process.exitCode ?? 0));
  },
  (err) => {
    if (err instanceof ConfigError) console.error(`Config error: ${err.message}`);
    else if (err instanceof UsageError || err?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') console.error(err.message);
    else console.error(`Error: ${err?.stack ?? err}`);
    process.exit(err instanceof ConfigError ? 2 : 1);
  },
);
