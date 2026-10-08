// Balance-drop auto-pause: an unexpected hot-wallet balance drop beyond AUTO_PAUSE_BALANCE_DROP_PCT pauses live
// trading and alerts. Pure math, engine wiring (live only, own trades explained, resume = new baseline), the wallet
// reader and doctor.
import '../src/warnings.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config.js';
import { Storage } from '../src/storage.js';
import { Engine } from '../src/engine.js';
import { MockDataSource, MOCK_TOKENS } from '../src/data/mock.js';
import { strategyFactory } from '../src/strategy.js';
import { PaperExecutor } from '../src/executors/paper.js';
import { autoPauseCheck, runDoctor, worstBalanceDrop } from '../src/safety.js';
import { hotWallet } from '../src/wallet.js';

const [GOOD] = MOCK_TOKENS;
const T0 = 1_800_000_000_000;
const MIN = 60_000;
const H = 3_600_000;

function spyExecutor(name, calls) {
  return {
    async buy({ token, usd, price }) {
      calls.push(`${name} BUY ${token.symbol} $${usd}`);
      return { side: 'BUY', price, qty: usd / price, usd, feeUsd: 0, venue: name, txId: 'tx', dry: false };
    },
    async sell({ token, qty, price }) {
      calls.push(`${name} SELL ${token.symbol}`);
      return { side: 'SELL', price, qty, usd: qty * price, feeUsd: 0, venue: name, txId: 'tx', dry: false };
    },
  };
}

/** A wallet whose next reading is set by the test; counts reads. */
function fakeWallet() {
  const w = { label: 'test USDC', reads: 0, next: null, fail: null };
  w.balanceUsd = async () => {
    w.reads += 1;
    if (w.fail) throw w.fail;
    return w.next;
  };
  return w;
}

function setup(overrides = {}, { live = true } = {}) {
  const cfg = defaultConfig({ DRY_RUN: 'false', ...overrides });
  const storage = new Storage(':memory:');
  const clock = { t: T0 };
  const messages = [];
  const calls = [];
  const wallet = fakeWallet();
  const engine = new Engine({
    cfg, storage, dataSource: new MockDataSource({ now: T0 }), notifier: { adminIds: [], send: async (t) => void messages.push(t) },
    executors: { paper: new PaperExecutor(cfg.trading), solana: spyExecutor('solana', calls), evm: spyExecutor('evm', calls) },
    strategyFactory: strategyFactory(cfg.strategy, cfg.analysis), now: () => clock.t, wallet,
  });
  if (live && !cfg.dryRun) engine.setMode('live', { confirm: true });
  return { cfg, storage, engine, messages, calls, wallet, clock };
}

/** Advance the clock past the 5-min read interval, set the wallet reading and run one tick. */
async function tickWith(s, usd, stepMs = 6 * MIN) {
  s.clock.t += stepMs;
  s.wallet.next = usd;
  return s.engine.tick();
}

// ------------------------------------------------------------------ pure

test('worstBalanceDrop: own buys explain a drop, sells bring money back, a deposit then a drain is caught', () => {
  const now = T0 + 10 * H;
  // $500 -> $440 with a $50 bot buy in between: only $10 (2%) unexplained.
  let d = worstBalanceDrop({ samples: [{ ts: T0, usd: 500 }], nowUsd: 440, flows: [{ ts: T0 + H, side: 'BUY', usd: 50 }], now });
  assert.equal(d.refUsd, 500);
  assert.equal(d.ownSpendUsd, 50);
  assert.equal(Math.round(d.unexplainedUsd), 10);
  // A $60 sell after the reading means the wallet should have gone up: $500 now is $60 missing.
  d = worstBalanceDrop({ samples: [{ ts: T0, usd: 500 }], nowUsd: 500, flows: [{ ts: T0 + H, side: 'SELL', usd: 60 }], now });
  assert.equal(Math.round(d.unexplainedUsd), 60);
  // Deposit to $1,000 then drained to $520: against the first reading it looks fine, against the deposit it is -48%.
  d = worstBalanceDrop({ samples: [{ ts: T0, usd: 500 }, { ts: T0 + 2 * H, usd: 1000 }], nowUsd: 520, now });
  assert.equal(d.refUsd, 1000);
  assert.equal(Math.round(d.pct), 48);
  // A trade before the reference reading does not explain anything after it.
  d = worstBalanceDrop({ samples: [{ ts: T0 + 2 * H, usd: 500 }], nowUsd: 300, flows: [{ ts: T0 + H, side: 'BUY', usd: 200 }], now });
  assert.equal(Math.round(d.pct), 40);
  // Readings older than 24 h, zero readings or none at all give no reference.
  assert.equal(worstBalanceDrop({ samples: [{ ts: now - 25 * H, usd: 900 }, { ts: T0, usd: 0 }], nowUsd: 100, now }), null);
  assert.equal(worstBalanceDrop({ samples: [], nowUsd: 100, now }), null);
});

