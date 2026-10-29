// Regression tests for the v0.1.0 release check: buys while paused, live sell size, CONFIRM_ABOVE on manual buys,
// stale-data auto-resume, slippage_bps reaching the executors, the LIVE tag in link mode, the graduation phrase,
// alert buttons, digest hints, /why text, stale buttons, CLI validation, defaults and wording.
import '../src/warnings.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultConfig, LOOSEN_DIRECTION } from '../src/config.js';
import { Storage } from '../src/storage.js';
import { Engine } from '../src/engine.js';
import { MockDataSource, MOCK_TOKENS } from '../src/data/mock.js';
import { strategyFactory } from '../src/strategy.js';
import { PaperExecutor } from '../src/executors/paper.js';
import { JupiterExecutor } from '../src/executors/jupiter.js';
import { EvmExecutor } from '../src/executors/evm.js';
import { sellAmountRaw, toRawUnits } from '../src/executors/base.js';
import { renderAlert } from '../src/explain.js';
import { buildDigest } from '../src/digest.js';
import { createBot } from '../src/bot.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [GOOD, BASE] = MOCK_TOKENS;
const T0 = 1_800_000_000_000;
const KEY = { EVM_PRIVATE_KEY: `0x${'11'.repeat(32)}` };

/** Real-funds executor stand-in: records every call (with the slippage it was given); never touches a network. */
function spy(name, calls, reqs = []) {
  return {
    async buy(req) {
      reqs.push(req);
      calls.push(`${name} BUY ${req.token.symbol} $${req.usd}`);
      return { side: 'BUY', price: req.price, qty: req.usd / req.price, usd: req.usd, feeUsd: 0, venue: name, txId: 'tx', dry: false };
    },
    async sell(req) {
      reqs.push(req);
      calls.push(`${name} SELL ${req.token.symbol}`);
      return { side: 'SELL', price: req.price, qty: req.qty, usd: req.qty * req.price, feeUsd: 0, venue: name, txId: 'tx', dry: false };
    },
  };
}

function setup(overrides = {}) {
  const cfg = defaultConfig(overrides);
  const storage = new Storage(':memory:');
  const ds = new MockDataSource({ now: T0 });
  const messages = [];
  const alerts = [];
  const calls = [];
  const reqs = [];
  let t = T0;
  const engine = new Engine({
    cfg, storage, dataSource: ds, now: () => t,
    notifier: { adminIds: [], send: async (m, opts) => { messages.push(m); alerts.push({ text: m, buttons: opts?.buttons ?? [] }); } },
    executors: { paper: new PaperExecutor(cfg.trading), solana: spy('solana', calls, reqs), evm: spy('evm', calls, reqs) },
    strategyFactory: strategyFactory(cfg.strategy, cfg.analysis),
  });
  return { cfg, storage, ds, engine, messages, alerts, calls, reqs, advance: (ms) => { t += ms; } };
}

/** Go live the way the bot does: 10 closed practice trades, a loss budget, the phrase, then Confirm LIVE. */
function goLive(s) {
  for (let i = 0; i < 10; i++) {
    s.storage.db.prepare(`INSERT INTO positions (address, chain, symbol, mode, status, qty, entry_price, cost_usd, opened_at, closed_at, realized_pnl_usd, close_reason, dry) VALUES (?, 'base', 'X', 'paper', 'closed', 1, 1, 1, 0, 0, 1, 'TAKE_PROFIT', 0)`).run(`x${i}`);
  }
  s.engine.changeSetting('loss_budget', '50');
  assert.equal(s.engine.requestLiveMode({ phrase: 'I can lose this money' }).needConfirm, true);
  s.engine.requestLiveMode({ phrase: 'I can lose this money', confirmed: true });
  assert.equal(s.engine.mode, 'live');
  assert.equal(s.engine.tag(), 'LIVE');
}

const buttonsOf = (alert) => alert.buttons.flat().map((b) => b.text);

// ------------------------------------------------------------------ high: no spend while paused

