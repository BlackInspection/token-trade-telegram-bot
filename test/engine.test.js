import '../src/warnings.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config.js';
import { Storage } from '../src/storage.js';
import { Engine, TradeRefused } from '../src/engine.js';
import { MockDataSource, MOCK_TOKENS } from '../src/data/mock.js';
import { strategyFactory } from '../src/strategy.js';
import { PaperExecutor } from '../src/executors/paper.js';
import { JupiterExecutor } from '../src/executors/jupiter.js';
import { EvmExecutor } from '../src/executors/evm.js';

function setup(overrides = {}) {
  const cfg = defaultConfig(overrides);
  const storage = new Storage(':memory:');
  const ds = new MockDataSource({ now: 1_800_000_000_000 });
  const messages = [];
  const engine = new Engine({
    cfg, storage, dataSource: ds,
    notifier: { adminIds: [], send: async (t) => void messages.push(t) },
    executors: {
      paper: new PaperExecutor(cfg.trading),
      solana: new JupiterExecutor(cfg, { dry: true, offline: true }),
      evm: new EvmExecutor(cfg, { dry: true, offline: true }),
    },
    strategyFactory: strategyFactory(cfg.strategy, cfg.analysis),
  });
  return { cfg, storage, ds, engine, messages };
}
const [GOOD, BASE, POT, THIN, FAKE, RUG] = MOCK_TOKENS;

test('paper pipeline: healthy tokens BUY, honeypot / thin / copycat never bought; next cycle exits', async () => {
  const { engine, storage, ds, messages } = setup();
  for (const t of MOCK_TOKENS) await engine.watch(t.address, t.chain);
  const r1 = await engine.tick();
  // GOOD, BASE, POT, THIN (cost gate), FAKE (possible copycat), RUG
  assert.deepEqual(r1.map((r) => r.action), ['BUY', 'BUY', 'HOLD', 'SKIP', 'SKIP', 'BUY']);
  assert.match(r1[3].note, /cost gate/);
  assert.match(r1[4].note, /possible copycat of MOCKGOOD/);
  assert.equal(storage.listOpenPositions('paper').length, 3);
  assert.equal(storage.getOpenPosition(POT.address, 'paper'), null);
  assert.equal(storage.getOpenPosition(THIN.address, 'paper'), null);
  assert.equal(storage.getOpenPosition(FAKE.address, 'paper'), null);
  assert.ok(messages.some((m) => m.startsWith('PRACTICE BUY MOCKGOOD')));

  ds.advance();
  const r2 = await engine.tick();
  assert.deepEqual(r2.map((r) => r.reason ?? null).slice(0, 2), ['TAKE_PROFIT', 'STOP_LOSS']);
  assert.equal(r2[5].reason, 'GUARDIAN: TAX_UP');
  assert.equal(storage.listOpenPositions('paper').length, 0);
  assert.equal(storage.getOpenPosition(THIN.address, 'paper'), null);
  assert.ok(engine.portfolio.cash() < 1000);
  storage.close();
});

test('manual buy of a honeypot is refused; manual buy respects MAX_TRADE_USD', async () => {
  const { engine, storage } = setup();
  await assert.rejects(engine.buy(POT.address, 10), TradeRefused);
  await assert.rejects(engine.buy(GOOD.address, 500), /MAX_TRADE_USD/);
  const r = await engine.buy(GOOD.address, 25);
  assert.equal(r.fill.usd, 25);
  const s = await engine.sell(GOOD.address, 50);
  assert.equal(s.closed, false);
  await engine.sell(GOOD.address);
  await assert.rejects(engine.sell(GOOD.address), /no open practice position/);
  storage.close();
});

test('limits: max open positions and daily loss', async () => {
  const { engine, storage } = setup({ MAX_OPEN_POSITIONS: '1', DAILY_LOSS_LIMIT_USD: '5' });
  for (const t of MOCK_TOKENS) await engine.watch(t.address, t.chain);
  const r1 = await engine.tick();
  assert.deepEqual(r1.map((r) => r.action), ['BUY', 'SKIP', 'HOLD', 'SKIP', 'SKIP', 'SKIP']);
  assert.match(r1[1].note, /max open positions/);
  assert.match(r1[5].note, /max open positions/);
  storage.insertTrade({ mode: 'paper', address: 'x', side: 'SELL', qty: 1, price: 1, usd: 1, pnlUsd: -6 });
  await engine.sell(GOOD.address);
  await assert.rejects(engine.buy(BASE.address, 10), /daily loss limit/);
  storage.close();
});

test('pause blocks new entries; live mode with DRY_RUN records dry trades', async () => {
  const { engine, storage } = setup();
  await engine.watch(GOOD.address);
  engine.setPaused(true);
  assert.equal((await engine.tick())[0].action, 'PAUSED');
  engine.setPaused(false);
  engine.setMode('live');
  const r = await engine.buy(BASE.address, 20);
  assert.equal(r.fill.dry, true);
  assert.equal(r.fill.venue, '0x');
  // Shared contract: DRY_RUN=true is practice, whatever the route.
  assert.match(r.message, /^PRACTICE BUY MOCKBASE/);
  assert.match(r.message, /DRY_RUN: simulated/);
  const s = await engine.buy(GOOD.address, 20);
  assert.equal(s.fill.venue, 'jupiter');
  assert.equal(storage.listOpenPositions('live').length, 2);
  assert.equal(storage.listOpenPositions('paper').length, 0);
  storage.close();
});

test('live mode without DRY_RUN needs explicit confirm; settings overrides persist', async () => {
  const { engine, storage } = setup({ DRY_RUN: 'false' });
  assert.throws(() => engine.setMode('live'), /confirm/);
  assert.equal(engine.setMode('live', { confirm: true }), 'live');
  engine.setSetting('size_usd', '75');
  assert.equal(engine.cfg.trading.sizeUsd, 75);
  assert.throws(() => engine.setSetting('nope', '1'), /unknown setting/);
  assert.throws(() => engine.setSetting('size_usd', '-1'), /non-negative/);
  assert.throws(() => engine.setSetting('timeframe', '7m'));
  storage.close();
});

test('real live executor without keys fails with a clear .env error', async () => {
  const { engine, storage } = setup({ DRY_RUN: 'false' });
  engine.executors.solana = new JupiterExecutor(engine.cfg, { dry: false, offline: true });
  engine.setMode('live', { confirm: true });
  await assert.rejects(engine.buy(GOOD.address, 10), /SOLANA_PRIVATE_KEY is not set in \.env/);
  storage.close();
});
