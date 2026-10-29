import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionFor, diff, EVENT_TYPES, inCooldown, snapshotFrom, tightenStop } from '../src/guardian.js';

const th = { taxUpPts: 5, maxSellTaxPct: 10, lpLockDropPts: 20, liqDropPct: 30, liqDropEntryPct: 50, top10UpPts: 10 };
const base = {
  priceUsd: 1, liquidityUsd: 100_000, pairAddress: 'p', buyTaxPct: 0, sellTaxPct: 5, isHoneypot: false, cannotSellAll: false,
  isMintable: false, ownerAddress: '0x0000000000000000000000000000000000000000', ownerRenounced: true, canTakeBackOwnership: false,
  isProxy: false, taxModifiable: true, lpLockedPct: 95, top10Pct: 20, m5Buys: 6, m5Sells: 3, sellRoute: true, devHoldingPct: 5,
};
const types = (r) => r.events.map((e) => e.type);
const ctx = { positionCostUsd: 50, positionValueUsd: 49.5 };

test('one case per event type', () => {
  const cases = {
    TAX_UP: { sellTaxPct: 35 },
    HONEYPOT_ON: { isHoneypot: true },
    SELL_ROUTE_LOST: { sellRoute: false },
    MINT_ON: { isMintable: true },
    OWNER_BACK: { ownerRenounced: false, ownerAddress: '0x3000000000000000000000000000000000000003' },
    LP_LOCK_DOWN: { lpLockedPct: 40 },
    LIQ_DRAIN: { liquidityUsd: 10_000 }, // -90%: no second observation needed
    DEV_SELLING: { devHoldingPct: 3 },
    TOP10_UP: { top10Pct: 35 },
    SELL_BURST: { m5Sells: 40, m5Buys: 5 },
  };
  for (const [type, change] of Object.entries(cases)) {
    const r = diff(base, { ...base, ...change }, base, th, ctx);
    assert.ok(types(r).includes(type), `${type}: ${JSON.stringify(types(r))}`);
    const ev = r.events.find((e) => e.type === type);
    assert.equal(ev.severity, ['DEV_SELLING', 'TOP10_UP', 'SELL_BURST'].includes(type) ? 'warn' : 'critical');
    assert.ok(ev.text.length > 10);
  }
  // PAIR_GONE needs two checks with no market.
  assert.deepEqual(types(diff(base, { marketMissing: true }, base, th, ctx)), []);
  assert.deepEqual(diff(base, { marketMissing: true }, base, th, ctx).pending, ['PAIR_GONE']);
  assert.deepEqual(types(diff({ marketMissing: true }, { marketMissing: true }, base, th, ctx)), ['PAIR_GONE']);
  assert.equal(EVENT_TYPES.length, 11);
  assert.equal(diff(base, base, base, th, ctx).events.length, 0);
});

test('TAX_UP text is before -> after in money terms', () => {
  const r = diff(base, { ...base, sellTaxPct: 35 }, base, th, ctx);
  assert.equal(r.events[0].text, 'Sell tax went from 5% to 35%. Selling now would cost about $17 of your $50 position.');
});

test('null values never fire; they are reported as data missing', () => {
  const nulls = Object.fromEntries(Object.keys(base).map((k) => [k, null]));
  const r1 = diff(base, nulls, base, th, ctx);
  assert.equal(r1.events.length, 0);
  assert.ok(r1.missing.includes('TAX_UP') && r1.missing.includes('LIQ_DRAIN'));
  assert.equal(diff(nulls, { ...base, sellTaxPct: 90, isHoneypot: true }, null, th, ctx).events.length, 0);
  assert.equal(diff(null, base, null, th, ctx).events.length, 0);
});

test('LIQ_DRAIN needs two observations unless the drop is >= 80%', () => {
  const first = diff(base, { ...base, liquidityUsd: 60_000 }, base, th, ctx); // -40%
  assert.deepEqual(types(first), []);
  assert.deepEqual(first.pending, ['LIQ_DRAIN']);
  const second = diff(base, { ...base, liquidityUsd: 60_000 }, base, th, { ...ctx, pending: first.pending });
  assert.deepEqual(types(second), ['LIQ_DRAIN']);
  assert.deepEqual(types(diff(base, { ...base, liquidityUsd: 15_000 }, base, th, ctx)), ['LIQ_DRAIN']);
  // vs entry: -55% from entry, only -10% from last
  const entry = { ...base, liquidityUsd: 100_000 };
  const r = diff({ ...base, liquidityUsd: 50_000 }, { ...base, liquidityUsd: 45_000 }, entry, th, { ...ctx, pending: ['LIQ_DRAIN'] });
  assert.deepEqual(types(r), ['LIQ_DRAIN']);
});

test('tightening never lowers a stop; cooldown; action ladder', () => {
  assert.equal(tightenStop(90, 100, 5), 95);
  assert.equal(tightenStop(97, 100, 5), 97);
  assert.equal(tightenStop(null, 100, 5), 95);
  for (const [stop, price] of [[10, 5], [0.5, 1], [99, 100]]) assert.ok(tightenStop(stop, price, 5) >= stop);
  assert.equal(inCooldown(1000, 1000 + 29 * 60_000, 30), true);
  assert.equal(inCooldown(1000, 1000 + 31 * 60_000, 30), false);
  assert.equal(inCooldown(null, 5, 30), false);
  const crit = { severity: 'critical' };
  assert.equal(actionFor(crit, { hasPosition: true, mode: 'paper', dryRun: false, liveExit: false }), 'exit');
  assert.equal(actionFor(crit, { hasPosition: true, mode: 'live', dryRun: true, liveExit: false }), 'exit');
  assert.equal(actionFor(crit, { hasPosition: true, mode: 'live', dryRun: false, liveExit: false }), 'alert');
  assert.equal(actionFor(crit, { hasPosition: true, mode: 'live', dryRun: false, liveExit: true }), 'exit');
  assert.equal(actionFor(crit, { hasPosition: true, mode: 'link', dryRun: false, liveExit: true }), 'link_exit');
  assert.equal(actionFor({ severity: 'warn' }, { hasPosition: true, mode: 'paper' }), 'tighten');
  assert.equal(actionFor(crit, { hasPosition: false, mode: 'paper' }), 'alert');
});

test('snapshotFrom keeps unknowns as null', () => {
  const s = snapshotFrom({ market: { priceUsd: 1, liquidityUsd: 5, pairAddress: 'p', txns: { m5: { buys: 1, sells: 2 } } }, security: null, costs: null });
  assert.equal(s.sellTaxPct, null);
  assert.equal(s.sellRoute, null);
  assert.equal(s.m5Sells, 2);
  assert.deepEqual(snapshotFrom({ market: null }), { marketMissing: true });
});