test('paused: a /buy confirmation tapped after /pause spends nothing (real funds)', async () => {
  const s = setup({ ...KEY, DRY_RUN: 'false', SHADOW_NEW_RULES: 'false' });
  goLive(s);
  const a = await s.engine.analyze(GOOD.address, GOOD.chain, { allowQuote: true });
  const id = s.engine.createPendingBuy({ a, usd: 20 });
  s.engine.setPaused(true, 'manual /pause');
  await assert.rejects(s.engine.resolvePending(id, 'ok'), (e) => e.code === 'PAUSED' && /paused/.test(e.message));
  await assert.rejects(s.engine.buy(GOOD.address, 20, { reason: 'manual /buy' }), (e) => e.code === 'PAUSED');
  assert.deepEqual(s.calls, [], 'no real executor call while paused');
  assert.equal(s.storage.listOpenPositions('live').length, 0);
  // After /resume the same kind of buy goes through.
  s.engine.setPaused(false, 'manual /resume');
  const r = await s.engine.buy(GOOD.address, 20, { reason: 'manual /buy' });
  assert.equal(r.fill.dry, false);
  assert.deepEqual(s.calls, ['solana BUY MOCKGOOD $20']);
});

test('paused: an autopilot CONFIRM card made before an EXECUTOR_ERROR auto-pause cannot buy', async () => {
  const s = setup({ ...KEY, DRY_RUN: 'false', SHADOW_NEW_RULES: 'false' });
  goLive(s);
  const b = await s.engine.analyze(BASE.address, BASE.chain, { allowQuote: true });
  const pid = s.engine.createPendingBuy({ a: b, usd: 150, reason: 'signal: autopilot above CONFIRM_ABOVE' });
  await s.engine.autoPause({ code: 'EXECUTOR_ERROR', reason: '5 swaps failed in a row' });
  assert.equal(s.engine.paused, true);
  await assert.rejects(s.engine.resolvePending(pid, 'ok'), (e) => e.code === 'PAUSED');
  assert.deepEqual(s.calls, []);
});

test('bot: /buy while paused is refused before any card is shown', async () => {
  const cfg = defaultConfig({ SAMPLE_TOKENS: `solana:${GOOD.address}` });
  const storage = new Storage(':memory:');
  const engine = new Engine({
    cfg, storage, dataSource: new MockDataSource({ now: T0 }), notifier: { adminIds: [42], send: async () => {} },
    executors: { paper: new PaperExecutor(cfg.trading) }, strategyFactory: strategyFactory(cfg.strategy, cfg.analysis), now: () => T0,
  });
  const { say } = botHarness(engine);
  await say('/pause');
  assert.match(await say(`/buy ${GOOD.address} 20`), /Refused: trading is paused/);
  assert.equal(engine.pending.size, 0);
  storage.close();
});

// ------------------------------------------------------------------ medium: live sell size

test('live Jupiter sell: sells the position, not the whole wallet balance of that token', async () => {
  const ex = new JupiterExecutor(defaultConfig({ DRY_RUN: 'false' }), { dry: false });
  let swapped = null;
  let walletRaw = 1000n * 10n ** 6n; // 1000 tokens, 900 of them bought outside the bot
  ex.balanceRaw = async () => walletRaw;
  ex.decimals = async () => 6;
  ex.quote = async ({ amount }) => { swapped = amount; return { outAmount: String(amount) }; };
  ex.swap = async () => 'sig';
  const token = { address: 'Mint', chain: 'solana', symbol: 'TKN' };
  const f = await ex.sell({ token, qty: 100, pct: 100, price: 1 });
  assert.equal(swapped, 100n * 10n ** 6n, 'only the 100-token position is sold');
  assert.equal(f.qty, 100);
  assert.equal(f.usd, 100);
  await ex.sell({ token, qty: 50, pct: 50, price: 1 });
  assert.equal(swapped, 50n * 10n ** 6n);
  // The wallet holds less than the position (a transfer tax, say): everything left is sold and the position closes.
  walletRaw = 98n * 10n ** 6n;
  const f3 = await ex.sell({ token, qty: 100, pct: 100, price: 1 });
  assert.equal(swapped, walletRaw);
  assert.equal(f3.qty, 100);
});

