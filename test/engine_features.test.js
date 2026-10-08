import '../src/warnings.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config.js';
import { Storage } from '../src/storage.js';
import { Engine } from '../src/engine.js';
import { MockDataSource, MOCK_TOKENS } from '../src/data/mock.js';
import { LiveDataSource } from '../src/data/index.js';
import { parseEvmSecurity } from '../src/data/goplus.js';
import { analyzeToken, formatAnalysis } from '../src/analyzer.js';
import { strategyFactory } from '../src/strategy.js';
import { PaperExecutor } from '../src/executors/paper.js';
import { snapshotFrom } from '../src/guardian.js';

const [GOOD, BASE, , THIN, , RUG] = MOCK_TOKENS;

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

test('MOCKTHIN never opens a position; /why shows the cost-gate skip', async () => {
  const { storage, ds, engine } = setup();
  await engine.watch(THIN.address);
  for (let i = 0; i < 3; i++) {
    const [r] = await engine.tick();
    assert.notEqual(r.action, 'BUY');
    ds.advance();
  }
  assert.equal(storage.getOpenPosition(THIN.address, 'paper'), null);
  const skip = storage.decisionsFor(THIN.address, 20).find((d) => d.kind === 'skip');
  assert.match(engine.whyText(skip.id), /Not bought: FEES_EAT_PROFIT .*cost gate: target \+4\.0% barely covers a 7\.\d% round trip/);
  storage.close();
});

test('a paper SELL of a taxed token returns about the tax less', async () => {
  const { storage, engine } = setup();
  const b = await engine.buy(RUG.address, 50); // sell tax 5% at step 0
  const qty = b.fill.qty;
  const price = (await engine.analyze(RUG.address)).market.priceUsd;
  const s = await engine.sell(RUG.address, 100, 'test');
  const gross = qty * s.fill.price;
  assert.ok(Math.abs(s.fill.taxUsd - gross * 0.05) < 1e-9);
  assert.ok(Math.abs(s.fill.usd - gross * 0.95 * 0.997) < 1e-9);
  assert.ok(s.fill.usd < qty * price * 0.951);
  assert.equal(storage.costsPaid('paper').taxes > 2.4, true);
  storage.close();
});

test('guardian: MOCKRUG exits on cycle 2 even after setPaused(true); LIQ_DRAIN needs a second tick under 80%; cooldown', async () => {
  const { storage, ds, engine, messages } = setup();
  for (const t of MOCK_TOKENS) await engine.watch(t.address, t.chain);
  await engine.tick();
  assert.ok(storage.getOpenPosition(RUG.address, 'paper'));
  engine.setPaused(true);
  ds.advance();
  const r2 = await engine.tick();
  const rug = r2.find((r) => r.address === RUG.address);
  assert.equal(rug.action, 'SELL');
  assert.equal(rug.reason, 'GUARDIAN: TAX_UP');
  assert.equal(rug.verdict, 'AVOID');
  const closed = storage.listClosedPositions({ mode: 'paper' }).find((p) => p.address === RUG.address);
  assert.equal(closed.closeReason, 'GUARDIAN: TAX_UP');
  assert.ok(messages.some((m) => m.startsWith('PRACTICE GUARDIAN [MOCKRUG] Sell tax went from 5% to 35%. Selling now would cost about $17 of your $50 position. Action: practice SELL 100%')));
  ds.advance();
  await engine.tick();
  // Cycle 3: MOCKPOT drains >= 80% (fires at once); MOCKRUG drops 60% (180K -> 72K): seen once, pending.
  assert.ok(messages.some((m) => /GUARDIAN \[MOCKPOT\] Pool money fell/.test(m)));
  assert.ok(!messages.some((m) => /GUARDIAN \[MOCKRUG\] Pool money fell/.test(m)), 'one observation under 80% does not fire');
  assert.deepEqual(storage.getSnapshot(RUG.address, 'last')._pending, ['LIQ_DRAIN']);
  assert.equal(storage.getSnapshot(RUG.address, 'last').liquidityUsd, 180_000, 'pre-drop reference kept while pending');
  ds.advance();
  await engine.tick();
  assert.ok(messages.some((m) => /GUARDIAN \[MOCKRUG\] Pool money fell from \$180\.00K to \$72\.00K/.test(m)), 'LIQ_DRAIN confirmed on cycle 4');
  // Same type again within the cooldown: suppressed, not re-sent.
  const before = messages.filter((m) => /GUARDIAN \[MOCKRUG\] Pool money/.test(m)).length;
  storage.setSnapshot(RUG.address, 'base', 'last', Date.now(), { ...snapshotFrom(engine.lastAnalysis.get(RUG.address.toLowerCase())), liquidityUsd: 180_000, _pending: ['LIQ_DRAIN'] });
  ds.advance();
  await engine.tick();
  assert.equal(messages.filter((m) => /GUARDIAN \[MOCKRUG\] Pool money/.test(m)).length, before);
  assert.ok(storage.db.prepare("SELECT COUNT(*) AS n FROM guardian_events WHERE action = 'suppressed'").get().n >= 1);
  assert.match(engine.guardianText(), /MOCKRUG: Pool money \$180\.00K -> \$72\.00K/);
  storage.close();
});

