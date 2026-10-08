// Configuration: .env -> validated, structured config object.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const empty = (v) => v === undefined || v === null || String(v).trim() === '';
const str = (def = '') => z.preprocess((v) => (empty(v) ? def : String(v).trim()), z.string());
const num = (def) => z.preprocess((v) => (empty(v) ? def : Number(v)), z.number().finite());
const int = (def) => z.preprocess((v) => (empty(v) ? def : Number(v)), z.number().int());
const bool = (def) =>
  z.preprocess((v) => {
    if (empty(v)) return def;
    if (typeof v === 'boolean') return v;
    const s = String(v).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(s)) return true;
    if (['0', 'false', 'no', 'off'].includes(s)) return false;
    return v;
  }, z.boolean());
const list = () =>
  z.preprocess(
    (v) => (empty(v) ? [] : String(v).split(',').map((s) => s.trim()).filter(Boolean)),
    z.array(z.string()),
  );

const EnvSchema = z.object({
  // --- core ---
  BOT_TOKEN: str(),
  ADMIN_IDS: list(),
  DRY_RUN: bool(true),
  // 'practice' is the user-facing name of paper mode (shared contract); stored internally as 'paper'.
  TRADING_MODE: z.preprocess((v) => {
    if (empty(v)) return 'paper';
    const s = String(v).trim().toLowerCase();
    return s === 'practice' ? 'paper' : s;
  }, z.enum(['paper', 'link', 'live'])),
  DB_PATH: str('data/tradebot.db'),
  LOG_LEVEL: z.preprocess((v) => (empty(v) ? 'info' : String(v).trim().toLowerCase()), z.enum(['debug', 'info', 'warn', 'error'])),
  WATCHLIST: list(),
  STRATEGY: str('ema_cross_rsi'),

  // --- data sources ---
  DEXSCREENER_URL: str('https://api.dexscreener.com'),
  GOPLUS_URL: str('https://api.gopluslabs.io'),
  GOPLUS_ACCESS_TOKEN: str(),
  GECKOTERMINAL_URL: str('https://api.geckoterminal.com/api/v2'),
  HONEYPOT_IS_URL: str('https://api.honeypot.is'),
  USE_HONEYPOT_IS: bool(true),
  HTTP_TIMEOUT_MS: int(15000),
  SECURITY_CACHE_SEC: int(900),

  // --- analysis / strategy ---
  TIMEFRAME: str('5m'),
  OHLCV_LIMIT: int(300),
  EMA_FAST: int(9),
  EMA_SLOW: int(21),
  RSI_PERIOD: int(14),
  RSI_MIN_ENTRY: num(45),
  RSI_OVERBOUGHT: num(70),
  RSI_EXIT: num(80),
  MACD_FAST: int(12),
  MACD_SLOW: int(26),
  MACD_SIGNAL: int(9),
  ATR_PERIOD: int(14),
  VOL_LOOKBACK: int(20),
  VOL_SPIKE_MULT: num(2),
  CROSS_LOOKBACK: int(3),
  MAX_BUY_TAX_PCT: num(10),
  MAX_SELL_TAX_PCT: num(10),
  MIN_LIQUIDITY_USD: num(20000),
  MAX_BUY_RISK: num(40),
  AVOID_RISK: num(70),
  ATR_SL_MULT: num(2),
  MIN_SL_PCT: num(2),
  MAX_SL_PCT: num(25),
  DEFAULT_SL_PCT: num(10),
  TP_RR: num(2),

  // --- trading / risk ---
  PAPER_START_EQUITY: num(1000),
  POSITION_SIZE_USD: num(50),
  POSITION_SIZE_PCT: num(0),
  MAX_TRADE_USD: num(200),
  MAX_OPEN_POSITIONS: int(3),
  DAILY_LOSS_LIMIT_USD: num(100),
  MAX_TRADES_PER_HOUR: int(10),
  SLIPPAGE_BPS: int(100),
  FEE_BPS: int(30),
  TRAILING_STOP_PCT: num(10),
  WATCH_INTERVAL_SEC: int(60),

  // --- live: Solana / Jupiter ---
  SOLANA_RPC_URL: str('https://api.mainnet-beta.solana.com'),
  SOLANA_PRIVATE_KEY: str(),
  JUPITER_API_URL: str('https://lite-api.jup.ag/swap/v1'),
  JUPITER_API_KEY: str(),
  SOLANA_QUOTE_MINT: str('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  SOLANA_QUOTE_DECIMALS: int(6),

  // --- live: EVM / 0x ---
  EVM_PRIVATE_KEY: str(),
  EVM_RPC_URLS: list(),
  ZEROX_API_URL: str('https://api.0x.org'),
  ZEROX_API_KEY: str(),

  DRY_RUN_QUOTES: bool(true),

  // --- Exit Test: round-trip costs, quotes, cost gate ---
  USE_QUOTES: bool(true),
  KYBER_API_URL: str('https://aggregator-api.kyberswap.com'),
  KYBER_CLIENT_ID: str('tradebot'),
  QUOTE_CACHE_SEC: int(60),
  DEX_FEE_BPS: int(30),
  MAX_ROUNDTRIP_PCT: num(15),
  SAFE_ROUNDTRIP_PCT: num(3),
  COST_GATE_MULT: num(3),
  ROUND_TRIP_WARN_PCT: num(5),
  BUY_CONFIRM: bool(true),
  MIN_NET_PROFIT_USD: num(0),
  MIN_NET_PROFIT_PCT: num(0),
  GAS_USD_SOL: num(0.01),
  GAS_USD_ETH: num(2),
  GAS_USD_BSC: num(0.1),
  GAS_USD_BASE: num(0.02),
  GAS_USD_OTHER: num(0.05),
  DAILY_BUDGET_USD: num(500),

  // --- verdict card / identity ---
  LIGHT_GREEN_MAX: num(20),
  USE_RUGCHECK: bool(true),
  RUGCHECK_URL: str('https://api.rugcheck.xyz'),
  JUPITER_TOKENS_URL: str('https://lite-api.jup.ag/tokens/v2'),
  IDENTITY_CACHE_SEC: int(86400),
  UI_BUTTON_COLORS: bool(true),
  PRACTICE_BUY_USD: num(25),

  // --- position guardian ---
  GUARDIAN_ENABLED: bool(true),
  GUARDIAN_SECURITY_SEC: int(300),
  GUARDIAN_TAX_UP_PTS: num(5),
  GUARDIAN_LIQ_DROP_PCT: num(30),
  GUARDIAN_LIQ_DROP_ENTRY_PCT: num(50),
  GUARDIAN_LP_LOCK_DROP_PTS: num(20),
  GUARDIAN_TOP10_UP_PTS: num(10),
  GUARDIAN_TIGHTEN_PCT: num(5),
  GUARDIAN_LIVE_EXIT: bool(false),
  GUARDIAN_ALERT_COOLDOWN_MIN: num(30),

  // --- track record ---
  TRACK_ENABLED: bool(true),
  TRACK_HORIZONS: z.preprocess(
    (v) => (empty(v) ? ['1h', '24h', '7d'] : String(v).split(',').map((s) => s.trim()).filter(Boolean)),
    z.array(z.string().regex(/^\d+(m|h|d)$/, 'horizons look like 1h,24h,7d')),
  ),
  TRACK_INTERVAL_SEC: int(900),
  OBS_DEDUPE_MIN: num(60),
  TRACK_RUG_LIQ_USD: num(1000),
  TRACK_MIN_N: int(20),
  TRACK_TP_CHECK: bool(true),
  TRACK_MAX_OHLCV_PER_RUN: int(10),

  // --- safe ladder: practice -> sign it yourself -> autopilot ---
  SAMPLE_TOKENS: z.preprocess(
    (v) => (empty(v)
      ? ['solana:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'ethereum:0x6982508145454Ce325dDbE47a25d4ec3d2311933']
      : String(v).split(',').map((s) => s.trim()).filter(Boolean)),
    z.array(z.string()),
  ),
  LOSS_BUDGET_MONTH_USD: num(0),
  LOSS_STREAK_PAUSE: int(3),
  LOSS_STREAK_COOLDOWN_MIN: num(120),
  REVENGE_BLOCK_MIN: num(60),
  LOOSEN_DELAY_HOURS: num(24),
  GRADUATION_MIN_PAPER_TRADES: int(10),
  GRADUATION_PHRASE: str('I can lose this money'),

  // --- explained decisions: events, digest, optional LLM ---
  EVENTS_FILE: str('data/events.jsonl'),
  EVENTS_MAX_MB: num(20),
  DIGEST_AT: z.preprocess((v) => (empty(v) ? '21:00' : String(v).trim()), z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'expected HH:MM')),
  DIGEST_TZ: str('UTC'),
  PEER_EVENT_FILES: list(),
  ANTHROPIC_API_KEY: str(),
  ANTHROPIC_MODEL: str('claude-sonnet-5-5'),

  // --- shadow-first rules + safety envelope ---
  SHADOW_NEW_RULES: bool(true),
  SHADOW_MIN_HOURS: num(24),
  SHADOW_MIN_MATCHES: int(5),
  SHADOW_MAX_HOURS: num(168),
  AUTO_PAUSE_ERRORS: int(5),
  AUTO_PAUSE_BALANCE_DROP_PCT: num(30),
  STALE_DATA_SEC: num(300),
  HOT_WALLET_WARN_X: num(3),
  CONFIRM_ABOVE: z.preprocess((v) => (empty(v) ? null : Number(v)), z.number().finite().nullable()),

  // --- money display ---
  DISPLAY_CURRENCY: z.preprocess((v) => (empty(v) ? 'usd' : String(v).trim().toLowerCase()), z.enum(['usd', 'rub', 'eur', 'none'])),
  FX_CACHE_SEC: int(300),
});

/** "chain:address" items -> [{chain, address}] (validated loosely; addresses are re-validated where used). */
function parseSampleTokens(items) {
  return items.map((item) => {
    const i = item.indexOf(':');
    if (i <= 0) throw new ConfigError(`SAMPLE_TOKENS: expected "chain:address" items, got "${item}"`);
    return { chain: item.slice(0, i).trim().toLowerCase(), address: item.slice(i + 1).trim() };
  });
}

/** "1h" -> 3600000 */
export function horizonMs(h) {
  const m = /^(\d+)(m|h|d)$/.exec(String(h));
  if (!m) throw new ConfigError(`bad horizon "${h}"`);
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
}

/** Parse "ethereum=https://...,base=https://..." into an object. */
function parseRpcMap(items) {
  const out = {};
  for (const item of items) {
    const i = item.indexOf('=');
    if (i <= 0) throw new ConfigError(`EVM_RPC_URLS: expected "chain=url" items, got "${item}"`);
    out[item.slice(0, i).trim().toLowerCase()] = item.slice(i + 1).trim();
  }
  return out;
}

/**
 * Load config from process.env (+ .env in project root).
 * @param {{env?: Record<string,string|undefined>, dotenvPath?: string|null}} [opts]
 */
export function loadConfig({ env, dotenvPath } = {}) {
  let source = env;
  if (!source) {
    const p = dotenvPath === undefined ? path.join(ROOT, '.env') : dotenvPath;
    if (p && fs.existsSync(p)) dotenv.config({ path: p, quiet: true });
    source = process.env;
  }
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(`invalid value for ${issue.path.join('.')} in .env: ${issue.message}`);
  }
  const e = parsed.data;

  const adminIds = e.ADMIN_IDS.map((s) => Number(s));
  if (adminIds.some((n) => !Number.isSafeInteger(n))) {
    throw new ConfigError('ADMIN_IDS must be a comma-separated list of numeric Telegram user ids');
  }
  if (e.EMA_FAST >= e.EMA_SLOW) throw new ConfigError('EMA_FAST must be smaller than EMA_SLOW');

  const dbPath = e.DB_PATH === ':memory:' || path.isAbsolute(e.DB_PATH) ? e.DB_PATH : path.join(ROOT, e.DB_PATH);
  const eventsFile = path.isAbsolute(e.EVENTS_FILE) ? e.EVENTS_FILE : path.join(ROOT, e.EVENTS_FILE);
  for (const h of e.TRACK_HORIZONS) horizonMs(h);

  return {
    botToken: e.BOT_TOKEN,
    adminIds,
    dryRun: e.DRY_RUN,
    mode: e.TRADING_MODE,
    dbPath,
    logLevel: e.LOG_LEVEL,
    watchlistSeed: e.WATCHLIST,
    strategy: e.STRATEGY,
    api: {
      dexscreener: e.DEXSCREENER_URL.replace(/\/$/, ''),
      goplus: e.GOPLUS_URL.replace(/\/$/, ''),
      goplusToken: e.GOPLUS_ACCESS_TOKEN,
      geckoterminal: e.GECKOTERMINAL_URL.replace(/\/$/, ''),
      honeypotIs: e.HONEYPOT_IS_URL.replace(/\/$/, ''),
      useHoneypotIs: e.USE_HONEYPOT_IS,
      timeoutMs: e.HTTP_TIMEOUT_MS,
      securityCacheSec: e.SECURITY_CACHE_SEC,
      useQuotes: e.USE_QUOTES,
      kyber: e.KYBER_API_URL.replace(/\/$/, ''),
      kyberClientId: e.KYBER_CLIENT_ID,
      quoteCacheSec: e.QUOTE_CACHE_SEC,
      useRugcheck: e.USE_RUGCHECK,
      rugcheck: e.RUGCHECK_URL.replace(/\/$/, ''),
      jupiterTokens: e.JUPITER_TOKENS_URL.replace(/\/$/, ''),
      identityCacheSec: e.IDENTITY_CACHE_SEC,
    },
    analysis: {
      timeframe: e.TIMEFRAME,
      ohlcvLimit: e.OHLCV_LIMIT,
      emaFast: e.EMA_FAST,
      emaSlow: e.EMA_SLOW,
      rsiPeriod: e.RSI_PERIOD,
      rsiMinEntry: e.RSI_MIN_ENTRY,
      rsiOverbought: e.RSI_OVERBOUGHT,
      rsiExit: e.RSI_EXIT,
      macdFast: e.MACD_FAST,
      macdSlow: e.MACD_SLOW,
      macdSignal: e.MACD_SIGNAL,
      atrPeriod: e.ATR_PERIOD,
      volLookback: e.VOL_LOOKBACK,
      volSpikeMult: e.VOL_SPIKE_MULT,
      crossLookback: e.CROSS_LOOKBACK,
      maxBuyTaxPct: e.MAX_BUY_TAX_PCT,
      maxSellTaxPct: e.MAX_SELL_TAX_PCT,
      minLiquidityUsd: e.MIN_LIQUIDITY_USD,
      maxBuyRisk: e.MAX_BUY_RISK,
      avoidRisk: e.AVOID_RISK,
      atrSlMult: e.ATR_SL_MULT,
      minSlPct: e.MIN_SL_PCT,
      maxSlPct: e.MAX_SL_PCT,
      defaultSlPct: e.DEFAULT_SL_PCT,
      tpRr: e.TP_RR,
      // round-trip costs (Exit Test)
      dexFeeBps: e.DEX_FEE_BPS,
      maxRoundtripPct: e.MAX_ROUNDTRIP_PCT,
      safeRoundtripPct: e.SAFE_ROUNDTRIP_PCT,
      costGateMult: e.COST_GATE_MULT,
      roundTripWarnPct: e.ROUND_TRIP_WARN_PCT,
      minNetProfitUsd: e.MIN_NET_PROFIT_USD,
      minNetProfitPct: e.MIN_NET_PROFIT_PCT,
      // TODO(verify): gas per swap in USD is a rough default; real gas varies by chain load.
      gasUsd: { solana: e.GAS_USD_SOL, ethereum: e.GAS_USD_ETH, bsc: e.GAS_USD_BSC, base: e.GAS_USD_BASE, other: e.GAS_USD_OTHER },
      lightGreenMax: e.LIGHT_GREEN_MAX,
      sizeUsd: e.POSITION_SIZE_USD,
    },
    trading: {
      startEquity: e.PAPER_START_EQUITY,
      sizeUsd: e.POSITION_SIZE_USD,
      sizePct: e.POSITION_SIZE_PCT,
      maxTradeUsd: e.MAX_TRADE_USD,
      maxOpenPositions: e.MAX_OPEN_POSITIONS,
      dailyLossLimitUsd: e.DAILY_LOSS_LIMIT_USD,
      maxTradesPerHour: e.MAX_TRADES_PER_HOUR,
      slippageBps: e.SLIPPAGE_BPS,
      feeBps: e.FEE_BPS,
      trailingPct: e.TRAILING_STOP_PCT,
      watchIntervalSec: e.WATCH_INTERVAL_SEC,
      dailyBudgetUsd: e.DAILY_BUDGET_USD,
      // Buys above this always need a manual confirmation, even for live rules. Default: half of MAX_TRADE_USD.
      confirmAboveUsd: e.CONFIRM_ABOVE ?? e.MAX_TRADE_USD * 0.5,
    },
    ui: {
      buyConfirm: e.BUY_CONFIRM,
      buttonColors: e.UI_BUTTON_COLORS,
      practiceBuyUsd: e.PRACTICE_BUY_USD,
      displayCurrency: e.DISPLAY_CURRENCY,
      fxCacheSec: e.FX_CACHE_SEC,
    },
    guardian: {
      enabled: e.GUARDIAN_ENABLED,
      securitySec: e.GUARDIAN_SECURITY_SEC,
      taxUpPts: e.GUARDIAN_TAX_UP_PTS,
      liqDropPct: e.GUARDIAN_LIQ_DROP_PCT,
      liqDropEntryPct: e.GUARDIAN_LIQ_DROP_ENTRY_PCT,
      lpLockDropPts: e.GUARDIAN_LP_LOCK_DROP_PTS,
      top10UpPts: e.GUARDIAN_TOP10_UP_PTS,
      tightenPct: e.GUARDIAN_TIGHTEN_PCT,
      liveExit: e.GUARDIAN_LIVE_EXIT,
      alertCooldownMin: e.GUARDIAN_ALERT_COOLDOWN_MIN,
      maxSellTaxPct: e.MAX_SELL_TAX_PCT,
    },
    track: {
      enabled: e.TRACK_ENABLED,
      horizons: e.TRACK_HORIZONS,
      intervalSec: e.TRACK_INTERVAL_SEC,
      dedupeMin: e.OBS_DEDUPE_MIN,
      rugLiqUsd: e.TRACK_RUG_LIQ_USD,
      minN: e.TRACK_MIN_N,
      tpCheck: e.TRACK_TP_CHECK,
      maxOhlcvPerRun: e.TRACK_MAX_OHLCV_PER_RUN,
    },
    seatbelts: {
      lossBudgetMonthUsd: e.LOSS_BUDGET_MONTH_USD,
      lossStreakPause: e.LOSS_STREAK_PAUSE,
      lossStreakCooldownMin: e.LOSS_STREAK_COOLDOWN_MIN,
      revengeBlockMin: e.REVENGE_BLOCK_MIN,
      loosenDelayHours: e.LOOSEN_DELAY_HOURS,
    },
    graduation: { minPaperTrades: e.GRADUATION_MIN_PAPER_TRADES, phrase: e.GRADUATION_PHRASE },
    sampleTokens: parseSampleTokens(e.SAMPLE_TOKENS),
    events: {
      file: eventsFile,
      maxMb: e.EVENTS_MAX_MB,
      digestAt: e.DIGEST_AT,
      digestTz: e.DIGEST_TZ,
      peerFiles: e.PEER_EVENT_FILES,
    },
    llm: { apiKey: e.ANTHROPIC_API_KEY, model: e.ANTHROPIC_MODEL },
    shadow: { newRules: e.SHADOW_NEW_RULES, minHours: e.SHADOW_MIN_HOURS, minMatches: e.SHADOW_MIN_MATCHES, maxHours: e.SHADOW_MAX_HOURS },
    safety: {
      autoPauseErrors: e.AUTO_PAUSE_ERRORS,
      autoPauseBalanceDropPct: e.AUTO_PAUSE_BALANCE_DROP_PCT,
      staleDataSec: e.STALE_DATA_SEC,
      hotWalletWarnX: e.HOT_WALLET_WARN_X,
    },
    live: {
      solanaRpcUrl: e.SOLANA_RPC_URL,
      solanaPrivateKey: e.SOLANA_PRIVATE_KEY,
      jupiterApiUrl: e.JUPITER_API_URL.replace(/\/$/, ''),
      jupiterApiKey: e.JUPITER_API_KEY,
      solanaQuoteMint: e.SOLANA_QUOTE_MINT,
      solanaQuoteDecimals: e.SOLANA_QUOTE_DECIMALS,
      evmPrivateKey: e.EVM_PRIVATE_KEY,
      evmRpcUrls: parseRpcMap(e.EVM_RPC_URLS),
      zeroxApiUrl: e.ZEROX_API_URL.replace(/\/$/, ''),
      zeroxApiKey: e.ZEROX_API_KEY,
      dryRunQuotes: e.DRY_RUN_QUOTES,
    },
  };
}

