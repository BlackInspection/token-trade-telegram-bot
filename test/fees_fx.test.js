import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fx } from '../src/fx.js';
import { defaultConfig } from '../src/config.js';
import { decideVerdict } from '../src/analyzer.js';

test('FX failure still renders the native currency; never blocks', async () => {
  const fx = new Fx({ currency: 'rub', fetchRates: async () => { throw new Error('down'); } });
  assert.equal(await fx.format(50), '$50.00');
  const ok = new Fx({ currency: 'rub', fetchRates: async () => ({ rub: 92, eur: 0.92 }) });
  assert.equal(await ok.format(50), '$50.00 (~4,600 RUB)');
  assert.equal(await new Fx({ currency: 'usd', fetchRates: () => { throw new Error('never called'); } }).format(1), '$1.00');
});

test('a rule with a minimum net profit blocks the item (FEES_EAT_PROFIT)', () => {
  const p = { ...defaultConfig().analysis, minNetProfitUsd: 2 };
  const ta = { ok: true, signal: 'bullish', reasons: ['EMA cross'] };
  const risk = { score: 0, hardAvoid: false, hardReasons: [] };
  const v = decideVerdict(risk, ta, p, { gate: { ok: true }, netEdge: { usd: 1.2, pct: 2.4 } });
  assert.equal(v.verdict, 'WATCH');
  assert.equal(v.cap.suite, 'FEES_EAT_PROFIT');
  assert.equal(decideVerdict(risk, ta, p, { gate: { ok: true }, netEdge: { usd: 3, pct: 6 } }).verdict, 'BUY');
  const gated = decideVerdict(risk, ta, p, { gate: { ok: false, reason: 'target +4.1% barely covers a 6.8% round trip' } });
  assert.equal(gated.verdict, 'WATCH');
  assert.match(gated.why, /cost gate: target \+4\.1% barely covers a 6\.8% round trip/);
});
