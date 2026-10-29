import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { defaultConfig } from '../src/config.js';
import { RISK_WEIGHTS, analyzeToken, scoreRisk } from '../src/analyzer.js';
import { HARD_CODES, SUITE_CODES, TEMPLATES, coverage, disagreements, formatCard, renderAlert, sentence, trafficLight } from '../src/explain.js';
import { candidatesFrom, rankCandidates, judgeClone, resolveIdentity } from '../src/data/identity.js';
import { escapeHtml, htmlToText } from '../src/format.js';
import { MockDataSource, MOCK_TOKENS } from '../src/data/mock.js';
import { parseEvmSecurity, emptySecurity } from '../src/data/goplus.js';
import { parseHoneypotIs } from '../src/data/honeypot.js';
import { mergeHoneypotIs } from '../src/data/index.js';

const p = defaultConfig().analysis;
const DATA = {
  buyTaxPct: 12.5, sellTaxPct: 25, taxPct: 25, top10Pct: 62, insiderPct: 8, lpLockedPct: 10, ageHours: 5, liquidityUsd: 15_000,
  volume24h: 4000, sells: 90, buys: 12, changePct: -63, holders: 42, lossPct: 6.8, sizeUsd: 50, getBackUsd: 46.6, limitPct: 15,
  minUsd: 20_000, symbol: 'BONK', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', tpPct: 4.1, netUsd: 0.4, n: 3, ageSec: 400,
  usd: 250, max: 200, spent: 50, budget: 50, count: 10, open: 3, rsi: 81, mult: 2.5, barsAgo: 1, score: 55, lostUsd: 52, budgetUsd: 50,
  streak: 3, pnlUsd: -100, above: 100, type: 'TAX_UP',
};
const bad = (s) => /undefined|NaN/.test(s);

test('every RISK_WEIGHTS key, hard code and suite code has an en template without undefined/NaN', () => {
  const codes = [...Object.keys(RISK_WEIGHTS), ...HARD_CODES, ...Object.keys(SUITE_CODES), 'possibleClone', 'costGate', 'netProfitLow', 'unlisted'];
  for (const code of codes) {
    assert.equal(typeof TEMPLATES.en[code], 'function', `missing en template for ${code}`);
    const full = TEMPLATES.en[code](DATA, { sizeUsd: 50 });
    const empty = TEMPLATES.en[code]({}, { sizeUsd: 50 });
    assert.ok(full.length > 5 && !bad(full), `${code}: ${full}`);
    assert.ok(!bad(empty), `${code} (no data): ${empty}`);
  }
  assert.equal(TEMPLATES.en.sellTax({ sellTaxPct: 25 }, { sizeUsd: 50 }), 'Selling costs a 25% tax: from $50 you would get back about $37.50 before any price move.');
  assert.equal(sentence('honeypot'), 'You can buy this token but you cannot sell it.');
});

