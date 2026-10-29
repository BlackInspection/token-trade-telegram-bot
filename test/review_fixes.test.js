// Regression tests for the review findings: live gate, /panic exits, auto-entry gates, buy race, stale /buy cards,
// guardian exit failures, identity lookup failures, pair selection, unconfirmed real swaps, doctor statuses.
import '../src/warnings.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, LOOSEN_DIRECTION } from '../src/config.js';
import { Storage } from '../src/storage.js';
import { Engine } from '../src/engine.js';
import { MockDataSource, MOCK_TOKENS } from '../src/data/mock.js';
import { strategyFactory } from '../src/strategy.js';
import { PaperExecutor } from '../src/executors/paper.js';
import { ExecutionError, markSent } from '../src/executors/base.js';
import { entryBlock } from '../src/analyzer.js';
import { resolveIdentity } from '../src/data/identity.js';
import { pickBestPair } from '../src/data/dexscreener.js';
import { effectiveMode, liveProbes, probeResult, runDoctor } from '../src/safety.js';

const [GOOD, BASE, , THIN, FAKE, RUG] = MOCK_TOKENS;
const T0 = 1_800_000_000_000;

/** Real-funds executor stand-in: records every call; never touches a network. */
function spyExecutor(name, calls, { delayMs = 0, sell = null, buy = null } = {}) {
  return {
    async buy({ token, usd, price }) {
      calls.push(`${name} BUY ${token.symbol} $${usd}`);
      if (buy) return buy({ token, usd, price });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return { side: 'BUY', price, qty: usd / price, usd, feeUsd: 0, venue: name, txId: 'tx', dry: false };
    },
    async sell({ token, qty, price }) {
      calls.push(`${name} SELL ${token.symbol}`);
      if (sell) return sell({ token, qty, price });
      return { side: 'SELL', price, qty, usd: qty * price, feeUsd: 0, venue: name, txId: 'tx', dry: false };
    },
  };
}

function setup(overrides = {}, { storage = null, executorOpts = {} } = {}) {
  const cfg = defaultConfig(overrides);
  const st = storage ?? new Storage(':memory:');
  const ds = new MockDataSource({ now: T0 });
  const messages = [];
  const calls = [];
  const engine = new Engine({
    cfg, storage: st, dataSource: ds, notifier: { adminIds: [], send: async (t) => void messages.push(t) },
    executors: { paper: new PaperExecutor(cfg.trading), solana: spyExecutor('solana', calls, executorOpts), evm: spyExecutor('evm', calls, executorOpts) },
    strategyFactory: strategyFactory(cfg.strategy, cfg.analysis),
  });
  return { cfg, storage: st, ds, engine, messages, calls };
}

const realCalls = (calls) => calls.filter((c) => / (BUY|SELL) /.test(c));

// ------------------------------------------------------------------ 1. live gate (high)