/** Defaults only (no .env, no process.env) - handy for tests. */
export function defaultConfig(overrides = {}) {
  return loadConfig({ env: overrides });
}

/** Throw a ConfigError naming the first missing key. */
export function requireKeys(pairs) {
  for (const [key, value] of pairs) {
    if (empty(value)) throw new ConfigError(`${key} is not set in .env (required for this action)`);
  }
}

/** Runtime-tunable settings exposed via /settings <key> <value>. Maps key -> [group, field]. */
export const TUNABLE = {
  cost_gate_mult: ['analysis', 'costGateMult'],
  safe_roundtrip_pct: ['analysis', 'safeRoundtripPct'],
  max_roundtrip_pct: ['analysis', 'maxRoundtripPct'],
  guardian_live_exit: ['guardian', 'liveExit'],
  guardian_tighten_pct: ['guardian', 'tightenPct'],
  loss_budget: ['seatbelts', 'lossBudgetMonthUsd'],
  streak_pause: ['seatbelts', 'lossStreakPause'],
  cooldown_min: ['seatbelts', 'lossStreakCooldownMin'],
  revenge_min: ['seatbelts', 'revengeBlockMin'],
  daily_budget: ['trading', 'dailyBudgetUsd'],
  max_trades_h: ['trading', 'maxTradesPerHour'],
  size_usd: ['trading', 'sizeUsd'],
  size_pct: ['trading', 'sizePct'],
  max_trade_usd: ['trading', 'maxTradeUsd'],
  max_open: ['trading', 'maxOpenPositions'],
  daily_loss: ['trading', 'dailyLossLimitUsd'],
  trailing_pct: ['trading', 'trailingPct'],
  slippage_bps: ['trading', 'slippageBps'],
  interval_sec: ['trading', 'watchIntervalSec'],
  max_buy_risk: ['analysis', 'maxBuyRisk'],
  sl_mult: ['analysis', 'atrSlMult'],
  tp_rr: ['analysis', 'tpRr'],
  timeframe: ['analysis', 'timeframe'],
};

