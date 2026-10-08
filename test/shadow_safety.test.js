import '../src/warnings.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, TUNABLE } from '../src/config.js';
import { Storage } from '../src/storage.js';
import { Engine } from '../src/engine.js';
import { MockDataSource, MOCK_TOKENS } from '../src/data/mock.js';
import { strategyFactory } from '../src/strategy.js';
import { PaperExecutor } from '../src/executors/paper.js';
import { ExecutionError } from '../src/executors/base.js';
import { cardDue, entryFill, markNet, outcomeOf, ruleIdFor } from '../src/shadow.js';
import { autoPauseCheck, clearPanic, doctorExitCode, panicState, presetDiff, runDoctor, setPanic } from '../src/safety.js';

const [GOOD, BASE] = MOCK_TOKENS;

function setup(overrides = {}, executors = null) {
  const cfg = defaultConfig(overrides);
  const storage = new Storage(':memory:');
  const ds = new MockDataSource({ now: 1_800_000_000_000 });
  const messages = [];
  const engine = new Engine({
    cfg, storage, dataSource: ds, notifier: { adminIds: [], send: async (t) => void messages.push(t) },
    executors: executors ?? { paper: new PaperExecutor(cfg.trading) }, strategyFactory: strategyFactory(cfg.strategy, cfg.analysis),
  });
  return { cfg, storage, ds, engine, messages };
}

test('the mark math is net of fees', () => {
  const gross = 1000 * 0.06;
  const net = markNet({ qty: 1000, priceNow: 0.06, feeBps: 30, sellTaxPct: 5, sellImpactPct: 0.5, networkFeeUsd: 0.02 });
  assert.ok(Math.abs(net - (gross * 0.997 * 0.95 * 0.995 - 0.02)) < 1e-12);
  assert.ok(net < gross);
  assert.equal(markNet({ qty: 10, priceNow: 1, feeBps: 0 }), 10);
  const f = entryFill({ sizeUsd: 50, price: 1, feeBps: 30, buyTaxPct: 3 });
  assert.ok(Math.abs(f.qty - 50 * 0.997 * 0.97) < 1e-12);
  assert.ok(f.entryCosts > 1.6);
  assert.equal(outcomeOf({ netValue: 60, sizeUsd: 50, liqEntry: 100_000, liqNow: 10_000 }), 'rugged');
  assert.equal(outcomeOf({ netValue: 51, sizeUsd: 50, liqEntry: 100_000, liqNow: 90_000 }), 'gain');
  assert.equal(cardDue({ now: 25 * 3.6e6, trialStart: 0, matches: 5, minHours: 24, minMatches: 5, maxHours: 168 }), true);
  assert.equal(cardDue({ now: 25 * 3.6e6, trialStart: 0, matches: 2, minHours: 24, minMatches: 5, maxHours: 168 }), false);
  assert.equal(cardDue({ now: 169 * 3.6e6, trialStart: 0, matches: 2, minHours: 24, minMatches: 5, maxHours: 168 }), true);
});

test('a shadow rule never calls executor.buy, even with DRY_RUN=false; it becomes live only through promote', async () => {
  const spy = { calls: 0, async buy() { this.calls += 1; throw new Error('must not be called'); }, async sell() { this.calls += 1; } };
  const { storage, engine } = setup({ DRY_RUN: 'false' }, { paper: new PaperExecutor(defaultConfig().trading), solana: spy, evm: spy });
  engine.setMode('live', { confirm: true });
  await engine.watch(GOOD.address);
  assert.equal(storage.getWatch(GOOD.address).state, 'shadow');
  const [r] = await engine.tick();
  assert.equal(r.action, 'SHADOW');
  assert.equal(spy.calls, 0);
  assert.equal(storage.listShadowFills({ ruleId: ruleIdFor(GOOD.address) }).length, 1);
  assert.equal(storage.listOpenPositions('live').length, 0);
  const evs = engine.events.read({});
  assert.ok(evs.some((e) => e.mode === 'shadow' && e.reasons[0].code === 'SHADOW_RULE'));
  // Only promote() moves shadow -> live.
  assert.equal(storage.getWatch(GOOD.address).state, 'shadow');
  // [Go live] only asks; [Yes, go live] (within 120 s) promotes.
  const ask = engine.shadowAction(GOOD.address, 'live');
  assert.equal(storage.getWatch(GOOD.address).state, 'shadow');
  const ok = ask.buttons.flat().find((b) => b.text === 'Yes, go live').data.split(':');
  engine.shadowAction(ok[1], ok[2], ok[3]);
  assert.equal(storage.getWatch(GOOD.address).state, 'live');
  assert.ok(storage.getWatch(GOOD.address).promotedAt > 0);
  storage.close();
});

test('hindsight card after the trial: numbers net of fees, Go live note under DRY_RUN', async () => {
  const { storage, engine, messages } = setup({ SHADOW_MIN_HOURS: '0', SHADOW_MAX_HOURS: '0' });
  await engine.watch(GOOD.address);
  await engine.tick();
  const card = messages.find((m) => m.startsWith('PRACTICE HINDSIGHT MOCKGOOD'));
  assert.ok(card, messages.join('\n---\n'));
  assert.match(card, /would have bought 1 for \$50; worth \$49\.\d\d net now \(-0\.\d%\)/);
  assert.match(card, /real buying also needs DRY_RUN=false/);
  assert.match(card, /\[Go live\] \[Keep testing 24h\] \[Delete\]/);
  await engine.tick();
  assert.equal(messages.filter((m) => m.startsWith('PRACTICE HINDSIGHT')).length, 1, 'card sent once');
  storage.close();
});

