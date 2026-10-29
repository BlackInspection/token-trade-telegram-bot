import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atrHint, baseLossPct, buildCosts, costGate, cpImpact, effectiveLiquidity, estimateRoundTrip, maxSafeSize, netEdgeAtTarget } from '../src/costs.js';
import { paperBuyFill, paperSellFill } from '../src/portfolio.js';
import { runBacktest } from '../src/backtest.js';
import { EmaCrossRsiStrategy } from '../src/strategy.js';
import { buildMockCandles } from '../src/data/mock.js';
import { defaultConfig } from '../src/config.js';

const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (eps ${eps})`);

test('cpImpact is monotonic in size, falls with liquidity and goes to 0 for huge pools', () => {
  let prev = 0;
  for (const s of [1, 10, 100, 1000, 10_000]) {
    const i = cpImpact(s, 100_000);
    assert.ok(i > prev);
    prev = i;
  }
  assert.ok(cpImpact(100, 1e6) < cpImpact(100, 1e5));
  assert.ok(cpImpact(100, 1e15) < 1e-12);
  assert.equal(cpImpact(0, 1000), 0);
  assert.equal(cpImpact(10, 0), 1);
});

test('a zero-impact round trip equals fees plus taxes', () => {
  const r = estimateRoundTrip({ sizeUsd: 100, liquidityUsd: 1e15, buyTaxPct: 3, sellTaxPct: 4, dexFeeBps: 30 });
  near(r.getBackUsd, 100 * 0.997 * 0.997 * 0.97 * 0.96, 1e-6);
  near(r.lossPct, baseLossPct({ buyTaxPct: 3, sellTaxPct: 4, dexFeeBps: 30 }), 1e-6);
  near(r.breakevenPct, (100 / r.getBackUsd - 1) * 100, 1e-9);
  assert.equal(r.method, 'estimate');
  const gas = estimateRoundTrip({ sizeUsd: 100, liquidityUsd: 1e15, dexFeeBps: 0, networkFeeUsd: 2 });
  near(gas.getBackUsd, 96, 1e-6);
});

test('maxSafeSize meets the limit and 1% more breaks it; taxes case', () => {
  const params = { liquidityUsd: 200_000, buyTaxPct: 0, sellTaxPct: 0, dexFeeBps: 30, networkFeeUsd: 0.02 };
  const r = maxSafeSize(3, params);
  assert.equal(r.reason, 'ok');
  assert.ok(estimateRoundTrip({ ...params, sizeUsd: r.usd }).lossPct <= 3);
  assert.ok(estimateRoundTrip({ ...params, sizeUsd: r.usd * 1.01 }).lossPct > 3);
  const t = maxSafeSize(3, { ...params, buyTaxPct: 3, sellTaxPct: 3 });
  assert.equal(t.usd, null);
  assert.equal(t.reason, 'taxes');
  assert.ok(t.baseLossPct > 6);
});

test('effectiveLiquidity reproduces a measured loss within 0.05 pp', () => {
  for (const [size, loss, taxes] of [[100, 0.8, {}], [50, 2.6, { buyTaxPct: 1 }], [1000, 6.8, { sellTaxPct: 2 }]]) {
    const liq = effectiveLiquidity(size, loss, { dexFeeBps: 30, ...taxes });
    const back = estimateRoundTrip({ sizeUsd: size, liquidityUsd: liq, dexFeeBps: 30, ...taxes });
    near(back.lossPct, loss, 0.05);
  }
  // A quote better than fees alone means a very deep pool.
  assert.ok(effectiveLiquidity(100, 0.1, { dexFeeBps: 30 }) >= 1e11);
});

test('costGate pass and fail; atrHint is advisory text', () => {
  assert.equal(costGate({ tpPct: 10, lossPct: 2, mult: 3 }).ok, true);
  const f = costGate({ tpPct: 4.1, lossPct: 6.8, mult: 3 });
  assert.equal(f.ok, false);
  assert.match(f.reason, /target \+4\.1% barely covers a 6\.8% round trip/);
  assert.equal(costGate({ tpPct: null, lossPct: 3 }).ok, true);
  assert.equal(atrHint({ atrPct: 0.4, lossPct: 2.6, timeframe: '5m' }), 'price moves ~0.4% per 5m candle but a round trip costs 2.6%; 1h fits better');
  assert.equal(atrHint({ atrPct: 2, lossPct: 1, timeframe: '5m' }), null);
});

test('buildCosts: taxes case, no sell route, quote path; netEdgeAtTarget', () => {
  const p = defaultConfig().analysis;
  const market = { chain: 'base', liquidityUsd: 24_000 };
  const c = buildCosts({ market, security: { buyTaxPct: 3, sellTaxPct: 3 }, sizeUsd: 50, p });
  assert.equal(c.maxSafeUsd, null);
  assert.equal(c.maxSafeReason, 'taxes');
  assert.ok(c.lossPct > 6.8 && c.lossPct < 7.5, `${c.lossPct}`);
  const dead = buildCosts({ market, security: null, sizeUsd: 50, p, quote: { method: 'estimate (mock)', sellRoute: false } });
  assert.equal(dead.getBackUsd, 0);
  assert.equal(dead.sellRoute, false);
  const q = buildCosts({ market: { chain: 'solana', liquidityUsd: 5e6 }, security: { buyTaxPct: 0, sellTaxPct: 0 }, sizeUsd: 100, p, quote: { method: 'jupiter', getBackUsd: 99.844, sellRoute: true } });
  near(q.getBackUsd, 99.844 - 0.02, 1e-9); // gas added on top of the quote
  assert.ok(q.maxSafeUsd > 1000);
  // The fitted model reproduces the quoted loss at the quoted size.
  near(estimateRoundTrip({ sizeUsd: 100, liquidityUsd: q.effLiquidityUsd, dexFeeBps: q.feeBps }).lossPct, 0.156, 0.01);
  // A quote much worse than the reported pool explains: the pool is thinner than reported.
  const thin = buildCosts({ market: { chain: 'solana', liquidityUsd: 5e6 }, security: { buyTaxPct: 0, sellTaxPct: 0 }, sizeUsd: 100, p, quote: { method: 'jupiter', getBackUsd: 90, sellRoute: true } });
  assert.ok(thin.effLiquidityUsd < 5e6);
  near(estimateRoundTrip({ sizeUsd: 100, liquidityUsd: thin.effLiquidityUsd, dexFeeBps: thin.feeBps }).lossPct, 10, 0.05);
  near(netEdgeAtTarget({ sizeUsd: 100, tpPct: 10, lossPct: 2 }).usd, 7.8, 1e-9);
});

test('realistic paper fills: impact replaces slippage and token taxes are applied', () => {
  const b = paperBuyFill({ usd: 100, price: 1, slippageBps: 100, feeBps: 30, impactPct: 0.5, buyTaxPct: 3 });
  near(b.price, 1.005, 1e-12);
  near(b.taxUsd, 99.7 * 0.03, 1e-9);
  near(b.qty, (99.7 * 0.97) / 1.005, 1e-9);
  const s = paperSellFill({ qty: 100, price: 1, feeBps: 30, impactPct: 0, sellTaxPct: 10 });
  near(s.taxUsd, 10, 1e-9);
  near(s.usd, 90 * 0.997, 1e-9);
});

test('backtest with realistic fills counts cost-gate skips; --fixed-slippage keeps the old behaviour', () => {
  const cfg = defaultConfig();
  const candles = buildMockCandles({ p0: 1, seed: 11, endT: 1_800_000_000_000 });
  const extra = [];
  let last = candles[candles.length - 1];
  for (let i = 0; i < 5; i++) {
    const c = last.c * 1.02;
    extra.push({ t: last.t + 300_000, o: last.c, h: c, l: last.c, c, v: 5000 });
    last = extra[extra.length - 1];
  }
  const series = [...candles, ...extra];
  const thin = runBacktest(series, { strategy: new EmaCrossRsiStrategy(cfg.analysis), analysis: cfg.analysis, trading: cfg.trading, risk: { score: 0, hardAvoid: false }, costs: { liquidityUsd: 24_000, buyTaxPct: 3, sellTaxPct: 3, costGateMult: 3 } });
  assert.ok(thin.trades.length >= 1);
  assert.equal(thin.gateSkips, thin.trades.length);
  const fixed = runBacktest(series, { strategy: new EmaCrossRsiStrategy(cfg.analysis), analysis: cfg.analysis, trading: cfg.trading, risk: { score: 0, hardAvoid: false } });
  assert.equal(fixed.gateSkips, 0);
  assert.equal(fixed.realistic, false);
});
