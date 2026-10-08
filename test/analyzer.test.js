import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config.js';
import { scoreRisk, decideVerdict, analyzeToken, formatAnalysis } from '../src/analyzer.js';
import { parseEvmSecurity, parseSolanaSecurity, emptySecurity } from '../src/data/goplus.js';
import { parseHoneypotIs } from '../src/data/honeypot.js';
import { mergeHoneypotIs } from '../src/data/index.js';
import { pickBestPair, parsePair } from '../src/data/dexscreener.js';
import { MockDataSource, MOCK_TOKENS } from '../src/data/mock.js';

const p = defaultConfig().analysis;

/** Trimmed from a real GoPlus response for PEPE (Ethereum). */
const PEPE_RAW = {
  buy_tax: '0', sell_tax: '0', transfer_tax: '0', cannot_buy: '0', cannot_sell_all: '0', is_honeypot: '0',
  is_mintable: '0', is_proxy: '0', is_open_source: '1', is_blacklisted: '1', hidden_owner: '0',
  can_take_back_ownership: '0', owner_change_balance: '0', selfdestruct: '0', external_call: '0',
  slippage_modifiable: '0', personal_slippage_modifiable: '0', transfer_pausable: '1', trading_cooldown: '0',
  owner_address: '0x0000000000000000000000000000000000000000', creator_percent: '0.000000', owner_percent: '0.0',
  holder_count: '602248',
  dex: [{ pair: '0xa43fe16908251ee70ef74718545e4fe6c5ccec9f' }],
  holders: [
    { address: '0xf977814e90da44bfa03b6295a0616a897441acec', percent: '0.109068', is_locked: 0 },
    { address: '0x1d48963dd8fada6ab5c2c7b92eba81ecc5030270', percent: '0.061665', is_locked: 0 },
    { address: '0xa43fe16908251ee70ef74718545e4fe6c5ccec9f', percent: '0.2', is_locked: 0 }, // LP pool: excluded
    { address: '0x000000000000000000000000000000000000dead', percent: '0.3', is_locked: 0 }, // burn: excluded
  ],
  lp_holders: [{ address: '0x6982508145454ce325ddbe47a25d4ec3d2311933', percent: '0.9937', is_locked: 0 }],
};

