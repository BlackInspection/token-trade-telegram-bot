import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionSizeUsd, checkEntryAllowed, computeLevels, checkExit, effectiveStop, updateTrailHigh } from '../src/risk.js';
import { defaultConfig } from '../src/config.js';

const p = defaultConfig().analysis;

test('positionSizeUsd: fixed, percent of equity, caps', () => {
  assert.equal(positionSizeUsd({ equity: 1000, sizeUsd: 50 }), 50);
  assert.equal(positionSizeUsd({ equity: 1000, sizeUsd: 50, sizePct: 10 }), 100);
  assert.equal(positionSizeUsd({ equity: 1000, sizeUsd: 500, maxTradeUsd: 200 }), 200);
  assert.equal(positionSizeUsd({ equity: 1000, sizeUsd: 50, cash: 20 }), 20);
  assert.equal(positionSizeUsd({ equity: 1000, sizeUsd: 50, cash: 0 }), 0);
});

test('checkEntryAllowed enforces each limit', () => {
  const ok = { openPositions: 0, maxOpenPositions: 3, sizeUsd: 50, maxTradeUsd: 200 };
  assert.equal(checkEntryAllowed(ok).ok, true);
  assert.equal(checkEntryAllowed({ ...ok, paused: true }).ok, false);
  assert.equal(checkEntryAllowed({ ...ok, hasPosition: true }).ok, false);
  assert.equal(checkEntryAllowed({ ...ok, openPositions: 3 }).ok, false);
  assert.match(checkEntryAllowed({ ...ok, dailyPnlUsd: -100, dailyLossLimitUsd: 100 }).reason, /daily loss/);
  assert.equal(checkEntryAllowed({ ...ok, dailyPnlUsd: -99, dailyLossLimitUsd: 100 }).ok, true);
  assert.equal(checkEntryAllowed({ ...ok, tradesLastHour: 10, maxTradesPerHour: 10 }).ok, false);
  assert.match(checkEntryAllowed({ ...ok, sizeUsd: 201 }).reason, /MAX_TRADE_USD/);
  assert.equal(checkEntryAllowed({ ...ok, sizeUsd: 0 }).ok, false);
});

test('computeLevels: ATR based, clamped, default without ATR', () => {
  const a = computeLevels(100, 3, p); // 2*ATR = 6 -> 6%
  assert.equal(a.stopLoss, 94);
  assert.equal(a.takeProfit, 112); // 2R
  assert.equal(computeLevels(100, 0.1, p).stopLoss, 98); // clamped to MIN_SL_PCT 2%
  assert.equal(computeLevels(100, 50, p).stopLoss, 75); // clamped to MAX_SL_PCT 25%
  assert.equal(computeLevels(100, null, p).stopLoss, 90); // DEFAULT_SL_PCT 10%
  assert.equal(computeLevels(100, 3, { ...p, tpRr: 0 }).takeProfit, null);
  assert.equal(computeLevels(0, 3, p), null);
});

test('checkExit: stop, take-profit, trailing, stop wins inside one candle', () => {
  const pos = { entryPrice: 100, stopLoss: 95, takeProfit: 110, trailHigh: 100 };
  assert.equal(checkExit(pos, { price: 100 }), null);
  assert.deepEqual(checkExit(pos, { price: 94 }), { reason: 'STOP_LOSS', price: 94 });
  assert.deepEqual(checkExit(pos, { price: 111 }), { reason: 'TAKE_PROFIT', price: 111 });
  assert.deepEqual(checkExit(pos, { price: 100, high: 112, low: 94 }), { reason: 'STOP_LOSS', price: 95 });
  assert.deepEqual(checkExit(pos, { price: 108, high: 110.5, low: 104 }), { reason: 'TAKE_PROFIT', price: 110 });

  const trailed = { ...pos, takeProfit: null, trailHigh: updateTrailHigh(pos, 120) };
  assert.equal(trailed.trailHigh, 120);
  assert.equal(effectiveStop(trailed, 10), 108);
  assert.deepEqual(checkExit(trailed, { price: 107 }, 10), { reason: 'TRAILING_STOP', price: 107 });
  assert.equal(checkExit(trailed, { price: 109 }, 10), null);
  assert.equal(effectiveStop(trailed, 0), 95);
});