test('autoPauseCheck BALANCE_DROP: amounts in the reason, threshold is strict, 0 turns it off', () => {
  const base = { consecutiveErrors: 0, maxErrors: 5, balance24hAgoUsd: 500, ownSpend24hUsd: 50, balanceRefAt: T0, staleSec: 300 };
  const ap = autoPauseCheck({ ...base, balanceNowUsd: 250, dropPct: 30 });
  assert.equal(ap.code, 'BALANCE_DROP');
  assert.equal(ap.p.pct, 40);
  assert.match(ap.reason, /Hot-wallet balance is \$250, down from \$500 at \d\d:\d\d UTC\. The bot's own trades explain \$50 of that, so \$200 \(40%\) left the wallet/);
  assert.equal(autoPauseCheck({ ...base, balanceNowUsd: 300, dropPct: 30 }).pause, false, 'exactly 30% does not pause');
  assert.equal(autoPauseCheck({ ...base, balanceNowUsd: 0, dropPct: 0 }).pause, false, 'AUTO_PAUSE_BALANCE_DROP_PCT=0 is off');
  assert.equal(autoPauseCheck({ ...base, balanceNowUsd: null, dropPct: 30 }).pause, false, 'no reading never pauses');
});

// ------------------------------------------------------------------ engine

test('live: an unexplained wallet drop pauses, alerts once, refuses real buys; exits and Resume still work', async () => {
  const s = setup();
  const { engine, storage, messages, calls } = s;
  await tickWith(s, 500);
  assert.equal(s.wallet.reads, 1);
  // A real $50 buy, then the wallet shows $340: $110 of $500 (22%) unexplained, under the 30% threshold.
  await engine.buy(GOOD.address, 50, { reason: 'manual /buy' });
  await tickWith(s, 340);
  assert.equal(engine.paused, false);
  // $300: exactly 30% of $500 unexplained is not above 30% ...
  await tickWith(s, 300);
  assert.equal(engine.paused, false);
  // ... $1 more is.
  await tickWith(s, 299);
  assert.equal(engine.paused, true);
  const alerts = messages.filter((m) => /AUTO-PAUSE: BALANCE_DROP/.test(m));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /^LIVE AUTO-PAUSE: BALANCE_DROP/);
  assert.match(alerts[0], /The bot's own trades explain \$50 of that, so \$151 \(30%\) left the wallet some other way/);
  assert.match(engine.safetyText(), /Balance watch: .* TRIGGERED: 30% unexplained/);
  // Still low on the next reading: no second alert.
  await tickWith(s, 290);
  assert.equal(messages.filter((m) => /AUTO-PAUSE: BALANCE_DROP/.test(m)).length, 1);
  // Real-funds buys are refused, even a confirmed manual one; the open position can still be sold.
  await assert.rejects(engine.buy(GOOD.address, 20, { reason: 'manual /buy', confirmed: true }), (e) => e.code === 'BALANCE_DROP');
  assert.deepEqual(calls.filter((c) => / BUY /.test(c)), ['solana BUY MOCKGOOD $50']);
  await engine.sell(GOOD.address, 100, 'manual /sell');
  assert.ok(calls.includes('solana SELL MOCKGOOD'));
  // Resume (the alert button or /resume): the wallet was checked, the current balance is the new baseline.
  engine.setPaused(false, 'resume button');
  assert.equal(storage.getKv('balance_drop'), null);
  const sold = storage.realFlowsSince(0).find((f) => f.side === 'SELL').usd;
  await tickWith(s, 290 + sold);
  await tickWith(s, 290 + sold);
  assert.equal(engine.paused, false);
  await engine.buy(GOOD.address, 20, { reason: 'manual /buy' });
  assert.ok(calls.includes('solana BUY MOCKGOOD $20'));
  storage.close();
});

test('the wallet is read at most every 5 min, only in live mode with DRY_RUN=false; failed reads never pause', async () => {
  const s = setup();
  await tickWith(s, 500);
  await tickWith(s, 100, MIN); // 1 min later: not read
  assert.equal(s.wallet.reads, 1);
  assert.equal(s.engine.paused, false);
  // A failed read and an unknown balance are neither a sample nor a drop.
  s.wallet.fail = new Error('RPC timeout');
  await tickWith(s, 0);
  s.wallet.fail = null;
  await tickWith(s, null);
  assert.equal(s.engine.paused, false);
  assert.deepEqual(s.storage.getKv('wallet_balance').map((x) => x.usd), [500]);
  s.storage.close();

  for (const [overrides, live, why] of [[{}, false, 'practice mode'], [{ DRY_RUN: 'true' }, true, 'DRY_RUN=true']]) {
    const p = setup(overrides, { live });
    if (overrides.DRY_RUN === 'true') p.engine.setMode('live');
    await tickWith(p, 500);
    await tickWith(p, 1);
    assert.equal(p.wallet.reads, 0, why);
    assert.equal(p.engine.paused, false, why);
    p.storage.close();
  }

  const off = setup({ AUTO_PAUSE_BALANCE_DROP_PCT: '0' });
  await tickWith(off, 500);
  await tickWith(off, 1);
  assert.equal(off.wallet.reads, 0, 'AUTO_PAUSE_BALANCE_DROP_PCT=0 turns the watch off');
  assert.match(off.engine.safetyText(), /Balance watch: off/);
  off.storage.close();
});

test('an already paused bot still gets the balance-drop alert, and a sent-but-unconfirmed buy counts as own spend', async () => {
  const s = setup();
  s.engine.setPaused(true, 'manual /pause');
  await tickWith(s, 500);
  s.engine.reserveBuy({ mode: 'live', address: GOOD.address, chain: GOOD.chain, symbol: 'MOCKGOOD', usd: 100 });
  await tickWith(s, 400);
  assert.equal(s.messages.filter((m) => /BALANCE_DROP/.test(m)).length, 0, 'the reserved $100 explains the drop');
  await tickWith(s, 200);
  assert.equal(s.messages.filter((m) => /AUTO-PAUSE: BALANCE_DROP/.test(m)).length, 1);
  s.storage.close();
});

// ------------------------------------------------------------------ wallet reader + doctor

test('hotWallet: none under DRY_RUN=true or without a key; sums Solana and EVM; any failed part fails the read', async () => {
  const ex = { solana: { walletBalanceUsd: async () => 120.5 }, evm: { walletBalanceUsd: async () => 79.5 } };
  assert.equal(hotWallet(defaultConfig({ SOLANA_PRIVATE_KEY: 'x' }), ex), null, 'DRY_RUN=true');
  assert.equal(hotWallet(defaultConfig({ DRY_RUN: 'false' }), ex), null, 'no key');
  const both = hotWallet(defaultConfig({ DRY_RUN: 'false', SOLANA_PRIVATE_KEY: 'x', EVM_PRIVATE_KEY: `0x${'ab'.repeat(32)}` }), ex);
  assert.equal(both.label, 'Solana + EVM USDC');
  assert.equal(await both.balanceUsd(), 200);
  const sol = hotWallet(defaultConfig({ DRY_RUN: 'false', SOLANA_PRIVATE_KEY: 'x' }), { solana: { walletBalanceUsd: async () => null } });
  assert.equal(await sol.balanceUsd(), null);
  const broken = hotWallet(defaultConfig({ DRY_RUN: 'false', SOLANA_PRIVATE_KEY: 'x', EVM_PRIVATE_KEY: `0x${'ab'.repeat(32)}` }), {
    solana: ex.solana, evm: { walletBalanceUsd: async () => { throw new Error('RPC down'); } },
  });
  await assert.rejects(broken.balanceUsd(), /RPC down/, 'a partial sum would look like a drop');
});

test('doctor reads the hot wallet in real live mode: PASS with the balance, FAIL when the daily budget is above it', async () => {
  const cfg = defaultConfig({ DRY_RUN: 'false', EVM_PRIVATE_KEY: `0x${'ab'.repeat(32)}`, DAILY_BUDGET_USD: '150' });
  const storage = new Storage(':memory:');
  const by = (rows, n) => rows.find((r) => r.name === n);
  let rows = await runDoctor({ cfg, storage, mode: 'live', walletBalanceUsd: async () => 300 });
  assert.equal(by(rows, 'hot wallet').status, 'PASS');
  assert.equal(by(rows, 'hot wallet').detail, 'balance $300');
  rows = await runDoctor({ cfg, storage, mode: 'live', walletBalanceUsd: async () => 100 });
  assert.equal(by(rows, 'limits: budget vs balance').status, 'FAIL');
  rows = await runDoctor({ cfg, storage, mode: 'live', walletBalanceUsd: async () => { throw new Error('RPC down'); } });
  assert.equal(by(rows, 'hot wallet').status, 'WARN');
  storage.close();
});
