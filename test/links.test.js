import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_HOSTS, buyLinks, caip19, phantomSwapLink, sellLinks, uniswapLink, LinkError } from '../src/links.js';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const PEPE = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

test('CAIP-19 for solana and eip155 chains', () => {
  assert.equal(caip19('solana', BONK), `solana:101/address:${BONK}`);
  assert.equal(caip19('ethereum', PEPE), `eip155:1/address:${PEPE}`);
  assert.equal(caip19('base', PEPE), `eip155:8453/address:${PEPE}`);
});

test('Phantom link decodes to solana:101/address:<mint>', () => {
  const u = new URL(phantomSwapLink({ chain: 'solana', buy: BONK, sell: USDC_SOL }));
  assert.equal(u.hostname, 'phantom.com');
  assert.equal(u.pathname, '/ul/v1/swap');
  assert.equal(u.searchParams.get('buy'), `solana:101/address:${BONK}`);
  assert.equal(u.searchParams.get('sell'), `solana:101/address:${USDC_SOL}`);
  assert.match(u.toString(), /buy=solana%3A101%2Faddress%3ADezX/);
});

test('every generated link is on the host allowlist', () => {
  for (const [chain, token] of [['solana', BONK], ['ethereum', PEPE], ['base', PEPE], ['bsc', PEPE], ['arbitrum', PEPE]]) {
    for (const l of [...buyLinks({ chain, token, usd: 50 }), ...sellLinks({ chain, token })]) {
      assert.ok(ALLOWED_HOSTS.has(new URL(l.url).hostname), l.url);
    }
  }
  assert.equal(buyLinks({ chain: 'solana', token: BONK })[1].label, 'Open in Jupiter');
  assert.equal(buyLinks({ chain: 'bsc', token: PEPE })[1].label, 'Open in PancakeSwap');
});

test('a malformed address throws; links are never built from free text', () => {
  assert.throws(() => caip19('solana', 'not-a-mint'), LinkError);
  assert.throws(() => caip19('ethereum', '0x123'), LinkError);
  assert.throws(() => caip19('ethereum', 'javascript:alert(1)'), LinkError);
  assert.throws(() => buyLinks({ chain: 'linea', token: PEPE }), /no USDC mapping/);
  assert.throws(() => caip19('nochain', PEPE), /unsupported chain/);
});

test('Uniswap value and field are set together', () => {
  const withValue = new URL(uniswapLink({ chain: 'ethereum', input: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', output: PEPE, valueUsd: 50 }));
  assert.equal(withValue.searchParams.get('value'), '50.00');
  assert.equal(withValue.searchParams.get('field'), 'input');
  assert.equal(withValue.searchParams.get('chain'), 'mainnet');
  const without = new URL(uniswapLink({ chain: 'base', input: PEPE, output: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }));
  assert.equal(without.searchParams.get('value'), null);
  assert.equal(without.searchParams.get('field'), null);
});
