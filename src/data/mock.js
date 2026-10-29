// Offline mock data source with fixture tokens. Same interface as LiveDataSource.
//  - MOCKGOOD (solana) and MOCKBASE (base, EVM): clean, listed, fresh EMA bullish cross -> BUY
//  - MOCKPOT  (bsc, EVM): honeypot, 99% sell tax, no sell route -> AVOID (hard rule); liquidity rugged from step 2
//  - MOCKTHIN (base): low risk but 3%+3% tax on a $24k pool -> the cost gate blocks the buy
//  - MOCKFAKE (solana): copycat with MOCKGOOD's symbol and name, 2 h old -> possible clone, never auto-bought
//  - MOCKRUG  (base): bought on cycle 1; sell tax 5% -> 35% from step 1, liquidity x0.4 from step 2 (guardian)
// Each advance() appends one candle per token (price path continues), so a multi-cycle
// mock run shows entries and then exits (take-profit / stop / guardian).
import { parseEvmSecurity, parseSolanaSecurity } from './goplus.js';
import { parseHoneypotIs } from './honeypot.js';
import { mergeHoneypotIs } from './index.js';
import { resolveIdentity } from './identity.js';

const TF_MS = 5 * 60_000;
const DAY = 86_400_000;

/** Deterministic PRNG. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Downtrend -> base -> rally whose EMA9/EMA21 cross lands on the last bars with RSI ~55-65.
 * @returns {import('./geckoterminal.js').Candle[]}
 */
export function buildMockCandles({ p0, seed, n = 200, endT, vol = 1 }) {
  const rnd = mulberry32(seed);
  const rets = [];
  const rallyLen = 9;
  for (let i = 0; i < n; i++) {
    const noise = (rnd() - 0.5) * 0.006;
    let r;
    if (i < n - 40) r = -0.0012 + noise + 0.004 * Math.sin(i / 4); // slow bleed
    else if (i < n - rallyLen) r = -0.0015 + noise * 0.5 + (i % 2 ? 0.003 : -0.003); // choppy base
    else r = i % 3 === 2 ? -0.004 : 0.0075; // rally with pullbacks
    // vol > 1: same shape, bigger recent candles (bigger ATR -> wider stop/target); the old bleed stays calm.
    rets.push(i >= n - 40 ? r * vol : r);
  }
  const out = [];
  let price = p0;
  for (let i = 0; i < n; i++) {
    const o = price;
    const c = o * (1 + rets[i]);
    const wiggle = Math.abs(rets[i]) * 0.5 + 0.002;
    const h = Math.max(o, c) * (1 + wiggle * rnd());
    const l = Math.min(o, c) * (1 - wiggle * rnd());
    const v = 2000 + rnd() * 3000 + (i >= n - rallyLen ? 6000 : 0);
    out.push({ t: endT - (n - 1 - i) * TF_MS, o, h, l, c, v });
    price = c;
  }
  return out;
}

const CLEAN_EVM = {
  is_honeypot: '0', cannot_buy: '0', cannot_sell_all: '0', buy_tax: '0', sell_tax: '0', transfer_tax: '0',
  is_mintable: '0', is_proxy: '0', is_open_source: '1', is_blacklisted: '0', hidden_owner: '0',
  can_take_back_ownership: '0', owner_change_balance: '0', selfdestruct: '0', external_call: '0',
  slippage_modifiable: '0', personal_slippage_modifiable: '0', transfer_pausable: '0', trading_cooldown: '0',
  owner_address: '0x0000000000000000000000000000000000000000', creator_percent: '0.01', owner_percent: '0',
  holder_count: '8421', honeypot_with_same_creator: '0',
  holders: [
    { address: '0x1000000000000000000000000000000000000001', percent: '0.04', is_locked: 0 },
    { address: '0x1000000000000000000000000000000000000002', percent: '0.03', is_locked: 0 },
    { address: '0x1000000000000000000000000000000000000003', percent: '0.025', is_locked: 0 },
  ],
  lp_holders: [
    { address: '0x000000000000000000000000000000000000dead', percent: '0.95', is_locked: 1 },
    { address: '0x2000000000000000000000000000000000000001', percent: '0.05', is_locked: 0 },
  ],
};