test('guardian with real funds (DRY_RUN=false, GUARDIAN_LIVE_EXIT=false) only notifies', async () => {
  const { storage, ds, engine, messages } = setup({ DRY_RUN: 'false' }, {
    paper: new PaperExecutor(defaultConfig().trading),
    solana: { async buy() { throw new Error('no'); }, async sell() { throw new Error('must not sell'); } },
    evm: { async buy() { throw new Error('no'); }, async sell() { throw new Error('must not sell'); } },
  });
  engine.setMode('live', { confirm: true });
  const a = await engine.watch(RUG.address);
  engine.portfolio.recordBuy({ mode: 'live', token: { address: a.address, chain: a.chain, symbol: 'MOCKRUG' }, fill: { price: a.market.priceUsd, qty: 50 / a.market.priceUsd, usd: 50, feeUsd: 0 }, levels: null });
  storage.setSnapshot(a.address, a.chain, 'entry', Date.now(), snapshotFrom(a));
  ds.advance();
  const [r] = await engine.tick();
  assert.notEqual(r.action, 'SELL');
  assert.ok(storage.getOpenPosition(RUG.address, 'live'), 'still open');
  assert.ok(messages.some((m) => /GUARDIAN \[MOCKRUG\] Sell tax went from 5% to 35%.*auto-exit is off for real funds/.test(m)));
  storage.close();
});

test('link mode: no position until [I bought]; an SL hit sends a sell link instead of selling; no signing executor', async () => {
  let built = 0;
  const executors = {
    paper: new PaperExecutor(defaultConfig().trading),
    get solana() { built += 1; return null; },
    get evm() { built += 1; return null; },
  };
  const { storage, engine, messages } = setup({}, executors);
  engine.setMode('link');
  await engine.watch(GOOD.address);
  const [r] = await engine.tick();
  assert.equal(r.action, 'LINK');
  assert.equal(storage.listOpenPositions('link').length, 0);
  assert.equal(storage.listTrades({ mode: 'link' }).length, 0);
  const link = messages.find((m) => m.startsWith('LIVE LINK BUY MOCKGOOD: open https://phantom.com/ul/v1/swap?buy=solana%3A101%2Faddress%3AMockGood'));
  assert.ok(link, messages.join('\n'));
  await engine.confirmLinkBuy(r.pendingId);
  const pos = storage.getOpenPosition(GOOD.address, 'link');
  assert.ok(pos);
  storage.updatePosition(pos.id, { stopLoss: 1e9 });
  const [r2] = await engine.tick();
  assert.equal(r2.action, 'ALERT');
  assert.ok(storage.getOpenPosition(GOOD.address, 'link'), 'not sold by the bot');
  assert.ok(messages.some((m) => /^LIVE Time to sell MOCKGOOD \(stop hit\) -> https:\/\/phantom\.com/.test(m)));
  await engine.confirmLinkSell(pos.id);
  assert.equal(storage.getOpenPosition(GOOD.address, 'link'), null);
  assert.equal(built, 0, 'no live signing executor constructed in link mode');
  await assert.rejects(engine.confirmLinkBuy(r.pendingId), /expired or was already recorded/);
  storage.close();
});

test('held tokens refresh security at most every GUARDIAN_SECURITY_SEC; others keep SECURITY_CACHE_SEC', async () => {
  const ds = new LiveDataSource(defaultConfig({ USE_RUGCHECK: 'false', USE_HONEYPOT_IS: 'false' }));
  let calls = 0;
  ds.goplus = { getTokenSecurity: async () => { calls += 1; return parseEvmSecurity({ buy_tax: '0', sell_tax: '0' }); } };
  const market = { chain: 'base', token: { address: '0xabc', symbol: 'X' } };
  await ds.getSecurity(market);
  assert.equal(calls, 1);
  ds.secCache.get('base:0xabc').at = Date.now() - 400_000; // 400 s old
  await ds.getSecurity(market); // watched only: 900 s cache
  assert.equal(calls, 1);
  await ds.getSecurity(market, { maxAgeMs: 300_000 }); // held: 300 s
  assert.equal(calls, 2);
  await ds.getSecurity(market, { maxAgeMs: 300_000 });
  assert.equal(calls, 2, 'fresh entry reused');
});

test('LiveDataSource offline: quote hosts unreachable or USE_QUOTES=false -> estimate from pool size, no crash; identity listed', async () => {
  for (const useQuotes of ['true', 'false']) {
    const cfg = defaultConfig({ USE_QUOTES: useQuotes, USE_RUGCHECK: 'false', USE_HONEYPOT_IS: 'false' });
    const ds = new LiveDataSource(cfg);
    const mock = new MockDataSource({ now: 1_800_000_000_000 });
    ds.dex = { getTokenPairs: async () => [], search: async () => [] };
    ds.getMarket = (addr) => mock.getMarket(addr);
    ds.goplus = { getTokenSecurity: async () => parseEvmSecurity({ buy_tax: '0', sell_tax: '0', is_honeypot: '0' }) };
    ds.gecko = { getOhlcv: async () => [], getTokenInfo: async () => ({ coingeckoId: 'pepe' }) };
    let quoteCalls = 0;
    ds.quotes.fetchImpl = async () => { quoteCalls += 1; throw new TypeError('fetch failed'); };
    const a = await analyzeToken(ds, BASE.address, { p: cfg.analysis });
    assert.equal(a.costs.method, 'estimate');
    assert.match(formatAnalysis(a), /\(estimate from pool size\)/);
    assert.equal(a.identity.status, 'listed');
    assert.equal(quoteCalls, useQuotes === 'true' ? 1 : 0);
  }
});