/** Trimmed from a real GoPlus Solana response for BONK. */
const BONK_RAW = {
  mintable: { authority: [], status: '0' }, freezable: { authority: [], status: '0' },
  balance_mutable_authority: { authority: [], status: '0' }, closable: { authority: [], status: '0' },
  metadata_mutable: { metadata_upgrade_authority: [{ address: '9AhK' }], status: '1' },
  default_account_state: '1', non_transferable: '0', transfer_fee: {}, transfer_hook: [],
  holder_count: '1020153',
  holders: [{ account: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', percent: '0.0883', is_locked: 0 }],
};

const market = (over = {}) => ({
  chain: 'ethereum', dexId: 'uniswap', labels: [], pairAddress: '0xpair', url: '',
  token: { address: '0xabc', name: 'T', symbol: 'T' }, quote: { address: '', symbol: 'WETH' }, tokenIsBase: true,
  priceUsd: 1, priceNative: null, liquidityUsd: 1_000_000, fdv: 1e7, marketCap: 1e7,
  volume: { m5: 1e3, h1: 1e4, h6: 1e5, h24: 1e6 }, priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 },
  txns: { m5: { buys: 1, sells: 1 }, h1: { buys: 50, sells: 40 }, h6: { buys: 1, sells: 1 }, h24: { buys: 1, sells: 1 } },
  pairCreatedAt: 0, pairAgeHours: 24 * 100, ...over,
});
const bullish = { ok: true, signal: 'bullish', reasons: ['EMA cross', 'RSI ok'], atr: 0.01 };
const neutral = { ok: true, signal: 'neutral', reasons: ['no clear trend'], atr: 0.01 };

test('parseEvmSecurity on real PEPE shape', () => {
  const s = parseEvmSecurity(PEPE_RAW);
  assert.equal(s.isHoneypot, false);
  assert.equal(s.hasBlacklist, true);
  assert.equal(s.transferPausable, true);
  assert.equal(s.ownerRenounced, true);
  assert.equal(s.buyTaxPct, 0);
  assert.equal(s.holderCount, 602248);
  assert.ok(Math.abs(s.top10Pct - 17.0733) < 1e-3, `top10 ${s.top10Pct}`);
  assert.equal(s.lpLockedPct, 0);
});

test('GoPlus taxes are fractions -> percent', () => {
  const s = parseEvmSecurity({ ...PEPE_RAW, buy_tax: '0.05', sell_tax: '0.12' });
  assert.ok(Math.abs(s.buyTaxPct - 5) < 1e-9);
  assert.ok(Math.abs(s.sellTaxPct - 12) < 1e-9);
  assert.equal(parseEvmSecurity({ ...PEPE_RAW, buy_tax: '' }).buyTaxPct, null);
});

test('parseSolanaSecurity on real BONK shape', () => {
  const s = parseSolanaSecurity(BONK_RAW);
  assert.equal(s.kind, 'solana');
  assert.equal(s.isMintable, false);
  assert.equal(s.freezable, false);
  assert.equal(s.metadataMutable, true);
  assert.equal(s.defaultFrozen, false);
  assert.ok(Math.abs(s.top10Pct - 8.83) < 1e-9);
});

test('honeypot.is merge: worst case wins', () => {
  const hp = parseHoneypotIs({ honeypotResult: { isHoneypot: true }, simulationResult: { buyTax: 3, sellTax: 40 } });
  const s = mergeHoneypotIs(parseEvmSecurity(PEPE_RAW), hp);
  assert.equal(s.isHoneypot, true);
  assert.equal(s.sellTaxPct, 40);
  assert.deepEqual(s.sources, ['goplus', 'honeypot.is']);
});

test('PEPE-like token scores low risk', () => {
  const r = scoreRisk(market(), parseEvmSecurity(PEPE_RAW), p);
  assert.equal(r.hardAvoid, false);
  assert.ok(r.score > 0 && r.score <= 30, `score ${r.score}`);
});

test('hard rule: honeypot => AVOID even with bullish TA', () => {
  const sec = { ...parseEvmSecurity(PEPE_RAW), isHoneypot: true };
  const r = scoreRisk(market(), sec, p);
  assert.equal(r.hardAvoid, true);
  assert.equal(decideVerdict(r, bullish, p).verdict, 'AVOID');
});

test('hard rule: sell tax above limit => AVOID even with bullish TA', () => {
  const sec = parseEvmSecurity({ ...PEPE_RAW, sell_tax: '0.15' });
  const r = scoreRisk(market(), sec, p);
  assert.equal(r.hardAvoid, true);
  assert.match(r.hardReasons.join(), /sell tax 15\.0% > limit 10%/);
  assert.equal(decideVerdict(r, bullish, p).verdict, 'AVOID');
});

test('low liquidity and missing market are hard avoids', () => {
  assert.equal(scoreRisk(market({ liquidityUsd: 5000 }), parseEvmSecurity(PEPE_RAW), p).hardAvoid, true);
  const none = scoreRisk(null, null, p);
  assert.equal(none.hardAvoid, true);
  assert.equal(decideVerdict(none, null, p).verdict, 'AVOID');
});

test('verdicts: clean+bullish=BUY, clean+neutral=WATCH, risky=AVOID, medium risk blocks BUY', () => {
  const clean = scoreRisk(market(), parseEvmSecurity({ ...PEPE_RAW, is_blacklisted: '0', transfer_pausable: '0' }), p);
  assert.equal(decideVerdict(clean, bullish, p).verdict, 'BUY');
  assert.equal(decideVerdict(clean, neutral, p).verdict, 'WATCH');
  assert.equal(decideVerdict({ ...clean, score: 75 }, bullish, p).verdict, 'AVOID');
  assert.equal(decideVerdict({ ...clean, score: 50 }, bullish, p).verdict, 'WATCH');
});

test('unknown security adds risk but is not a hard avoid', () => {
  const r = scoreRisk(market(), emptySecurity('evm'), p);
  assert.equal(r.hardAvoid, false);
  assert.ok(r.reasons.some((x) => x.text === 'security data unavailable'));
});

test('pickBestPair: most liquid base pair, chain filter, quote fallback', () => {
  const A = '0xAAAA000000000000000000000000000000000001';
  const pairs = [
    { chainId: 'ethereum', baseToken: { address: A }, quoteToken: { address: '0xw' }, liquidity: { usd: 100 }, pairAddress: 'p1' },
    { chainId: 'ethereum', baseToken: { address: A.toLowerCase() }, quoteToken: { address: '0xw' }, liquidity: { usd: 900 }, pairAddress: 'p2' },
    { chainId: 'pulsechain', baseToken: { address: A }, quoteToken: { address: '0xw' }, liquidity: { usd: 5000 }, pairAddress: 'p3' },
    { chainId: 'ethereum', baseToken: { address: '0xb' }, quoteToken: { address: A }, liquidity: { usd: 99999 }, pairAddress: 'p4' },
  ];
  assert.equal(pickBestPair(pairs, A).pairAddress, 'p3');
  assert.equal(pickBestPair(pairs, A, 'ethereum').pairAddress, 'p2');
  assert.equal(pickBestPair([pairs[3]], A).pairAddress, 'p4');
  assert.equal(pickBestPair(pairs, A, 'solana'), null);
});

test('parsePair inverts price when the token is the quote side', () => {
  const m = parsePair(
    { chainId: 'ethereum', dexId: 'u', pairAddress: 'p', baseToken: { address: '0xb', symbol: 'B' }, quoteToken: { address: '0xa', symbol: 'A' },
      priceUsd: '10', priceNative: '2', liquidity: { usd: 1 }, pairCreatedAt: 1000 },
    '0xa', 3_601_000,
  );
  assert.equal(m.tokenIsBase, false);
  assert.equal(m.token.symbol, 'A');
  assert.equal(m.priceUsd, 5);
  assert.equal(m.pairAgeHours, 1);
});

test('analyzeToken on mock data: healthy => BUY, honeypot => AVOID', async () => {
  const ds = new MockDataSource({ now: 1_800_000_000_000 });
  const verdicts = {};
  for (const t of MOCK_TOKENS) {
    const a = await analyzeToken(ds, t.address, { p });
    verdicts[t.label] = a.verdict.verdict;
    assert.ok(formatAnalysis(a).includes('VERDICT'));
  }
  assert.deepEqual(verdicts, { MOCKGOOD: 'BUY', MOCKBASE: 'BUY', MOCKPOT: 'AVOID', MOCKTHIN: 'WATCH', MOCKFAKE: 'WATCH', MOCKRUG: 'BUY' });
  const none = await analyzeToken(ds, '0x1234567890123456789012345678901234567890', { p });
  assert.equal(none.verdict.verdict, 'AVOID');
});
