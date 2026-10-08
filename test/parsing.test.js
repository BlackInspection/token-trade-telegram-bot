import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeframeToGecko, parseOhlcv } from '../src/data/geckoterminal.js';
import { parseHoneypotIs } from '../src/data/honeypot.js';
import { detectAddressKind, extractAddress, normalizeChain, chainKind, isBurnAddress } from '../src/chains.js';
import { decodeBase58, decodeSolanaSecret } from '../src/executors/jupiter.js';
import { ConfigError, defaultConfig, loadConfig } from '../src/config.js';
import { fmtPrice, fmtUsd, chunkText } from '../src/format.js';

test('timeframeToGecko', () => {
  assert.deepEqual(timeframeToGecko('5m'), { timeframe: 'minute', aggregate: 5, ms: 300_000 });
  assert.deepEqual(timeframeToGecko('4h'), { timeframe: 'hour', aggregate: 4, ms: 14_400_000 });
  assert.equal(timeframeToGecko('1d').timeframe, 'day');
  assert.throws(() => timeframeToGecko('7m'), /Unsupported/);
  assert.throws(() => timeframeToGecko('abc'), /Invalid/);
});

test('parseOhlcv: newest-first API rows -> oldest-first candles in ms', () => {
  const json = { data: { attributes: { ohlcv_list: [[1793213100, 2, 3, 1, 2.5, 100], [1793212800, 1, 2, 0.5, 2, 50], [1793212800, 1, 2, 0.5, 2, 50]] } } };
  const c = parseOhlcv(json);
  assert.equal(c.length, 2);
  assert.equal(c[0].t, 1793212800_000);
  assert.deepEqual(c[1], { t: 1793213100_000, o: 2, h: 3, l: 1, c: 2.5, v: 100 });
  assert.deepEqual(parseOhlcv({}), []);
});

test('parseHoneypotIs', () => {
  const r = parseHoneypotIs({ honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 0, sellTax: 5 }, summary: { risk: 'low', flags: [] } });
  assert.deepEqual(r, { isHoneypot: false, buyTaxPct: 0, sellTaxPct: 5, risk: 'low', flags: [] });
  assert.equal(parseHoneypotIs({}).isHoneypot, null);
});

test('address detection and extraction', () => {
  assert.equal(detectAddressKind('0x6982508145454Ce325dDbE47a25d4ec3d2311933'), 'evm');
  assert.equal(detectAddressKind('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'), 'solana');
  assert.equal(detectAddressKind('hello'), null);
  assert.equal(extractAddress('look https://dexscreener.com/solana/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 pls'), 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
  assert.equal(extractAddress('buy 0x6982508145454Ce325dDbE47a25d4ec3d2311933 on eth'), '0x6982508145454Ce325dDbE47a25d4ec3d2311933');
  assert.equal(extractAddress('nothing here'), null);
  assert.equal(normalizeChain('ETH'), 'ethereum');
  assert.equal(normalizeChain('sol'), 'solana');
  assert.equal(chainKind('base'), 'evm');
  assert.equal(chainKind('unknownchain', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'), 'solana');
  assert.equal(isBurnAddress('0x000000000000000000000000000000000000dEaD'), true);
});

test('base58 + Solana secret decoding', () => {
  assert.equal(Buffer.from(decodeBase58('StV1DL6CwTryKyV')).toString(), 'hello world');
  assert.deepEqual([...decodeBase58('1112')], [0, 0, 0, 1]);
  assert.throws(() => decodeBase58('0OIl'), /base58/);
  const arr = Array.from({ length: 64 }, (_, i) => i);
  assert.deepEqual([...decodeSolanaSecret(JSON.stringify(arr))], arr);
  assert.throws(() => decodeSolanaSecret('[1,2,3]'), /64 bytes/);
});

test('config defaults and validation', () => {
  const c = defaultConfig();
  assert.equal(c.dryRun, true);
  assert.equal(c.mode, 'paper');
  assert.equal(c.analysis.timeframe, '5m');
  assert.deepEqual(c.adminIds, []);
  const c2 = loadConfig({ env: { ADMIN_IDS: '1, 2', DRY_RUN: 'false', EVM_RPC_URLS: 'base=https://b.example,Ethereum=https://e.example' } });
  assert.deepEqual(c2.adminIds, [1, 2]);
  assert.equal(c2.dryRun, false);
  assert.deepEqual(c2.live.evmRpcUrls, { base: 'https://b.example', ethereum: 'https://e.example' });
  assert.throws(() => loadConfig({ env: { ADMIN_IDS: 'abc' } }), ConfigError);
  assert.throws(() => loadConfig({ env: { DRY_RUN: 'maybe' } }), /DRY_RUN/);
  assert.throws(() => loadConfig({ env: { EMA_FAST: '30', EMA_SLOW: '20' } }), ConfigError);
  assert.throws(() => loadConfig({ env: { TRADING_MODE: 'yolo' } }), /TRADING_MODE/);
});

test('formatting helpers', () => {
  assert.equal(fmtPrice(0.000004866), '$0.000004866');
  assert.equal(fmtPrice(1.5), '$1.5000');
  assert.equal(fmtUsd(31_640_000), '$31.64M');
  assert.equal(fmtUsd(-3.2, { compact: false }), '-$3.20');
  const parts = chunkText('a\n'.repeat(3000), 1000);
  assert.ok(parts.every((p) => p.length <= 1000));
  assert.equal(parts.join('\n').replace(/\n+/g, '').length, 3000);
});