test('live EVM sell: sells the position, not the whole wallet balance of that token', async () => {
  const ex = new EvmExecutor(defaultConfig({ DRY_RUN: 'false' }), { dry: false });
  let sold = null;
  const fakeEthers = {
    Contract: class { async decimals() { return 18n; } async balanceOf() { return 1000n * 10n ** 18n; } },
    formatUnits: (v, d) => String(Number(v) / 10 ** Number(d)),
  };
  ex.context = async () => ({ ethers: fakeEthers, wallet: { address: '0xme' }, info: { usdc: { address: '0xusdc', decimals: 6 }, chainId: 8453 } });
  ex.execute = async (_ctx, { sellAmount }) => { sold = sellAmount; return { hash: '0xh', quote: { buyAmount: String(Number(sellAmount / 10n ** 12n)) } }; };
  const f = await ex.sell({ token: { address: '0xtok', chain: 'base', symbol: 'TKN' }, qty: 100, pct: 100, price: 1 });
  assert.equal(sold, 100n * 10n ** 18n);
  assert.equal(f.qty, 100);
});

test('sellAmountRaw / toRawUnits: cap at the balance, exact decimals', () => {
  assert.equal(toRawUnits(1.5, 6), 1_500_000n);
  assert.equal(toRawUnits(0, 6), 0n);
  assert.equal(toRawUnits(27688.0123456789, 9), 27_688_012_345_679n);
  assert.deepEqual(sellAmountRaw({ balanceRaw: 10n ** 9n, qty: 0.5, decimals: 9 }), { amount: 5n * 10n ** 8n, all: false });
  assert.deepEqual(sellAmountRaw({ balanceRaw: 3n, qty: 0.5, decimals: 9 }), { amount: 3n, all: true });
});

// ------------------------------------------------------------------ medium: CONFIRM_ABOVE on manual buys

test('CONFIRM_ABOVE: a manual /buy above it asks first even with BUY_CONFIRM=false', async () => {
  const s = setup({ ...KEY, DRY_RUN: 'false', BUY_CONFIRM: 'false', CONFIRM_ABOVE: '100', SHADOW_NEW_RULES: 'false' });
  goLive(s);
  const r = await s.engine.buy(GOOD.address, 180, { reason: 'manual /buy', chain: null, override: null });
  assert.equal(r.pending, true);
  assert.deepEqual(s.calls, [], 'nothing spent before the tap');
  assert.match(r.message, /CONFIRM BUY MOCKGOOD \(solana\) \$180/);
  const done = await s.engine.resolvePending(r.pendingId, 'ok');
  assert.equal(done.fill.usd, 180);
  assert.deepEqual(s.calls, ['solana BUY MOCKGOOD $180'], 'executed exactly once after Confirm');
  // At or below the threshold a manual buy runs at once; practice buys never ask.
  const small = await s.engine.buy(BASE.address, 100, { reason: 'manual /buy' });
  assert.ok(small.fill);
  const p = setup({ BUY_CONFIRM: 'false', CONFIRM_ABOVE: '10' });
  assert.ok((await p.engine.buy(GOOD.address, 50, { reason: 'manual /buy' })).fill, 'practice: no confirmation');
});

// ------------------------------------------------------------------ medium: STALE_DATA auto-resume

