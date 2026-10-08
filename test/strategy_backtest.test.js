import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config.js';
import { EmaCrossRsiStrategy, strategyFactory } from '../src/strategy.js';
import { runBacktest, maxDrawdown, computeStats, formatBacktest } from '../src/backtest.js';
import { buildMockCandles } from '../src/data/mock.js';

const cfg = defaultConfig();
const p = cfg.analysis;
const candles = buildMockCandles({ p0: 1, seed: 11, endT: 1_800_000_000_000 });

function lastSignal(risk) {
  const st = new EmaCrossRsiStrategy(p);
  st.warmup(candles.slice(0, -1));
  return st.onCandle(candles[candles.length - 1], { position: null, risk });
}

test('default strategy: BUY on fresh EMA cross with RSI in range', () => {
  const s = lastSignal({ score: 0, hardAvoid: false });
  assert.equal(s.action, 'BUY');
  assert.match(s.reason, /crossed above/);
  assert.ok(s.atr > 0);
});

test('risk gate blocks entries', () => {
  assert.equal(lastSignal({ score: 0, hardAvoid: true }).action, 'HOLD');
  assert.equal(lastSignal({ score: p.maxBuyRisk + 1, hardAvoid: false }).action, 'HOLD');
  assert.equal(lastSignal(undefined).action, 'BUY'); // no gate (backtest --ignore-risk)
});

test('strategy exits on bearish cross when in position', () => {
  const st = new EmaCrossRsiStrategy(p);
  const t0 = 1_700_000_000_000;
  const series = [...Array.from({ length: 40 }, (_, i) => 100 + i), ...Array.from({ length: 15 }, (_, i) => 139 - i * 3)];
  let sell = null;
  series.forEach((c, i) => {
    const s = st.onCandle({ t: t0 + i * 300_000, o: c, h: c + 0.5, l: c - 0.5, c, v: 1 }, { position: { qty: 1 } });
    if (s.action === 'SELL' && !sell) sell = s;
  });
  assert.ok(sell, 'expected a SELL');
});

test('candle with the same timestamp replaces the forming candle', () => {
  const st = new EmaCrossRsiStrategy(p);
  st.onCandle({ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 });
  st.onCandle({ t: 1, o: 1, h: 2, l: 1, c: 2, v: 1 });
  st.onCandle({ t: 0, o: 1, h: 1, l: 1, c: 1, v: 1 }); // older: ignored
  assert.equal(st.candles.length, 1);
  assert.equal(st.candles[0].c, 2);
});

test('strategyFactory rejects unknown names', () => {
  assert.throws(() => strategyFactory('nope', p), /Unknown strategy/);
});

test('maxDrawdown', () => {
  assert.deepEqual(maxDrawdown([100, 120, 90, 130, 117]), { pct: 25, usd: 30 });
  assert.equal(maxDrawdown([1, 2, 3]).pct, 0);
});

test('computeStats', () => {
  const trades = [{ pnlUsd: 10, pnlPct: 10 }, { pnlUsd: -5, pnlPct: -5 }, { pnlUsd: 5, pnlPct: 5 }];
  const s = computeStats(trades, [{ equity: 1000 }, { equity: 1010 }], 1000, [{ c: 1 }, { c: 2 }]);
  assert.equal(s.trades, 3);
  assert.equal(s.wins, 2);
  assert.ok(Math.abs(s.winRate - 66.666) < 0.01);
  assert.equal(s.totalPnlUsd, 10);
  assert.equal(s.profitFactor, 3);
  assert.equal(s.buyHoldPct, 100);
});

test('backtest on mock candles + a take-profit continuation', () => {
  const extra = [];
  let last = candles[candles.length - 1];
  for (let i = 1; i <= 5; i++) {
    const c = last.c * 1.02;
    extra.push({ t: last.t + 300_000, o: last.c, h: c * 1.001, l: last.c * 0.999, c, v: 5000 });
    last = extra[extra.length - 1];
  }
  const series = [...candles, ...extra];
  const res = runBacktest(series, { strategy: new EmaCrossRsiStrategy(p), analysis: p, trading: cfg.trading, risk: { score: 0, hardAvoid: false } });
  const tp = res.trades.find((t) => t.exitReason === 'TAKE_PROFIT');
  assert.ok(tp, `trades: ${JSON.stringify(res.trades.map((t) => t.exitReason))}`);
  assert.ok(tp.pnlUsd > 0);
  assert.equal(res.curve.length, series.length);
  assert.ok(Math.abs(res.stats.finalEquity - (cfg.trading.startEquity + res.stats.totalPnlUsd)) < 1e-6);
  assert.match(formatBacktest(res, { symbol: 'M', timeframe: '5m', candles: series }), /win rate/);
});

test('backtest with hard-avoid risk never trades', () => {
  const res = runBacktest(candles, { strategy: new EmaCrossRsiStrategy(p), analysis: p, trading: cfg.trading, risk: { score: 100, hardAvoid: true } });
  assert.equal(res.trades.length, 0);
  assert.equal(res.stats.finalEquity, cfg.trading.startEquity);
});
