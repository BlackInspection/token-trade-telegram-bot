import '../src/warnings.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSeatbelts, isLoosening, lossStreak, seatbeltStatus, startOfNextUtcMonth } from '../src/risk.js';
import { LOOSEN_DIRECTION, defaultConfig } from '../src/config.js';
import { Storage } from '../src/storage.js';
import { Engine } from '../src/engine.js';
import { MockDataSource, MOCK_TOKENS } from '../src/data/mock.js';
import { strategyFactory } from '../src/strategy.js';
import { PaperExecutor } from '../src/executors/paper.js';

const NOW = Date.UTC(2026, 9, 28, 20, 0);
const MIN = 60_000;
const loss = (address, minAgo, pnl = -5, closeReason = 'manual') => ({ address, realizedPnlUsd: pnl, closedAt: NOW - minAgo * MIN, closeReason });

test('budget block until next month', () => {
  const r = checkSeatbelts({ now: NOW, closedPositions: [loss('a', 600)], monthPnlUsd: -52, budgetUsd: 50 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'LOSS_BUDGET');
  assert.equal(r.until, startOfNextUtcMonth(NOW));
  assert.match(r.reason, /Back on 1 Nov 00:00 UTC/);
  assert.equal(checkSeatbelts({ now: NOW, monthPnlUsd: -52, budgetUsd: 0 }).ok, true, '0 = budget not set');
});

test('streak cooldown and its end time; override skips it', () => {
  const closed = [loss('a', 20, -5, 'STOP_LOSS'), loss('b', 60), loss('c', 90, -30)];
  assert.equal(lossStreak(closed), 3);
  const r = checkSeatbelts({ now: NOW, closedPositions: closed, monthPnlUsd: -38, budgetUsd: 50, streakPause: 3, cooldownMin: 120, revengeMin: 0 });
  assert.equal(r.code, 'LOSS_STREAK');
  assert.equal(r.until, NOW - 20 * MIN + 120 * MIN);
  assert.equal(r.reason, 'Paused: 3 losses in a row. $12 of your $50 monthly budget left. Back at 21:40 UTC.');
  assert.equal(checkSeatbelts({ now: NOW + 101 * MIN, closedPositions: closed, monthPnlUsd: -38, budgetUsd: 50, revengeMin: 0 }).ok, true);
  assert.equal(checkSeatbelts({ now: NOW, closedPositions: closed, monthPnlUsd: -38, budgetUsd: 50, override: true, revengeMin: 0 }).ok, true);
  assert.equal(lossStreak([{ realizedPnlUsd: 3 }, ...closed]), 0);
});

test('revenge block and AVOID add-on block', () => {
  const r = checkSeatbelts({ now: NOW, closedPositions: [loss('0xAbc', 12, -5, 'STOP_LOSS')], address: '0xabc', revengeMin: 60 });
  assert.equal(r.code, 'REVENGE_BLOCK');
  assert.match(r.reason, /12 min ago.*Back at 20:48 UTC/);
  assert.equal(checkSeatbelts({ now: NOW, closedPositions: [loss('0xAbc', 12, -5, 'STOP_LOSS')], address: '0xdef', revengeMin: 60 }).ok, true);
  assert.equal(checkSeatbelts({ now: NOW, verdict: 'AVOID' }).code, 'AVOID_ADD_ON');
  assert.equal(seatbeltStatus({ streak: 1, streakPause: 3, budgetUsd: 0, monthPnlUsd: 0 }), 'Seatbelts: 1 loss in a row (pause after 3) · monthly budget not set');
});

test('loosening is delayed 24 h while tightening is instant', () => {
  assert.equal(isLoosening(LOOSEN_DIRECTION.max_trade_usd, 200, 300), true);
  assert.equal(isLoosening(LOOSEN_DIRECTION.max_trade_usd, 200, 100), false);
  assert.equal(isLoosening(LOOSEN_DIRECTION.cooldown_min, 120, 30), true);
  assert.equal(isLoosening(LOOSEN_DIRECTION.loss_budget, 0, 50), false, 'setting a budget is tightening');
  assert.equal(isLoosening(LOOSEN_DIRECTION.loss_budget, 50, 100), true);
  assert.equal(isLoosening(LOOSEN_DIRECTION.loss_budget, 50, 0), true, 'removing a budget is loosening');

  const cfg = defaultConfig();
  const storage = new Storage(':memory:');
  let clock = NOW;
  const engine = new Engine({
    cfg, storage, dataSource: new MockDataSource({ now: NOW }), notifier: { adminIds: [], send: async () => {} },
    executors: { paper: new PaperExecutor(cfg.trading) }, strategyFactory: strategyFactory(cfg.strategy, cfg.analysis), now: () => clock,
  });
  const r = engine.changeSetting('max_trade_usd', '300');
  assert.equal(r.effectiveAt, NOW + 24 * 3_600_000);
  assert.equal(engine.cfg.trading.maxTradeUsd, 200);
  assert.match(engine.settingsText(), /max_trade_usd = 200 \(pending: 300 takes effect at/);
  clock += 24 * 3_600_000 + 1;
  engine.applySettings();
  assert.equal(engine.cfg.trading.maxTradeUsd, 300);
  assert.equal(engine.changeSetting('max_trade_usd', '150').effectiveAt, null);
  assert.equal(engine.cfg.trading.maxTradeUsd, 150);
  storage.close();
});

test('engine: seatbelts refuse entries in practice, but stop-loss exits still go through during a cooldown', async () => {
  const cfg = defaultConfig({ LOSS_BUDGET_MONTH_USD: '50' });
  const storage = new Storage(':memory:');
  const ds = new MockDataSource({ now: NOW });
  const engine = new Engine({
    cfg, storage, dataSource: ds, notifier: { adminIds: [], send: async () => {} },
    executors: { paper: new PaperExecutor(cfg.trading) }, strategyFactory: strategyFactory(cfg.strategy, cfg.analysis), now: () => Date.now(),
  });
  const [GOOD, BASE] = MOCK_TOKENS;
  // An open position, then three losing closes in a row.
  await engine.buy(BASE.address, 20);
  for (let i = 0; i < 3; i++) {
    await engine.buy(GOOD.address, 10);
    storage.updatePosition(storage.getOpenPosition(GOOD.address, 'paper').id, { qty: storage.getOpenPosition(GOOD.address, 'paper').qty * 0.5 });
    await engine.sell(GOOD.address, 100, 'test loss');
  }
  await assert.rejects(engine.buy(GOOD.address, 10), /Paused: 3 losses in a row\. \$\d+(\.\d+)? of your \$50 monthly budget left\. Back at \d\d:\d\d UTC\./);
  // The stop-loss of the open position still sells.
  storage.updatePosition(storage.getOpenPosition(BASE.address, 'paper').id, { stopLoss: 1e9 });
  await engine.watch(BASE.address);
  const res = await engine.processToken(storage.getWatch(BASE.address));
  assert.equal(res.action, 'SELL');
  assert.equal(res.reason, 'STOP_LOSS');
  storage.close();
});