test('STALE_DATA: the auto-pause ends by itself when fresh data arrives; a manual pause does not', async () => {
  const s = setup({ SHADOW_NEW_RULES: 'false' });
  await s.engine.watch(GOOD.address, GOOD.chain);
  const orig = s.ds.getMarket.bind(s.ds);
  s.ds.getMarket = async () => null; // DexScreener outage
  s.advance(301_000);
  await s.engine.tick();
  assert.equal(s.engine.paused, true);
  assert.equal(s.engine.pauseInfo.code, 'STALE_DATA');
  const card = s.alerts.find((x) => x.text.includes('AUTO-PAUSE: STALE_DATA'));
  assert.match(card.text, /resumes on its own/);
  assert.deepEqual(buttonsOf(card), ['Resume', 'Why?']);
  s.ds.getMarket = orig; // data is back
  s.advance(60_000);
  await s.engine.tick();
  assert.equal(s.engine.paused, false, 'auto-resumed');
  assert.ok(s.messages.some((m) => m.startsWith('AUTO-RESUME: market data is fresh again')));

  // A manual /pause during an outage is the user's: fresh data does not undo it.
  s.ds.getMarket = async () => null;
  s.advance(301_000);
  await s.engine.tick();
  assert.equal(s.engine.pauseInfo.code, 'STALE_DATA');
  s.engine.setPaused(true, 'manual /pause');
  s.ds.getMarket = orig;
  s.advance(60_000);
  await s.engine.tick();
  assert.equal(s.engine.paused, true);
});

// ------------------------------------------------------------------ medium: slippage_bps reaches the executors

test('slippage_bps: the tuned value reaches live executors and practice fills; loosening it is delayed', async () => {
  const s = setup({ ...KEY, DRY_RUN: 'false', SHADOW_NEW_RULES: 'false', SLIPPAGE_BPS: '100' });
  goLive(s);
  assert.deepEqual(LOOSEN_DIRECTION.slippage_bps, { dir: 'up' });
  const loose = s.engine.changeSetting('slippage_bps', '5000');
  assert.ok(loose.effectiveAt > 0, 'more slippage tolerance waits LOOSEN_DELAY_HOURS');
  assert.equal(s.engine.cfg.trading.slippageBps, 100);
  assert.equal(s.engine.changeSetting('slippage_bps', '30').effectiveAt, null, 'tightening is instant');
  await s.engine.buy(GOOD.address, 20, { reason: 'manual /buy' });
  await s.engine.sell(GOOD.address, 100, 'manual /sell');
  assert.deepEqual(s.reqs.map((r) => r.slippageBps), [30, 30]);
  // Paper fills without pool data use the request's slippage too.
  const paper = new PaperExecutor({ slippageBps: 100, feeBps: 0 });
  const tight = await paper.buy({ usd: 100, price: 1, slippageBps: 0 });
  const wide = await paper.buy({ usd: 100, price: 1 });
  assert.ok(tight.price < wide.price);
  // Jupiter quotes carry it.
  const ex = new JupiterExecutor(defaultConfig({ DRY_RUN: 'false' }), { dry: false });
  let q = null;
  ex.decimals = async () => 6;
  ex.balanceRaw = async () => 10n ** 8n;
  ex.quote = async (args) => { q = args; return { outAmount: '1' }; };
  ex.swap = async () => 'sig';
  await ex.sell({ token: { address: 'M', chain: 'solana', symbol: 'T' }, qty: 1, pct: 100, price: 1, slippageBps: 42 });
  assert.equal(q.slippageBps, 42);
});

// ------------------------------------------------------------------ medium: LIVE tag in link mode

test('tag: link mode is LIVE (you sign real swaps), even with DRY_RUN=true', async () => {
  const s = setup({ SHADOW_NEW_RULES: 'false' });
  assert.equal(s.engine.tag(), 'PRACTICE');
  s.engine.setMode('link');
  assert.equal(s.engine.tag(), 'LIVE');
  assert.equal(s.engine.eventMode(), 'live');
  const r = await s.engine.buy(GOOD.address, 20, { reason: 'manual /buy' });
  assert.ok(r.link);
  assert.match(r.message, /^LIVE LINK BUY MOCKGOOD: open https:\/\/phantom\.com/);
  assert.match(s.engine.safetyText(), /^Mode: LIVE - link \(you sign in your wallet\)/);
  s.engine.setMode('live');
  assert.equal(s.engine.tag(), 'PRACTICE', 'live route under DRY_RUN=true is simulated');
});