/** Boolean tunables (parsed from on/off/true/false). */
export const TUNABLE_BOOL = new Set(['guardian_live_exit']);

/** Seatbelt tunables live in kv 'seatbelts' (the /start tour writes the loss budget there). */
export const SEATBELT_KEYS = new Set(['loss_budget', 'streak_pause', 'cooldown_min', 'revenge_min']);

/**
 * Direction in which a tunable becomes LOOSER (riskier). Loosening is delayed by LOOSEN_DELAY_HOURS,
 * tightening applies at once. 'up' = a bigger value is looser; zeroMeansOff = 0 disables the limit (loosest).
 */
export const LOOSEN_DIRECTION = {
  loss_budget: { dir: 'up', zeroMeansOff: true },
  streak_pause: { dir: 'up', zeroMeansOff: true },
  cooldown_min: { dir: 'down' },
  revenge_min: { dir: 'down' },
  max_trade_usd: { dir: 'up' },
  daily_budget: { dir: 'up', zeroMeansOff: true },
  daily_loss: { dir: 'up', zeroMeansOff: true },
  max_trades_h: { dir: 'up' },
  max_open: { dir: 'up' },
  max_buy_risk: { dir: 'up' },
  max_roundtrip_pct: { dir: 'up' },
  cost_gate_mult: { dir: 'down' },
  // A wider stop or a higher target makes the cost gate (target >= COST_GATE_MULT x round trip) easier to pass.
  sl_mult: { dir: 'up' },
  tp_rr: { dir: 'up' },
  // More slippage tolerance means worse possible fills on every real swap.
  slippage_bps: { dir: 'up' },
};
