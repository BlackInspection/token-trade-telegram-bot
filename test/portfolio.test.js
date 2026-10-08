import '../src/warnings.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from '../src/storage.js';
import { Portfolio, paperBuyFill, paperSellFill, InsufficientCashError } from '../src/portfolio.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const token = { address: 'TokenA1111111111111111111111111111111111111', chain: 'solana', symbol: 'TKA' };

test('paper fills apply slippage and fees', () => {
  const b = paperBuyFill({ usd: 100, price: 2, slippageBps: 100, feeBps: 30 });
  near(b.price, 2.02);
  near(b.feeUsd, 0.3);
  near(b.qty, 99.7 / 2.02);
  const s = paperSellFill({ qty: 10, price: 2, slippageBps: 100, feeBps: 30 });
  near(s.price, 1.98);
  near(s.grossUsd, 19.8);
  near(s.usd, 19.8 - 0.0594);
});

test('paper portfolio: buy, partial sell, full sell, cash and PnL in SQLite', () => {
  const st = new Storage(':memory:');
  const pf = new Portfolio(st, { startEquity: 1000 });
  const fill = { ...paperBuyFill({ usd: 100, price: 1 }), venue: 'paper' };
  const pos = pf.recordBuy({ mode: 'paper', token, fill, levels: { stopLoss: 0.9, takeProfit: 1.2 }, reason: 'test' });
  near(pf.cash(), 900);
  assert.equal(pos.qty, 100);
  assert.equal(pos.stopLoss, 0.9);
  near(pf.equity(new Map([[token.address.toLowerCase(), 1.5]])), 900 + 150);

  const half = pf.recordSell({ position: pos, fill: { ...paperSellFill({ qty: 50, price: 1.5 }), venue: 'paper' }, reason: 'half' });
  near(half.pnlUsd, 25);
  assert.equal(half.closed, false);
  near(st.getOpenPosition(token.address, 'paper').qty, 50);
  near(pf.cash(), 975);

  const rest = pf.recordSell({ position: st.getOpenPosition(token.address, 'paper'), fill: { ...paperSellFill({ qty: 50, price: 0.8 }), venue: 'paper' }, reason: 'rest' });
  near(rest.pnlUsd, -10);
  assert.equal(rest.closed, true);
  assert.equal(st.getOpenPosition(token.address, 'paper'), null);
  near(pf.cash(), 1015);

  const s = pf.stats('paper');
  assert.equal(s.closed, 1);
  assert.equal(s.wins, 1); // realized total +15
  near(s.realizedPnl, 15);
  assert.equal(st.listTrades({ mode: 'paper' }).length, 3);
  st.close();
});

test('paper buy beyond cash is rejected; live mode does not touch cash', () => {
  const st = new Storage(':memory:');
  const pf = new Portfolio(st, { startEquity: 50 });
  assert.throws(() => pf.recordBuy({ mode: 'paper', token, fill: paperBuyFill({ usd: 60, price: 1 }) }), InsufficientCashError);
  pf.recordBuy({ mode: 'live', dry: true, token, fill: paperBuyFill({ usd: 60, price: 1 }) });
  near(pf.cash(), 50);
  const live = st.getOpenPosition(token.address, 'live');
  assert.equal(live.dry, true);
  assert.equal(st.getOpenPosition(token.address, 'paper'), null);
  st.close();
});

test('adding to a position averages the entry price', () => {
  const st = new Storage(':memory:');
  const pf = new Portfolio(st, { startEquity: 1000 });
  pf.recordBuy({ mode: 'paper', token, fill: paperBuyFill({ usd: 100, price: 1 }) });
  const pos = pf.recordBuy({ mode: 'paper', token, fill: paperBuyFill({ usd: 100, price: 2 }) });
  near(pos.qty, 150);
  near(pos.entryPrice, 200 / 150);
  st.close();
});

test('kv and watchlist persistence', () => {
  const st = new Storage(':memory:');
  st.setKv('mode', 'live');
  assert.equal(st.getKv('mode'), 'live');
  assert.equal(st.getKv('missing', 7), 7);
  st.addWatch({ address: '0xAbC0000000000000000000000000000000000001', chain: 'base', symbol: 'X' });
  st.addWatch({ address: '0xAbC0000000000000000000000000000000000001', chain: 'base', symbol: null });
  assert.equal(st.listWatch().length, 1);
  assert.equal(st.listWatch()[0].symbol, 'X');
  assert.equal(st.removeWatch('0xabc0000000000000000000000000000000000001'), true);
  assert.equal(st.listWatch().length, 0);
  st.close();
});