// ------------------------------------------------------------------ medium: graduation phrase

test('graduation: the checklist says how to type the phrase; a bare phrase message gets the hint', async () => {
  const s = setup({ DRY_RUN: 'false' });
  assert.match(s.engine.graduation().text, /\[ \] phrase typed with the command: \/mode live I can lose this money/);
  assert.throws(() => s.engine.requestLiveMode({}), /send the phrase with the command in one message: \/mode live I can lose this money/);
  const { say } = botHarness(s.engine);
  assert.match(await say('I can lose this money'), /send the phrase together with the command, in one message: \/mode live I can lose this money/);
  assert.match(await say('/mode live'), /\/mode live I can lose this money/);
});

// ------------------------------------------------------------------ medium: alert buttons

test('alerts: SHADOW BUY has a decision id, Why? and Mute; CONFIRM and AUTO-PAUSE cards have Why?', async () => {
  const s = setup({ SHADOW_NEW_RULES: 'true' });
  s.engine.setMode('live');
  await s.engine.watch(GOOD.address, GOOD.chain);
  await s.engine.tick();
  const sh = s.alerts.find((x) => x.text.startsWith('PRACTICE SHADOW BUY MOCKGOOD'));
  assert.ok(sh, s.messages.join('\n---\n'));
  const id = /decision #(\d+)/.exec(sh.text)?.[1];
  assert.ok(id, 'decision # line');
  assert.deepEqual(sh.buttons.flat().map((b) => b.data), [`why:${id}`, `mute:${GOOD.address}`]);
  assert.match(s.engine.whyText(id), /SHADOW_RULE/);
  const a = await s.engine.analyze(GOOD.address, GOOD.chain);
  const pid = s.engine.createPendingBuy({ a, usd: 20 });
  const card = s.engine.confirmCard(pid);
  const why = card.buttons.flat().find((b) => b.text === 'Why?');
  assert.ok(why);
  assert.match(s.engine.whyText(why.data.slice(4)), /CONFIRM|MANUAL/);
  await s.engine.autoPause({ code: 'EXECUTOR_ERROR', reason: '5 swaps failed in a row' });
  assert.ok(buttonsOf(s.alerts.at(-1)).includes('Why?'));
});

test('RED verdict alert: one "Don\'t buy (mute 24h)" button, no duplicate Mute 24h', async () => {
  const s = setup();
  for (const t of MOCK_TOKENS) await s.engine.watch(t.address, t.chain);
  await s.engine.tick();
  const red = s.alerts.find((x) => /\[AVOID\] MOCKPOT/.test(x.text));
  assert.deepEqual(buttonsOf(red), ["Don't buy (mute 24h)", 'Why?']);
});

// ------------------------------------------------------------------ low: digest hint, /why text

test('digest: no "Change to" button when no skipped deal would be up net of fees', () => {
  const ev = (code) => ({ v: 1, ts: T0, bot: 'b', kind: 'skip', mode: 'dry', id: `x${Math.random()}`, subject: { type: 'token', ref: 'a' }, reasons: [{ code, sev: 'bad', p: { usd: 250, max: 200 } }] });
  const base = { events: [ev('PRICE_ABOVE_MAX')], since: 0, budgetUsd: 500, realizedUsd: 0, unrealizedUsd: 0, settings: { max_trade_usd: 200 } };
  const down = buildDigest({ ...base, shadowBySkip: new Map([['PRICE_ABOVE_MAX', { n: 1, positive: 0, netUsd: -1.66 }]]) });
  assert.match(down.text, /1 deal was skipped by max_trade_usd=200; it would be down \$1\.66 net today\. No change suggested\./);
  assert.deepEqual(down.buttons, []);
  const up = buildDigest({ ...base, shadowBySkip: new Map([['PRICE_ABOVE_MAX', { n: 3, positive: 2, netUsd: 4.5 }]]) });
  assert.match(up.text, /3 deals were skipped by max_trade_usd=200; 2 of them would be up net today \(\+\$4\.50 in total\)/);
  assert.deepEqual(up.buttons[0].map((b) => b.text), ['Change to 300', 'Keep']);
});

