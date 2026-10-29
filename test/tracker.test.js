import '../src/warnings.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config.js';
import { Storage } from '../src/storage.js';
import { Engine } from '../src/engine.js';
import { MockDataSource, MOCK_TOKENS } from '../src/data/mock.js';
import { strategyFactory } from '../src/strategy.js';
import { PaperExecutor } from '../src/executors/paper.js';
import { Tracker, hitFromCandles, labelOutcome, seenBeforeLine, summarize, wilson, formatTrackRecord, personalLine } from '../src/tracker.js';

const DAY = 86_400_000;

test('Wilson interval: n=0 and known values', () => {
  assert.deepEqual(wilson(0, 0), { p: null, lo: null, hi: null });
  const w = wilson(5, 10);
  assert.ok(Math.abs(w.lo - 0.2366) < 1e-3 && Math.abs(w.hi - 0.7634) < 1e-3, JSON.stringify(w));
  const z = wilson(0, 20);
  assert.equal(z.lo, 0);
  assert.ok(Math.abs(z.hi - 0.1611) < 1e-3);
  assert.ok(wilson(20, 20).hi <= 1);
});

test('labelOutcome: rugged vs delisted vs ok', () => {
  const obs = { price: 1, liquidity_usd: 100_000 };
  assert.equal(labelOutcome(obs, null).status, 'delisted');
  assert.equal(labelOutcome(obs, { priceUsd: 2, liquidityUsd: 9_000 }).status, 'rugged'); // < 10% of 100k
  assert.equal(labelOutcome({ price: 1, liquidity_usd: 2_000 }, { priceUsd: 1, liquidityUsd: 900 }, { rugLiqUsd: 1000 }).status, 'rugged');
  const ok = labelOutcome(obs, { priceUsd: 0.33, liquidityUsd: 50_000 });
  assert.equal(ok.status, 'ok');
  assert.ok(Math.abs(ok.retPct + 67) < 1e-9);
  assert.equal(hitFromCandles([{ t: 1, h: 2, l: 0.5 }], { from: 0, to: 5, stopLoss: 0.9, takeProfit: 1.5 }), 'sl'); // stop first
  assert.equal(hitFromCandles([{ t: 1, h: 2, l: 0.95 }], { from: 0, to: 5, stopLoss: 0.9, takeProfit: 1.5 }), 'tp');
  assert.equal(hitFromCandles([{ t: 9, h: 2, l: 0.1 }], { from: 0, to: 5, stopLoss: 0.9, takeProfit: 1.5 }), 'none');
});

function engineWithClock() {
  const cfg = defaultConfig();
  const storage = new Storage(':memory:');
  const ds = new MockDataSource({ now: 1_800_000_000_000 });
  let clock = 1_800_000_000_000;
  const engine = new Engine({
    cfg, storage, dataSource: ds, notifier: { adminIds: [], send: async () => {} }, executors: { paper: new PaperExecutor(cfg.trading) },
    strategyFactory: strategyFactory(cfg.strategy, cfg.analysis), now: () => clock,
  });
  return { cfg, storage, ds, engine, advance: (ms) => (clock += ms) };
}

test('observations: one per token per OBS_DEDUPE_MIN; re-analysis shows the Seen before line', async () => {
  const { storage, engine, advance } = engineWithClock();
  const GOOD = MOCK_TOKENS[0];
  await engine.analyze(GOOD.address);
  await engine.analyze(GOOD.address);
  const count = () => storage.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n;
  assert.equal(count(), 1);
  advance(61 * 60_000);
  await engine.analyze(GOOD.address);
  assert.equal(count(), 2);
  advance(3 * DAY);
  const a = await engine.analyze(GOOD.address);
  assert.match(a.seenBefore, /^Seen before: we checked this 3 d ago: BUY at \$0\.001800, now \$0\.001800 \(\+0%\)\.$/);
  assert.equal(seenBeforeLine({ ts: 0, verdict: 'WATCH', price: 0.0012 }, 0.0004, 3 * DAY), 'Seen before: we checked this 3 d ago: WATCH at $0.001200, now $0.0004000 (-66.7%).');
  storage.close();
});

