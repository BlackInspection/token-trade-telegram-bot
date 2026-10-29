import '../src/warnings.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventLog, MemoryEventLog, makeEvent, readEventsFile, validateEvent } from '../src/events.js';
import { aggregate, buildDigest, digestDue, localParts, readPeerFiles } from '../src/digest.js';
import { explainMore, eventPayload } from '../src/llm.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctb-events-'));
const ev = (over = {}) => makeEvent({
  ts: 1000, kind: 'skip', mode: 'dry', id: `ctb-${Math.random()}`, subject: { type: 'token', ref: '0xabc', title: 'T', url: '' },
  money: { ccy: 'USDC', price: 1, ref_price: null, fees: 0.3, net_edge: null, usd: 50 }, verdict: 'SKIP', score: 10, confidence: 'high',
  reasons: [{ code: 'FEES_EAT_PROFIT', sev: 'bad', p: { tpPct: 4, lossPct: 7 } }], ...over,
});

test('validator rejects a missing v, bot or kind', () => {
  assert.equal(validateEvent(ev()).ok, true);
  for (const k of ['v', 'bot', 'kind']) {
    const e = ev();
    delete e[k];
    assert.equal(validateEvent(e).ok, false, k);
  }
  assert.equal(validateEvent({ ...ev(), kind: 'hold' }).ok, false);
  assert.equal(validateEvent({ ...ev(), score: 101 }).ok, false);
  assert.throws(() => new MemoryEventLog().append({ ...ev(), v: 2 }), /invalid event/);
});

test('rotation happens at EVENTS_MAX_MB', () => {
  const dir = tmp();
  const file = path.join(dir, 'events.jsonl');
  const log = new EventLog({ file, maxMb: 0.001 }); // ~1 KB
  for (let i = 0; i < 20; i++) log.append(ev({ ts: 1000 + i }));
  assert.ok(fs.existsSync(`${file}.1`), 'rotated to .1');
  assert.ok(fs.statSync(file).size <= 1100);
  const all = log.read({});
  assert.ok(all.length >= 2 && all.length < 20, `${all.length}`); // older ones dropped beyond .1
  assert.deepEqual(all.map((e) => e.ts), [...all.map((e) => e.ts)].sort((a, b) => a - b));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('digest aggregation matches a fixture events file', () => {
  const dir = tmp();
  const file = path.join(dir, 'fixture.jsonl');
  const lines = [
    ev({ kind: 'alert', reasons: [] }), ev({ kind: 'buy', verdict: 'BUY', reasons: [] }), ev({ kind: 'buy', verdict: 'BUY', reasons: [], money: { ccy: 'USDC', usd: 25 } }),
    ev(), ev(), ev({ reasons: [{ code: 'LIMIT_EXPOSURE', sev: 'warn', p: { open: 3, max: 3 } }] }), ev({ reasons: [{ code: 'MUTED', sev: 'warn', p: {} }] }),
    ev({ kind: 'sell', verdict: null, reasons: [] }),
  ];
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\nnot json\n`);
  const r = readEventsFile(file);
  assert.equal(r.events.length, 8);
  assert.equal(r.bad, 1);
  const agg = aggregate(r.events);
  assert.deepEqual([agg.alerts, agg.buys, agg.sells, agg.skips, agg.spendUsd], [1, 2, 1, 4, 75]);
  assert.deepEqual(agg.topSkips, [{ code: 'FEES_EAT_PROFIT', n: 2 }, { code: 'LIMIT_EXPOSURE', n: 1 }, { code: 'MUTED', n: 1 }]);
  const d = buildDigest({
    events: r.events, since: 0, budgetUsd: 150, realizedUsd: -3, unrealizedUsd: 1.5, settings: { max_open: 3 },
    shadowBySkip: new Map([['LIMIT_EXPOSURE', { n: 1, positive: 1, netUsd: 4.1 }]]),
  });
  assert.match(d.text, /Alerts 1 · buys 2 · sells 1 · skips 4/);
  assert.match(d.text, /Spent \$75 of the \$150 daily budget/);
  assert.match(d.text, /FEES_EAT_PROFIT x2: Fees eat the profit: target \+4% vs a 7% round trip\./);
  assert.match(d.text, /1 deal was skipped by max_open=3; it would be up \$4\.10 net today\./);
  assert.deepEqual(d.buttons[0].map((b) => b.data), ['tune:max_open:4', 'tune:keep']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('peer event files: missing or malformed are skipped without a crash; valid ones form the Other bots line', () => {
  const dir = tmp();
  const good = path.join(dir, 'peer.jsonl');
  const badFile = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(good, `${JSON.stringify({ ...ev({ kind: 'buy', verdict: 'BUY', money: { ccy: 'TON', usd: 36 } }), bot: 'getgems-checker' })}\n`);
  fs.writeFileSync(badFile, '{"nope": true}\n<<<\n');
  const warnings = [];
  const r = readPeerFiles([good, badFile, path.join(dir, 'missing.jsonl')], { warn: (m) => warnings.push(m) });
  assert.equal(r.events.length, 1);
  assert.equal(r.skipped.length, 2);
  assert.equal(warnings.length, 2);
  const d = buildDigest({ events: [ev({ kind: 'buy', verdict: 'BUY', reasons: [] })], since: 0, budgetUsd: 0, realizedUsd: 0, unrealizedUsd: 0, peerEvents: r.events });
  assert.match(d.text, /Other bots: getgems-checker 1 buys \$36 · total spent, this bot included, \$86 \(USD\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('digest schedule: once per local day at DIGEST_AT in DIGEST_TZ', () => {
  const t = Date.UTC(2026, 9, 28, 18, 5); // 21:05 in Moscow (UTC+3)
  assert.deepEqual(localParts(t, 'Europe/Moscow'), { day: '2026-10-28', hm: '21:05' });
  assert.equal(digestDue({ now: t, digestAt: '21:00', tz: 'Europe/Moscow', lastSentDay: null }).due, true);
  assert.equal(digestDue({ now: t, digestAt: '21:00', tz: 'Europe/Moscow', lastSentDay: '2026-10-28' }).due, false);
  assert.equal(digestDue({ now: t, digestAt: '22:00', tz: 'Europe/Moscow', lastSentDay: null }).due, false);
});

test('LLM path makes no network call and builds no client when ANTHROPIC_API_KEY is empty', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('fetch must not be called');
  };
  try {
    const r = await explainMore(ev(), { apiKey: '', model: 'claude-sonnet-5-5', clientFactory: () => { throw new Error('client must not be built'); } });
    assert.equal(r, null);
  } finally {
    globalThis.fetch = origFetch;
  }
  // With a key: the payload is the event only (no key), and refusals are handled.
  let seen = null;
  const fake = async (key) => ({ beta: { messages: { create: async (body) => { seen = { key, body }; return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Plain words.' }] }; } } } });
  assert.equal(await explainMore(ev(), { apiKey: 'sk-test-123', model: 'claude-sonnet-5-5', clientFactory: fake }), 'Plain words.');
  assert.equal(seen.body.model, 'claude-sonnet-5-5');
  assert.ok(!JSON.stringify(seen.body).includes('sk-test-123'));
  assert.deepEqual(Object.keys(eventPayload(ev())).sort(), ['bot', 'confidence', 'kind', 'mode', 'money', 'reasons', 'score', 'subject', 'ts', 'v', 'verdict'].sort());
});