const DEAD_LP = [{ address: '0x000000000000000000000000000000000000dead', percent: '0.95', is_locked: 1 }, { address: '0x2000000000000000000000000000000000000001', percent: '0.05', is_locked: 0 }];

/** Clean Solana report; LP lock filled as RugCheck would (GoPlus leaves it null on Solana). */
function cleanSolana(holders = '15320') {
  const s = parseSolanaSecurity({
    mintable: { status: '0', authority: [] }, freezable: { status: '0', authority: [] },
    balance_mutable_authority: { status: '0', authority: [] }, closable: { status: '0', authority: [] },
    metadata_mutable: { status: '0' }, transfer_fee: {}, transfer_hook: [], non_transferable: '0',
    default_account_state: '1', holder_count: holders,
    holders: [{ account: 'Ho1der1111111111111111111111111111111111111', percent: '0.05', is_locked: 0 }],
  });
  s.lpLockedPct = 100;
  s.sources.push('rugcheck');
  return s;
}

const cleanHp = (buyTax = 0, sellTax = 0) => parseHoneypotIs({
  honeypotResult: { isHoneypot: false }, simulationResult: { buyTax, sellTax }, summary: { risk: 'low', flags: [] },
});

const FIXTURES = [
  {
    address: 'MockGood11111111111111111111111111111111111',
    chain: 'solana', dexId: 'raydium', symbol: 'MOCKGOOD', name: 'Mock Good Token', quote: 'SOL',
    pairAddress: 'MockPair11111111111111111111111111111111111',
    p0: 0.0021, seed: 7, liquidityUsd: 850_000, fdv: 12_500_000, ageDays: 30, coingeckoId: 'mock-good',
    security: () => cleanSolana(),
    future: [0.06, 0.02, -0.01, 0.015], // cycle 2 -> take-profit
  },
  {
    address: '0x600d00000000000000000000000000000000600d',
    chain: 'base', dexId: 'aerodrome', symbol: 'MOCKBASE', name: 'Mock Base Token', quote: 'WETH',
    pairAddress: '0x7a1700000000000000000000000000000000a171',
    p0: 1.84, seed: 11, liquidityUsd: 420_000, fdv: 9_000_000, ageDays: 12, coingeckoId: 'mock-base',
    security: () => mergeHoneypotIs(parseEvmSecurity(CLEAN_EVM), cleanHp()),
    future: [-0.04, -0.01, 0.01, 0.005], // cycle 2 -> stop-loss
  },
  {
    address: '0xbad0000000000000000000000000000000000bad',
    chain: 'bsc', dexId: 'pancakeswap', symbol: 'MOCKPOT', name: 'Mock Honeypot', quote: 'WBNB',
    pairAddress: '0xbad1000000000000000000000000000000001bad',
    p0: 0.00042, seed: 23, liquidityUsd: 95_000, fdv: 400_000, ageDays: 0.5, coingeckoId: null,
    liquidityAt: (step, base) => (step >= 2 ? 300 : base), // the honeypot rug
    sellRoute: false,
    security: () => mergeHoneypotIs(parseEvmSecurity({
      ...CLEAN_EVM, is_honeypot: '1', cannot_sell_all: '1', sell_tax: '0.99', buy_tax: '0.05',
      is_mintable: '1', slippage_modifiable: '1', owner_address: '0x3000000000000000000000000000000000000003',
      owner_percent: '0.4', holder_count: '57',
      lp_holders: [{ address: '0x3000000000000000000000000000000000000003', percent: '1', is_locked: 0 }],
    }), parseHoneypotIs({
      honeypotResult: { isHoneypot: true }, simulationResult: { buyTax: 5, sellTax: 99 }, summary: { risk: 'honeypot', flags: [] },
    })),
    future: [0.05, 0.06, 0.04, 0.03],
  },
  {
    address: '0x7410000000000000000000000000000000007410',
    chain: 'base', dexId: 'uniswap', symbol: 'MOCKTHIN', name: 'Mock Thin Pool', quote: 'WETH',
    pairAddress: '0x7411000000000000000000000000000000007411',
    p0: 0.052, seed: 31, liquidityUsd: 24_000, fdv: 900_000, ageDays: 20, coingeckoId: null,
    security: () => mergeHoneypotIs(parseEvmSecurity({ ...CLEAN_EVM, buy_tax: '0.03', sell_tax: '0.03', lp_holders: DEAD_LP }), cleanHp(3, 3)),
    future: [0.01, 0.005, -0.005, 0.01],
  },
  {
    address: 'MockFake1111111111111111111111111111111111',
    label: 'MOCKFAKE',
    chain: 'solana', dexId: 'pumpswap', symbol: 'MOCKGOOD', name: 'Mock Good Token', quote: 'SOL',
    pairAddress: 'MockFakePair111111111111111111111111111111',
    p0: 0.0009, seed: 41, liquidityUsd: 40_000, fdv: 300_000, ageDays: 2 / 24, coingeckoId: null,
    security: () => cleanSolana('2310'),
    future: [0.02, 0.01, 0.0, 0.01],
  },
  {
    address: '0x5a60000000000000000000000000000000005a60',
    chain: 'base', dexId: 'aerodrome', symbol: 'MOCKRUG', name: 'Mock Slow Rug', quote: 'WETH',
    pairAddress: '0x5a61000000000000000000000000000000005a61',
    p0: 0.31, seed: 53, vol: 8, liquidityUsd: 180_000, fdv: 2_400_000, ageDays: 10, coingeckoId: null,
    liquidityAt: (step, base) => (step >= 2 ? base * 0.4 : base), // gradual drain
    // Sell tax 5% at entry; the dev raises it to 35% from step 1 (slippage_modifiable = tax can be changed).
    security: (step) => {
      const sell = step >= 1 ? '0.35' : '0.05';
      return mergeHoneypotIs(
        parseEvmSecurity({ ...CLEAN_EVM, sell_tax: sell, slippage_modifiable: '1', lp_holders: DEAD_LP }),
        cleanHp(0, Number(sell) * 100),
      );
    },
    future: [0.01, -0.02, -0.05, 0.0],
  },
];