test('live gate: a mode "live" saved under DRY_RUN=true never spends real funds after DRY_RUN=false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctb-gate-'));
  const db = path.join(dir, 'g.db');
  try {
    // Session 1: practising with DRY_RUN=true, /mode live is allowed without graduation (nothing real happens).
    const s1 = setup({ SHADOW_NEW_RULES: 'false' }, { storage: new Storage(db) });
    assert.equal(s1.engine.requestLiveMode({}).mode, 'live');
    assert.equal(s1.engine.mode, 'live');
    s1.storage.close();

    // Session 2: DRY_RUN=false in .env and a restart. No graduation, no confirm button: practice.
    const s2 = setup({ DRY_RUN: 'false', SHADOW_NEW_RULES: 'false' }, { storage: new Storage(db) });
    assert.equal(s2.engine.mode, 'paper');
    assert.equal(s2.engine.tag(), 'PRACTICE');
    assert.match(s2.engine.safetyText(), /Live gate: locked until graduation/);
    await s2.engine.watch(GOOD.address, GOOD.chain);
    await s2.engine.tick();
    assert.deepEqual(realCalls(s2.calls), [], 'no real executor call');
    assert.ok(s2.storage.getOpenPosition(GOOD.address, 'paper'), 'it traded on paper instead');
    // The run loop makes it visible at startup.
    assert.equal(await s2.engine.checkLiveGate(), true);
    assert.equal(s2.storage.getKv('mode'), 'paper');
    assert.ok(s2.messages.some((m) => /Live gate: the saved mode "live" .* was never confirmed with DRY_RUN=false/.test(m)));
    s2.storage.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('live gate: TRADING_MODE=live with DRY_RUN=false is practice until /mode live is confirmed in the bot', async () => {
  const { engine, storage, calls, messages } = setup({ DRY_RUN: 'false', TRADING_MODE: 'live', SHADOW_NEW_RULES: 'false' });
  assert.equal(engine.mode, 'paper');
  assert.equal(effectiveMode(storage, engine.cfg), 'paper');
  await engine.watch(GOOD.address, GOOD.chain);
  await engine.tick();
  assert.deepEqual(realCalls(calls), []);
  assert.equal(await engine.checkLiveGate(), true);
  assert.ok(messages.some((m) => /TRADING_MODE=live in \.env was never confirmed/.test(m)));
  // The bot path: refused before graduation, so the flag is never written.
  assert.throws(() => engine.requestLiveMode({ phrase: 'x' }), /locked until graduation/);
  assert.equal(engine.liveConfirmed, false);
  // The confirmed switch (what requestLiveMode does after graduation + Confirm LIVE) opens it ...
  engine.setMode('live', { confirm: true });
  assert.equal(engine.mode, 'live');
  assert.equal(engine.tag(), 'LIVE');
  assert.match(engine.safetyText(), /Live gate: OPEN/);
  // ... and any other mode change closes it again.
  engine.setMode('paper');
  storage.setKv('mode', 'live');
  assert.equal(engine.mode, 'paper');
  storage.close();
});

// ------------------------------------------------------------------ 2. /panic keeps exits running (high)

test('/panic stops buying but stop-loss still sells a real-funds position; /sell reaches it in any mode', async () => {
  const { engine, storage, ds, calls } = setup({ DRY_RUN: 'false' });
  engine.setMode('live', { confirm: true });
  await engine.watch(BASE.address, BASE.chain);
  await engine.buy(BASE.address, 50, { reason: 'manual /buy' });
  await engine.buy(GOOD.address, 20, { reason: 'manual /buy' });
  assert.deepEqual(realCalls(calls), ['evm BUY MOCKBASE $50', 'solana BUY MOCKGOOD $20']);
  const text = await engine.panic('test');
  assert.match(text, /Stop-loss, take-profit and trailing exits keep running for every open position, real-funds ones included/);
  assert.equal(engine.mode, 'paper');
  await assert.rejects(engine.buy(GOOD.address, 10), /panic stop is on/);
  // MOCKBASE hits its stop on the next step: the live position is sold through the real executor.
  ds.advance();
  await engine.tick();
  assert.ok(calls.includes('evm SELL MOCKBASE'), calls.join(' | '));
  assert.equal(storage.getOpenPosition(BASE.address, 'live'), null);
  assert.equal(storage.listClosedPositions({ mode: 'live' })[0].closeReason, 'STOP_LOSS');
  // /sell without a mode finds the live MOCKGOOD position although the bot is in practice now.
  const r = await engine.sell(GOOD.address, 100, 'manual /sell');
  assert.equal(r.closed, true);
  assert.ok(calls.includes('solana SELL MOCKGOOD'));
  await assert.rejects(engine.sell(GOOD.address), /no open practice position/);
  storage.close();
});

test('a DRY_RUN live position is closed with a simulated fill after DRY_RUN=false; a real one is refused under DRY_RUN=true', async () => {
  const { engine, storage, calls } = setup({ DRY_RUN: 'false' });
  engine.setMode('live', { confirm: true });
  const a = await engine.analyze(GOOD.address, GOOD.chain);
  const token = { address: a.address, chain: a.chain, symbol: 'MOCKGOOD' };
  engine.portfolio.recordBuy({ mode: 'live', dry: true, token, fill: { price: a.market.priceUsd, qty: 50 / a.market.priceUsd, usd: 50, feeUsd: 0 }, levels: null });
  const r = await engine.sell(GOOD.address, 100, 'manual /sell');
  assert.equal(r.fill.dry, true);
  assert.deepEqual(realCalls(calls), [], 'the real executor would sell whatever the wallet holds');
  storage.close();

  const d = setup({ DRY_RUN: 'true' });
  d.engine.setMode('live');
  const b = await d.engine.analyze(GOOD.address, GOOD.chain);
  d.engine.portfolio.recordBuy({ mode: 'live', dry: false, token: { address: b.address, chain: b.chain, symbol: 'MOCKGOOD' }, fill: { price: b.market.priceUsd, qty: 1, usd: 50, feeUsd: 0 }, levels: null });
  await assert.rejects(d.engine.sell(GOOD.address), /bought with real funds but DRY_RUN=true now/);
  d.storage.close();
});

// ------------------------------------------------------------------ 3. auto-entry gates (high)

test('MOCKTHIN (cost gate) and MOCKFAKE (copycat) are never auto-bought over 8 cycles', async () => {
  for (const T of [THIN, FAKE]) {
    const { engine, storage, ds } = setup();
    await engine.watch(T.address, T.chain);
    for (let i = 1; i <= 8; i++) {
      const [r] = await engine.tick();
      assert.notEqual(r.action, 'BUY', `${T.symbol} cycle ${i}: ${r.note ?? r.reason ?? ''}`);
      ds.advance();
    }
    assert.equal(storage.listOpenPositions('paper').length, 0);
    storage.close();
  }
});

test('a tightened max_buy_risk applies at once to strategies and auto-buys (no buy of MOCKTHIN / MOCKFAKE)', async () => {
  const { engine, storage, ds } = setup();
  await engine.watch(GOOD.address, GOOD.chain);
  await engine.tick();
  assert.ok(engine.strategies.size > 0);
  engine.changeSetting('max_buy_risk', '10');
  assert.equal(engine.strategies.size, 0, 'strategies are rebuilt from the tuned cfg.analysis');
  await engine.watch(THIN.address, THIN.chain);
  await engine.watch(FAKE.address, FAKE.chain);
  for (let i = 0; i < 2; i++) {
    for (const r of await engine.tick()) {
      if (r.address !== GOOD.address) assert.notEqual(r.action, 'BUY', `${r.symbol}: ${r.note ?? ''}`);
    }
    ds.advance();
  }
  assert.equal(storage.getOpenPosition(THIN.address, 'paper'), null);
  assert.equal(storage.getOpenPosition(FAKE.address, 'paper'), null);
  storage.close();
});

test('entryBlock checks clone, failed identity, tuned risk, cost gate and net profit whatever the TA verdict', async () => {
  const { engine, storage } = setup();
  const p = engine.cfg.analysis;
  const thin = await engine.analyze(THIN.address, THIN.chain);
  const fake = await engine.analyze(FAKE.address, FAKE.chain);
  const good = await engine.analyze(GOOD.address, GOOD.chain);
  const watch = (a) => ({ ...a, verdict: { verdict: 'WATCH', why: 'uptrend but no fresh EMA cross' } }); // no cap
  assert.equal(entryBlock(watch(thin), p).suite, 'FEES_EAT_PROFIT');
  assert.equal(entryBlock(watch(fake), p).suite, 'POSSIBLE_CLONE');
  assert.equal(entryBlock(watch(good), { ...p, maxBuyRisk: -1 }).suite, 'RISK_SCORE_HIGH');
  assert.equal(entryBlock(watch({ ...good, identity: { status: 'unknown', error: 'HTTP 429' } }), p).suite, 'IDENTITY_UNKNOWN');
  assert.equal(entryBlock(watch({ ...good, identity: { status: 'unknown' } }), p), null, 'a source without the check is not a failure');
  assert.equal(entryBlock(watch(good), { ...p, minNetProfitUsd: 1000 }).suite, 'FEES_EAT_PROFIT');
  assert.equal(entryBlock(watch(good), p), null);
  // buy() refuses an automatic buy of a copycat even when the verdict carries no cap.
  await assert.rejects(engine.buy(FAKE.address, null, { analysis: watch(fake), auto: true }), (e) => e.code === 'POSSIBLE_CLONE');
  storage.close();
});

// ------------------------------------------------------------------ 4. limits under concurrency (high)

test('two buys in flight cannot both pass max open positions, the hourly cap or the daily budget', async () => {
  for (const limits of [
    { MAX_OPEN_POSITIONS: '1' },
    { MAX_TRADES_PER_HOUR: '1' },
    { DAILY_BUDGET_USD: '100', MAX_TRADE_USD: '100', CONFIRM_ABOVE: '100' },
  ]) {
    const { engine, storage, calls } = setup({ DRY_RUN: 'false', ...limits }, { executorOpts: { delayMs: 30 } });
    engine.setMode('live', { confirm: true });
    const a0 = await engine.analyze(GOOD.address, GOOD.chain);
    const a1 = await engine.analyze(BASE.address, BASE.chain);
    const rs = await Promise.allSettled([
      engine.buy(a0.address, 80, { analysis: a0, confirmed: true }),
      engine.buy(a1.address, 80, { analysis: a1, confirmed: true }),
    ]);
    assert.deepEqual(rs.map((r) => r.status), ['fulfilled', 'rejected'], JSON.stringify(limits));
    assert.equal(realCalls(calls).length, 1);
    assert.equal(storage.listOpenPositions('live').length, 1);
    storage.close();
  }
});

test('a real swap that was sent but not confirmed keeps counting against the limits', async () => {
  const sent = { buy: async () => { throw markSent(new ExecutionError('confirmTransaction timed out'), 'SIG123'); } };
  const { engine, storage, messages } = setup({ DRY_RUN: 'false', DAILY_BUDGET_USD: '100', MAX_TRADE_USD: '100', CONFIRM_ABOVE: '100' }, { executorOpts: sent });
  engine.setMode('live', { confirm: true });
  await assert.rejects(engine.buy(GOOD.address, 80), /confirmTransaction timed out/);
  assert.equal(engine.unconfirmedBuys('live').length, 1);
  assert.ok(messages.some((m) => /UNCONFIRMED real BUY MOCKGOOD \$80 \(tx SIG123\)/.test(m)));
  assert.match(engine.safetyText(), /Unconfirmed real buys: MOCKGOOD \$80/);
  await assert.rejects(engine.buy(BASE.address, 50), (e) => e.code === 'LIMIT_DAILY_BUDGET');
  storage.close();

  // An error before anything was sent releases the reservation.
  const pre = { buy: async () => { throw new ExecutionError('quote failed: HTTP 500'); } };
  const p = setup({ DRY_RUN: 'false' }, { executorOpts: pre });
  p.engine.setMode('live', { confirm: true });
  await assert.rejects(p.engine.buy(GOOD.address, 80), /quote failed/);
  assert.equal(p.engine.unconfirmedBuys('live').length, 0);
  p.storage.close();
});

// ------------------------------------------------------------------ mediums

test('a pending /buy card made in live mode is not executed after /mode paper', async () => {
  const { engine, storage, calls } = setup({ DRY_RUN: 'false' });
  engine.setMode('live', { confirm: true });
  const a = await engine.analyze(GOOD.address, GOOD.chain, { allowQuote: true });
  const id = engine.createPendingBuy({ a, usd: 20 });
  engine.setMode('paper');
  await assert.rejects(engine.resolvePending(id, 'ok'), /cancelled: the mode changed \(live -> paper\)/);
  assert.deepEqual(realCalls(calls), []);
  // A card whose mode no longer matches is refused even if it was not marked.
  const id2 = engine.createPendingBuy({ a, usd: 20, mode: 'live' });
  await assert.rejects(engine.resolvePending(id2, 'ok'), /mode changed/);
  storage.close();
});

test('guardian: a failed auto-exit still sends the alert with Sell buttons and is retried on later ticks', async () => {
  let fail = true;
  const sell = async ({ qty, price }) => {
    if (fail) throw new ExecutionError('swap reverted: TRANSFER_FROM_FAILED');
    return { side: 'SELL', price, qty, usd: qty * price, feeUsd: 0, venue: 'evm', txId: 'tx', dry: false };
  };
  const { engine, storage, ds, messages } = setup({ DRY_RUN: 'false', GUARDIAN_LIVE_EXIT: 'true', SHADOW_NEW_RULES: 'false' }, { executorOpts: { sell } });
  engine.setMode('live', { confirm: true });
  await engine.watch(RUG.address, RUG.chain);
  await engine.tick();
  assert.ok(storage.getOpenPosition(RUG.address, 'live'));
  ds.advance();
  await engine.tick();
  const alert = messages.find((m) => /^LIVE GUARDIAN \[MOCKRUG\] Sell tax went from 5% to 35%.*auto-exit FAILED \(swap reverted/.test(m));
  assert.ok(alert, messages.join('\n---\n'));
  assert.match(alert, /\[Sell 100%\] \[Sell 50%\]/);
  assert.equal(storage.db.prepare("SELECT action FROM guardian_events WHERE type = 'TAX_UP'").get().action, 'exit_failed');
  fail = false;
  ds.advance();
  const [r] = await engine.tick();
  assert.equal(r.action, 'SELL');
  assert.equal(r.reason, 'GUARDIAN: TAX_UP');
  assert.equal(storage.getOpenPosition(RUG.address, 'live'), null);
  assert.equal(storage.getKv(`guardian_retry:${RUG.address.toLowerCase()}`), null);
  storage.close();
});

test('identity: a failed GeckoTerminal lookup is unknown, never "unlisted"', async () => {
  const now = Date.UTC(2026, 9, 28);
  const DAY = 86_400_000;
  const ORIG = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const market = { chain: 'solana', token: { address: 'Fake1111111111111111111111111111111111111111', symbol: 'BONK', name: 'Bonk' }, pairCreatedAt: now - 2 * 3_600_000, liquidityUsd: 5_000_000 };
  const pairs = [{ chainId: 'solana', baseToken: { address: ORIG, symbol: 'Bonk', name: 'Bonk' }, liquidity: { usd: 2_000_000 }, pairCreatedAt: now - 900 * DAY }];
  const src = ({ failOrig = false, failSelf = false } = {}) => ({
    getTokenInfo: async (_c, addr) => {
      if ((addr === ORIG && failOrig) || (addr !== ORIG && failSelf)) throw new Error('HTTP 429');
      return addr === ORIG ? { coingeckoId: 'bonk' } : null;
    },
    jupiterVerified: async () => false,
    searchPairs: async () => pairs,
  });
  assert.equal((await resolveIdentity(src(), market, { now })).status, 'possible_clone');
  const a = await resolveIdentity(src({ failOrig: true }), market, { now });
  assert.equal(a.status, 'unknown');
  assert.match(a.error, /HTTP 429/);
  assert.equal((await resolveIdentity(src({ failSelf: true }), market, { now })).status, 'unknown');
});

test('pickBestPair ignores a bogus pool with huge liquidity at a nonsense price', () => {
  const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const pair = (id, quote, price, liq, vol) => ({
    chainId: 'solana', pairAddress: id, baseToken: { address: BONK, symbol: 'Bonk' }, quoteToken: { address: `q${id}`, symbol: quote },
    priceUsd: String(price), liquidity: { usd: liq }, volume: { h24: vol },
  });
  const pairs = [
    pair('bogus', 'JUP', 0.01566, 37_940_000, 195_450),
    pair('orca', 'SOL', 0.00000316, 4_000_000, 9_000_000),
    pair('meteora', 'USDC', 0.00000317, 1_500_000, 2_000_000),
  ];
  assert.equal(pickBestPair(pairs, BONK).pairAddress, 'orca');
  assert.equal(pickBestPair(pairs, BONK, 'solana').pairAddress, 'orca');
});

// ------------------------------------------------------------------ lows

test('doctor: 401 FAIL, 429 WARN, real live mode WARNs that the balance is unchecked, keys printed by name only', async () => {
  assert.equal(probeResult(200).status, 'PASS');
  assert.equal(probeResult(429).status, 'WARN');
  assert.equal(probeResult(401).status, 'FAIL');
  assert.equal(probeResult(404).status, 'FAIL');
  const cfg = defaultConfig({ DRY_RUN: 'false', EVM_PRIVATE_KEY: `0x${'ab'.repeat(32)}` });
  const storage = new Storage(':memory:');
  const fakeFetch = async (url) => ({ status: String(url).includes('jup') ? 401 : 429, headers: new Map([['date', new Date().toUTCString()]]) });
  const rows = await runDoctor({ cfg, storage, mode: 'live', probes: liveProbes(cfg, fakeFetch) });
  const by = (n) => rows.find((r) => r.name === n);
  assert.equal(by('api Jupiter').status, 'FAIL');
  assert.equal(by('api GoPlus').status, 'WARN');
  assert.equal(by('hot wallet').status, 'WARN');
  assert.equal(by('keys').detail, 'present: EVM_PRIVATE_KEY');
  assert.ok(!JSON.stringify(rows).includes('abab'), 'no part of a key is printed');
  storage.close();
});

test('raising tp_rr or sl_mult (which loosens the cost gate) waits LOOSEN_DELAY_HOURS', () => {
  assert.equal(LOOSEN_DIRECTION.tp_rr.dir, 'up');
  assert.equal(LOOSEN_DIRECTION.sl_mult.dir, 'up');
  const { engine, storage } = setup();
  const tp = engine.cfg.analysis.tpRr;
  assert.ok(engine.changeSetting('tp_rr', String(tp * 3)).effectiveAt > 0);
  assert.equal(engine.cfg.analysis.tpRr, tp);
  assert.equal(engine.changeSetting('tp_rr', String(tp / 2)).effectiveAt, null, 'tightening is instant');
  storage.close();
});

test('the Solana report shows the RugCheck LP lock', async () => {
  const { formatAnalysis } = await import('../src/analyzer.js');
  const { engine, storage } = setup();
  const a = await engine.analyze(GOOD.address, GOOD.chain);
  a.security = { ...a.security, lpLockedPct: 97.4 };
  assert.match(formatAnalysis(a), /freezable no · LP locked 97%/);
  storage.close();
});