test('/why for a loss-budget skip shows the amount lost', async () => {
  const s = setup({ SHADOW_NEW_RULES: 'false' });
  s.engine.changeSetting('loss_budget', '20');
  s.storage.db.prepare(`INSERT INTO trades (ts, mode, dry, address, chain, symbol, side, qty, price, usd, pnl_usd) VALUES (?, 'paper', 0, 'x', 'base', 'X', 'SELL', 1, 20, 20, -30)`).run(T0 - 7_200_000);
  await assert.rejects(s.engine.buy(GOOD.address, 20, { reason: 'manual' }), (e) => e.code === 'LOSS_BUDGET');
  const d = s.storage.decisionsFor(GOOD.address, 5).find((x) => x.kind === 'skip');
  assert.match(s.engine.whyText(d.id).split('\n')[0], /Monthly loss budget used up: lost \$30 of a \$20 budget\./);
});

// ------------------------------------------------------------------ low: stale buttons

test('stale buttons: an old Resume or Confirm resume cannot end a newer pause or panic; Go live needs a fresh confirm', async () => {
  const s = setup({ SHADOW_NEW_RULES: 'true' });
  await s.engine.autoPause({ code: 'EXECUTOR_ERROR', reason: 'x' });
  const oldId = s.engine.pauseInfo.id;
  s.engine.setPaused(false, 'manual /resume');
  await s.engine.autoPause({ code: 'BALANCE_DROP', reason: 'wallet drop', p: { pct: 40 } });
  assert.throws(() => s.engine.resumeFromButton(oldId), /earlier pause/);
  assert.throws(() => s.engine.resumeFromButton(null), /earlier pause/);
  assert.equal(s.engine.paused, true);
  assert.equal(s.engine.resumeFromButton(s.engine.pauseInfo.id), 'Resumed.');
  assert.equal(s.storage.getKv('balance_drop', null), null, 'the current BALANCE_DROP pause ends only with its own button');

  // Panic: the confirm button is tied to its panic and to the prompt time.
  await s.engine.panic('first');
  const first = s.engine.panicId();
  s.engine.resumeFromPanic();
  s.advance(5_000);
  await s.engine.panic('second');
  assert.throws(() => s.engine.resumeFromPanic({ panicId: first, promptAt: T0 + 5_000 }), /earlier panic/);
  assert.throws(() => s.engine.resumeFromPanic({ panicId: s.engine.panicId(), promptAt: T0 - 200_000 }), /expired/);
  assert.throws(() => s.engine.resumeFromButton(s.engine.pauseInfo.id), /panic stop is on/);
  assert.equal(s.engine.panicOn, true);
  assert.match(s.engine.resumeFromPanic({ panicId: s.engine.panicId(), promptAt: T0 + 5_000 }), /Panic cleared/);

  // Hindsight Go live: a confirmation first, valid 120 s.
  await s.engine.watch(GOOD.address, GOOD.chain);
  const ask = s.engine.shadowAction(GOOD.address, 'live');
  assert.equal(typeof ask, 'object');
  assert.match(ask.text, /expires in 120 s/);
  assert.equal(s.storage.getWatch(GOOD.address).state, 'shadow');
  const [, addr, act, at] = ask.buttons[0][0].data.split(':');
  s.advance(121_000);
  assert.throws(() => s.engine.shadowAction(addr, act, at), /expired/);
  assert.equal(s.storage.getWatch(GOOD.address).state, 'shadow');
  const again = s.engine.shadowAction(GOOD.address, 'live').buttons[0][0].data.split(':');
  assert.match(s.engine.shadowAction(again[1], again[2], again[3]), /Rule promoted to live/);
  assert.equal(s.storage.getWatch(GOOD.address).state, 'live');
  assert.match(s.engine.shadowAction(GOOD.address, 'live'), /already live/);
});