export const MOCK_TOKENS = FIXTURES.map(({ address, chain, symbol, label }) => ({ address, chain, symbol, label: label ?? symbol }));

const DAY_MS = DAY;
const norm = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export class MockDataSource {
  constructor({ now = Date.now() } = {}) {
    const endT = Math.floor(now / TF_MS) * TF_MS;
    this.now = now;
    this.step = 0;
    /** @type {Map<string, {fx: any, candles: any[]}>} */
    this.tokens = new Map();
    for (const fx of FIXTURES) {
      this.tokens.set(fx.address.toLowerCase(), { fx, candles: buildMockCandles({ p0: fx.p0, seed: fx.seed, endT, vol: fx.vol ?? 1 }) });
    }
  }

  /** Move the mock market forward by one candle. */
  advance() {
    for (const { fx, candles } of this.tokens.values()) {
      const last = candles[candles.length - 1];
      const r = fx.future[this.step % fx.future.length];
      const c = last.c * (1 + r);
      candles.push({ t: last.t + TF_MS, o: last.c, h: Math.max(last.c, c) * 1.002, l: Math.min(last.c, c) * 0.998, c, v: 9000 });
    }
    this.step += 1;
    this.now += TF_MS;
  }

  async getMarket(address, chain = null) {
    const tok = this.tokens.get(String(address).toLowerCase());
    if (!tok || (chain && chain !== tok.fx.chain)) return null;
    const { fx, candles } = tok;
    const last = candles[candles.length - 1];
    const back = (k) => candles[Math.max(0, candles.length - 1 - k)].c;
    const chg = (k) => ((last.c - back(k)) / back(k)) * 100;
    const vol = (k) => candles.slice(-k).reduce((s, c) => s + c.v, 0);
    return {
      chain: fx.chain, dexId: fx.dexId, labels: [], pairAddress: fx.pairAddress,
      url: `https://dexscreener.com/${fx.chain}/${fx.pairAddress.toLowerCase()} (mock)`,
      token: { address: fx.address, name: fx.name, symbol: fx.symbol }, quote: { address: '', symbol: fx.quote },
      tokenIsBase: true, priceUsd: last.c, priceNative: null, liquidityUsd: this.liquidity(fx),
      fdv: fx.fdv, marketCap: fx.fdv * 0.8,
      volume: { m5: last.v, h1: vol(12), h6: vol(72), h24: vol(288) },
      priceChange: { m5: chg(1), h1: chg(12), h6: chg(72), h24: chg(288) },
      txns: { m5: { buys: 6, sells: 3 }, h1: { buys: 80, sells: 52 }, h6: { buys: 410, sells: 380 }, h24: { buys: 1500, sells: 1400 } },
      pairCreatedAt: this.now - fx.ageDays * DAY, pairAgeHours: fx.ageDays * 24,
    };
  }

  liquidity(fx) {
    return fx.liquidityAt ? fx.liquidityAt(this.step, fx.liquidityUsd) : fx.liquidityUsd;
  }

  async getSecurity(market, _opts = {}) {
    const tok = this.tokens.get(market.token.address.toLowerCase());
    return tok ? tok.fx.security(this.step) : null;
  }

  /** Round trip: the analyzer runs the pool-size estimate on fixture liquidity and taxes; this adds sellRoute. */
  async getRoundTrip(market, sizeUsd, _security, _opts = {}) {
    const tok = this.tokens.get(market.token.address.toLowerCase());
    if (!tok) return null;
    if (tok.fx.roundTrip) return { ...tok.fx.roundTrip };
    return { getBackUsd: null, lossPct: null, sellRoute: tok.fx.sellRoute ?? true, method: 'estimate (mock)', sizeUsd };
  }

  async getTokenInfo(chain, address) {
    const tok = this.tokens.get(String(address).toLowerCase());
    if (!tok || tok.fx.chain !== chain) return null;
    return { coingeckoId: tok.fx.coingeckoId ?? null, gtScore: null, developerAddress: null, symbol: tok.fx.symbol };
  }

  /** DexScreener-style search over the fixtures (symbol or name). */
  async searchPairs(q) {
    const nq = norm(q);
    const out = [];
    for (const { fx } of this.tokens.values()) {
      if (norm(fx.symbol) !== nq && norm(fx.name) !== nq) continue;
      out.push({
        chainId: fx.chain, pairAddress: fx.pairAddress, baseToken: { address: fx.address, symbol: fx.symbol, name: fx.name },
        liquidity: { usd: this.liquidity(fx) }, pairCreatedAt: this.now - fx.ageDays * DAY_MS,
      });
    }
    return out;
  }

  async getIdentity(market) {
    return resolveIdentity(this, market, { now: this.now });
  }

  /** Current markets for several tokens of one chain (tracker). @returns {Promise<Map<string, any>>} */
  async getMarketsBatch(chain, addresses) {
    this.batchCalls = (this.batchCalls ?? 0) + 1;
    const out = new Map();
    for (const a of addresses) {
      const m = await this.getMarket(a, chain);
      if (m) out.set(String(a).toLowerCase(), m);
    }
    return out;
  }

  async getOhlcv(market, _timeframe, limit) {
    const tok = this.tokens.get(market.token.address.toLowerCase());
    return tok ? tok.candles.slice(-limit).map((c) => ({ ...c })) : [];
  }
}