test('runDue splits 61 addresses into 3 batch calls and is idempotent', async () => {
  const cfg = defaultConfig({ TRACK_HORIZONS: '1h', TRACK_TP_CHECK: 'false' });
  const storage = new Storage(':memory:');
  for (let i = 0; i < 61; i++) {
    storage.insertObservation({ ts: 1000, address: `A${i}`, chain: 'solana', symbol: `T${i}`, verdict: 'WATCH', price: 1, liquidityUsd: 50_000 });
  }
  const calls = [];
  const ds = {
    getMarketsBatch: async (chain, addrs) => {
      calls.push(addrs.length);
      return new Map(addrs.map((a) => [a, { priceUsd: 1.1, liquidityUsd: 40_000 }]));
    },
  };
  const tr = new Tracker({ storage, ds, cfg });
  const r1 = await tr.runDue(1000 + 3_600_000);
  assert.deepEqual(calls, [30, 30, 1]);
  assert.equal(r1.written, 61);
  const r2 = await tr.runDue(1000 + 3_600_000 + 5);
  assert.equal(r2.written, 0);
  assert.deepEqual(calls, [30, 30, 1]);
  storage.close();
});

test('summary keeps losers, computes the baseline and flags a small sample', () => {
  const rows = [
    { verdict: 'BUY', ret_pct: 12, status: 'ok', hit: 'tp', symbol: 'A' },
    { verdict: 'BUY', ret_pct: -60, status: 'ok', hit: 'sl', symbol: 'B' },
    { verdict: 'AVOID', ret_pct: -100, status: 'rugged', hit: null, symbol: 'C' },
    { verdict: 'WATCH', ret_pct: null, status: 'delisted', hit: null, symbol: 'D' },
  ];
  const s = summarize(rows, { horizon: '24h' });
  assert.equal(s.byVerdict.BUY.n, 2);
  assert.equal(s.byVerdict.BUY.fell50.k, 1, 'the losing BUY is kept');
  assert.equal(s.byVerdict.BUY.tpFirst.k, 1);
  assert.equal(s.baseline.n, 4);
  assert.equal(s.baseline.rugged.k, 1);
  assert.equal(s.baseline.delisted.k, 1);
  const text = formatTrackRecord(s, { minN: 20 });
  assert.match(text, /small sample \(n=4 < 20\)/);
  assert.match(text, /ALL   n=4 .*baseline/);
  assert.match(text, /B -60\.0% \(sl\)/);
  assert.match(text, /Only tokens checked with this bot; not a promise of future results/);
  assert.match(personalLine([{ verdict: 'AVOID', ret_pct: -70 }, { verdict: 'AVOID', ret_pct: -100 }], { sizeUsd: 50 }), /fell more than 50%: 2\. At your usual \$50 that is about \$85 not lost \(estimate\)/);
});

test('mock time travel: MOCKPOT is AVOID/rugged, BUY rows have TP/SL hits', async () => {
  const { storage, ds, engine } = engineWithClock();
  for (const t of MOCK_TOKENS) await engine.watch(t.address, t.chain);
  for (let i = 0; i < 2; i++) {
    await engine.tick();
    ds.advance();
  }
  const r = await engine.tracker.runDue(engine.now() + 8 * DAY);
  assert.equal(r.written, 18);
  assert.equal(r.batchCalls, 3); // one per chain: solana, base, bsc
  const { summary, text } = engine.tracker.report({ now: engine.now() + 8 * DAY });
  assert.equal(summary.byVerdict.AVOID.rugged.k, 1);
  assert.equal(summary.byVerdict.BUY.n, 3);
  assert.equal(summary.byVerdict.WATCH.n, 2);
  assert.match(text, /MOCKPOT rugged/);
  assert.match(text, /small sample \(n=6 < 20\)/);
  storage.close();
});