// ------------------------------------------------------------------ low: CLI, defaults, wording, versions

test('CLI: mock --cycles abc is a usage error, not a silent zero-cycle run', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'src', 'index.js'), 'mock', '--cycles', 'abc'], { cwd: ROOT, env: { ...process.env, ALLOW_UNSUPPORTED_OS: '1' }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--cycles must be a whole number of 1 or more \(got "abc"\)/);
  assert.doesNotMatch(r.stdout, /Mock run finished OK/);
});

test('defaults: DIGEST_TZ is UTC; /safety and /preset say which preset the limits match', () => {
  const s = setup();
  assert.equal(s.cfg.events.digestTz, 'UTC');
  assert.match(s.engine.safetyText(), /Preset: your limits match bold \(except max_buy_risk\) · change with \/preset careful\|normal\|bold/);
  assert.match(s.engine.presetPreview('normal').text, /^Your limits now match the bold preset \(except max_buy_risk\)\./);
  s.engine.applyPreset('careful');
  assert.match(s.engine.safetyText(), /Preset: your limits match careful /);
});

test('wording: sell and buy alerts say "practice", no "Reason:" echo, Why items end with punctuation', async () => {
  const s = setup();
  await s.engine.buy(GOOD.address, 20, { reason: 'manual /buy' });
  const buy = s.messages.find((m) => /^PRACTICE BUY MOCKGOOD/.test(m));
  assert.match(buy, /Why: Manual \/buy\./);
  assert.match(buy, /venue practice \(simulated\)/);
  await s.engine.sell(GOOD.address, 100, 'TAKE_PROFIT');
  const sell = s.messages.find((m) => /^PRACTICE SELL 100% MOCKGOOD/.test(m));
  assert.match(sell, /Why: Target reached\./);
  assert.doesNotMatch(sell, /Reason:|venue paper/);
  assert.match(await s.engine.positionsText(), /^No open practice positions\./);
  const r = renderAlert({ tag: 'LIVE', title: 't', why: ['RSI 61 within 45-70', 'You sign in your own wallet; the bot never sees a key.'] });
  assert.match(r.text, /Why: RSI 61 within 45-70\. You sign in your own wallet/);
});

test('versions: the @solana/web3.js install hint matches package.json; the lockfile root matches package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const hint = /@solana\/web3\.js@(\S+?)`/.exec(fs.readFileSync(path.join(ROOT, 'src', 'executors', 'jupiter.js'), 'utf8'))?.[1];
  assert.equal(hint, pkg.optionalDependencies['@solana/web3.js']);
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')).packages[''];
  assert.deepEqual(lock.dependencies ?? {}, pkg.dependencies ?? {});
  assert.deepEqual(lock.optionalDependencies ?? {}, pkg.optionalDependencies ?? {});
});

// ------------------------------------------------------------------ helpers

/** A grammY bot wired to `engine` with every Bot API call intercepted. */
function botHarness(engine) {
  const ADMIN = 42;
  const botInfo = { id: 1, is_bot: true, first_name: 'T', username: 't_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
  const bot = createBot({ token: '1:test', adminIds: [ADMIN], engine, botInfo });
  const sent = [];
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, text: payload.text });
    return { ok: true, result: method === 'sendMessage' ? { message_id: sent.length, date: 0, chat: { id: payload.chat_id, type: 'private' }, text: payload.text } : true };
  });
  let n = 0;
  const say = async (text) => {
    sent.length = 0;
    n += 1;
    const entities = text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : [];
    await bot.handleUpdate({ update_id: n, message: { message_id: n, date: 0, chat: { id: ADMIN, type: 'private' }, from: { id: ADMIN, is_bot: false, first_name: 'U' }, text, entities } });
    return sent.filter((x) => x.method === 'sendMessage').map((x) => x.text).join('\n');
  };
  return { bot, say };
}