test('the panic flag persists across reopening storage; panic blocks buys and forces practice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctb-panic-'));
  const db = path.join(dir, 'p.db');
  let st = new Storage(db);
  setPanic(st, { now: 5, prevMode: 'live' });
  st.close();
  st = new Storage(db);
  assert.deepEqual(panicState(st), { on: 1, at: 5, prevMode: 'live', reason: 'manual /panic' });
  clearPanic(st);
  assert.equal(panicState(st), null);
  st.close();
  fs.rmSync(dir, { recursive: true, force: true });

  const { storage, engine } = setup();
  engine.setMode('link');
  engine.pending.set('x', { at: Date.now() });
  await engine.panic();
  assert.equal(engine.mode, 'paper');
  assert.equal(engine.pending.size, 0);
  await assert.rejects(engine.buy(GOOD.address, 10), /panic stop is on/);
  assert.throws(() => engine.setMode('live'), /panic stop is on/);
  storage.close();
});

test('auto-pause fires after N stubbed executor errors', async () => {
  const failing = { async buy() { throw new ExecutionError('rpc down'); }, async sell() { throw new ExecutionError('rpc down'); } };
  const { storage, engine, messages } = setup({ AUTO_PAUSE_ERRORS: '3' }, { paper: failing });
  for (let i = 0; i < 2; i++) await assert.rejects(engine.buy(GOOD.address, 10), /rpc down/);
  assert.equal(engine.paused, false);
  await assert.rejects(engine.buy(GOOD.address, 10), /rpc down/);
  assert.equal(engine.paused, true);
  assert.ok(messages.some((m) => /AUTO-PAUSE: EXECUTOR_ERROR/.test(m)));
  assert.equal(autoPauseCheck({ consecutiveErrors: 0, maxErrors: 5, dataAgeSec: 400, staleSec: 300 }).code, 'STALE_DATA');
  assert.equal(autoPauseCheck({ consecutiveErrors: 0, maxErrors: 5, balanceNowUsd: 50, balance24hAgoUsd: 200, ownSpend24hUsd: 50, dropPct: 30 }).code, 'BALANCE_DROP');
  assert.equal(autoPauseCheck({ consecutiveErrors: 0, maxErrors: 5, balanceNowUsd: 150, balance24hAgoUsd: 200, ownSpend24hUsd: 50, dropPct: 30 }).pause, false);
  storage.close();
});

test('/preset produces the expected config diff and applies loosening with a delay', () => {
  const { storage, engine } = setup();
  assert.deepEqual(presetDiff(engine.cfg, 'careful', TUNABLE), [
    { key: 'max_trade_usd', from: 200, to: 25 }, { key: 'daily_budget', from: 500, to: 50 },
    { key: 'max_trades_h', from: 10, to: 2 }, { key: 'max_buy_risk', from: 40, to: 25 },
  ]);
  engine.applyPreset('careful');
  assert.equal(engine.cfg.trading.maxTradeUsd, 25);
  const bold = engine.applyPreset('bold');
  assert.ok(bold.every((r) => r.effectiveAt), 'loosening waits');
  assert.equal(engine.cfg.trading.maxTradeUsd, 25);
  assert.throws(() => presetDiff(engine.cfg, 'yolo', TUNABLE), /unknown preset/);
  storage.close();
});

test('doctor against mock clients: all PASS except DRY_RUN WARN; FAIL gives exit code 1', async () => {
  const { cfg, storage } = setup();
  const probes = [{ name: 'DexScreener (mock)', check: async () => ({ ok: true, dateHeader: new Date().toUTCString() }) }];
  const rows = await runDoctor({ cfg, storage, mode: 'paper', probes });
  assert.deepEqual(rows.filter((r) => r.status !== 'PASS').map((r) => [r.name, r.status]), [['DRY_RUN', 'WARN']]);
  assert.equal(doctorExitCode(rows), 0);
  const badCfg = defaultConfig({ MAX_TRADE_USD: '600', BOT_TOKEN: '1:x' });
  const bad = await runDoctor({ cfg: badCfg, storage, mode: 'paper', probes: [{ name: 'x', check: async () => { throw new Error('ENOTFOUND'); } }] });
  assert.equal(doctorExitCode(bad), 1);
  assert.ok(bad.find((r) => r.name === 'limits').status === 'FAIL');
  assert.ok(bad.find((r) => r.name === 'keys').status === 'FAIL');
  assert.ok(bad.every((r) => r.status !== 'FAIL' || r.hint), 'a fix hint per failing item');
  storage.close();
});

test('every evaluation is logged; muted tokens are still logged as skip MUTED', async () => {
  const { storage, engine } = setup();
  await engine.watch(BASE.address);
  engine.mute(BASE.address, 24);
  const [r] = await engine.tick();
  assert.equal(r.action, 'SKIP');
  assert.equal(r.code, 'MUTED');
  const skip = engine.events.read({}).find((e) => e.kind === 'skip');
  assert.equal(skip.reasons[0].code, 'MUTED');
  assert.match(engine.whyText(storage.decisionsFor(BASE.address, 1)[0].id), /Not bought: MUTED/);
  storage.close();
});