test('every reason code emitted by the code base has a template (scanned from src)', () => {
  const src = fs.readdirSync(new URL('../src/', import.meta.url), { recursive: true }).filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')).join('\n');
  const used = new Set([...src.matchAll(/code: '([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]));
  const ignore = new Set(['REFUSED', 'NO_POSITION']);
  for (const code of used) if (!ignore.has(code)) assert.ok(TEMPLATES.en[code], `no template for ${code}`);
});

test('scoreRisk returns stable codes with data; hard reasons exposed as risk.hard', async () => {
  const ds = new MockDataSource({ now: 1_800_000_000_000 });
  const a = await analyzeToken(ds, MOCK_TOKENS[2].address, { p });
  assert.deepEqual(a.risk.hard.map((h) => h.code), ['honeypot', 'sellTaxOverLimit', 'noSellRoute', 'roundTripTooHigh']);
  assert.ok(a.risk.reasons.every((r) => r.code in RISK_WEIGHTS && typeof r.points === 'number'));
  assert.equal(a.risk.hardReasons.length, a.risk.hard.length);
  assert.match(a.risk.hardReasons.join(), /no route to sell this token back/);
});

test('trafficLight: RED on hard avoid, YELLOW on low coverage / clone / disagreement, GREEN otherwise', async () => {
  const ds = new MockDataSource({ now: 1_800_000_000_000 });
  const colors = {};
  for (const t of MOCK_TOKENS) colors[t.label] = (await analyzeToken(ds, t.address, { p })).light.color;
  assert.deepEqual(colors, { MOCKGOOD: 'GREEN', MOCKBASE: 'GREEN', MOCKPOT: 'RED', MOCKTHIN: 'YELLOW', MOCKFAKE: 'YELLOW', MOCKRUG: 'YELLOW' });
  const good = await analyzeToken(ds, MOCK_TOKENS[0].address, { p });
  assert.equal(good.light.action, 'No known red flags (not a guarantee)');
  // GoPlus failed: never GREEN and the missing checks are listed.
  const noSec = { ...good, security: emptySecurity('solana'), risk: { ...good.risk, score: 25 } };
  noSec.coverage = coverage(noSec);
  assert.ok(noSec.coverage.checked / noSec.coverage.total < 0.8);
  assert.ok(noSec.coverage.missing.includes('LP lock') && noSec.coverage.missing.includes('mint'));
  assert.equal(trafficLight(noSec, p).color, 'YELLOW');
  // coverage < 0.8 is never GREEN even with score 0
  const lowCov = { ...noSec, risk: { ...good.risk, score: 0 } };
  assert.equal(trafficLight(lowCov, p).color, 'YELLOW');
  assert.match(formatCard(lowCov), /missing: .*LP lock/);
});

test('disagreements: honeypot.is sellable vs GoPlus cannot_sell_all, and tax gaps over 5 pts', () => {
  const sec = mergeHoneypotIs(parseEvmSecurity({ cannot_sell_all: '1', buy_tax: '0.02', sell_tax: '0.03' }), parseHoneypotIs({ honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 2, sellTax: 9 } }));
  const d = disagreements({ security: sec, costs: null });
  assert.equal(d.length, 2);
  assert.match(d[0], /Sources disagree on selling/);
  assert.match(d[1], /Sources disagree on sell tax \(GoPlus 3%, honeypot.is 9%\); treated as risky/);
  const a = { risk: scoreRisk({ liquidityUsd: 1e6, pairAgeHours: 1000, volume: { h24: 1e6 }, txns: { h1: { buys: 1, sells: 1 } }, priceChange: { h24: 0 } }, sec, p), security: sec, coverage: { checked: 12, total: 12, missing: [] }, identity: { status: 'listed' } };
  a.risk.score = 0;
  assert.equal(trafficLight(a, p).color, 'YELLOW');
});

test('identity ranking: listed beats older beats liquidity; the impostor with the most liquidity never wins', () => {
  const now = 1_800_000_000_000;
  const DAY = 86_400_000;
  const market = { chain: 'solana', token: { address: 'Fake111', symbol: '$BONK', name: 'Bonk' }, pairCreatedAt: now - 2 * 3_600_000, liquidityUsd: 40_000 };
  const pairs = [
    { chainId: 'ethereum', baseToken: { address: '0xbig', symbol: 'BONK', name: 'Bonk Inu' }, liquidity: { usd: 9e7 }, pairCreatedAt: now - 40 * DAY },
    { chainId: 'solana', baseToken: { address: 'DezXAZ', symbol: 'Bonk', name: 'Bonk' }, liquidity: { usd: 2e7 }, pairCreatedAt: now - 600 * DAY },
    { chainId: 'solana', baseToken: { address: 'DezXAZ', symbol: 'Bonk', name: 'Bonk' }, liquidity: { usd: 1e6 }, pairCreatedAt: now - 700 * DAY },
    { chainId: 'solana', baseToken: { address: 'Fake111', symbol: 'BONK', name: 'Bonk' }, liquidity: { usd: 1 } },
    { chainId: 'solana', baseToken: { address: 'Other', symbol: 'WIF', name: 'dogwifhat' }, liquidity: { usd: 1e9 } },
  ];
  const c = candidatesFrom(pairs, market);
  assert.deepEqual(c.map((x) => x.address).sort(), ['0xbig', 'DezXAZ']);
  assert.equal(c.find((x) => x.address === 'DezXAZ').pairCreatedAt, now - 700 * DAY);
  assert.equal(rankCandidates(c)[0].address, 'DezXAZ', 'older beats liquidity');
  c.find((x) => x.address === '0xbig').listed = true;
  assert.equal(rankCandidates(c)[0].address, '0xbig', 'listed beats older');
  c.find((x) => x.address === '0xbig').listed = false;
  const j = judgeClone(market, rankCandidates(c), now);
  assert.equal(j.status, 'possible_clone');
  assert.equal(j.original.address, 'DezXAZ');
  assert.equal(judgeClone(market, [], now).status, 'unlisted');
});

test('resolveIdentity: listed, possible clone with the original, unknown on failure', async () => {
  const ds = new MockDataSource({ now: 1_800_000_000_000 });
  const good = await ds.getMarket(MOCK_TOKENS[0].address);
  assert.equal((await resolveIdentity(ds, good)).status, 'listed');
  const fake = await ds.getMarket(MOCK_TOKENS[4].address);
  const id = await resolveIdentity(ds, fake, { now: ds.now });
  assert.equal(id.status, 'possible_clone');
  assert.equal(id.original.address, MOCK_TOKENS[0].address);
  const broken = { getTokenInfo: async () => null, searchPairs: async () => { throw new Error('down'); } };
  assert.equal((await resolveIdentity(broken, fake)).status, 'unknown');
  const card = formatCard(await analyzeToken(ds, MOCK_TOKENS[4].address, { p }), { now: ds.now });
  assert.match(card, /YELLOW · Be careful/);
  assert.match(card, /Possible copycat: the well-known MOCKGOOD is MockGo…1111 \(solana, 30 days old\)\. This one is 2 hours old\./);
});

test('cards: MOCKPOT is RED with the plain honeypot sentence; every card <= 900 chars', async () => {
  const ds = new MockDataSource({ now: 1_800_000_000_000 });
  for (const t of MOCK_TOKENS) {
    const card = formatCard(await analyzeToken(ds, t.address, { p }), { now: ds.now });
    assert.ok(card.length <= 900, `${t.label}: ${card.length}`);
    if (t.label === 'MOCKPOT') {
      assert.match(card, /RED · Don&quot;t buy|RED · Don't buy/);
      assert.match(card, /You can buy this token but you cannot sell it\./);
      assert.match(card, /Selling costs a 99% tax: from \$50 you would get back about \$0\.50/);
    }
  }
});

test('escapeHtml and alert rendering stay safe and under 4096 chars', () => {
  assert.equal(escapeHtml('<b>"x" & y</b>'), '&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;');
  const r = renderAlert({ tag: 'PRACTICE', title: 'BUY <script>alert(1)</script>', why: ['a < b'], details: Array.from({ length: 400 }, (_, i) => `line ${i} with <tags>`), risk: 'x>y', buttons: [[{ text: 'Why?', data: 'why:1' }]] });
  assert.ok(r.html.length < 4096, `${r.html.length}`);
  assert.ok(!r.html.includes('<script>'));
  assert.match(r.html, /&lt;script&gt;/);
  assert.match(r.html, /<blockquote expandable>Why: a &lt; b/);
  assert.match(r.text, /^PRACTICE BUY <script>/);
  assert.equal(htmlToText('<b>a &amp; b</b>'), 'a & b');
});
