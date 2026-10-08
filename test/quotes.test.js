// Quote client with an injected fetch: saved Jupiter / Kyber JSON and a no-route error. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { QuoteClient, isNoRoute } from '../src/data/quotes.js';

const fx = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const PEPE = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';

function stubFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, headers: init.headers });
    const r = routes(u, calls.length);
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

const client = (fetchImpl, now = () => 0, jupiterKey = '') => new QuoteClient({
  jupiterUrl: 'https://lite-api.jup.ag/swap/v1', jupiterKey, kyberUrl: 'https://aggregator-api.kyberswap.com', kyberClientId: 'tradebot',
  cacheSec: 60, fetchImpl, now,
});

test('Jupiter round trip: two quotes, no key header when JUPITER_API_KEY is empty, cached for 60 s', async () => {
  let t = 0;
  const { fetchImpl, calls } = stubFetch((u) => ({ body: u.searchParams.get('inputMint') === BONK ? fx('jupiter-bonk-usdc.json') : fx('jupiter-usdc-bonk.json') }));
  const q = client(fetchImpl, () => t);
  const r = await q.roundTrip({ chain: 'solana', token: BONK, sizeUsd: 100 });
  assert.equal(r.method, 'jupiter');
  assert.equal(r.sellRoute, true);
  assert.ok(Math.abs(r.getBackUsd - 99.844) < 1e-9);
  assert.ok(Math.abs(r.lossPct - 0.156) < 1e-9);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.searchParams.get('amount'), '100000000');
  assert.equal(calls[1].url.searchParams.get('amount'), '5263157894');
  assert.equal(calls[0].url.searchParams.get('slippageBps'), '50');
  assert.equal(calls[0].headers['x-api-key'], undefined);
  t = 30_000;
  await q.roundTrip({ chain: 'solana', token: BONK, sizeUsd: 100 });
  assert.equal(calls.length, 2, 'second analyze within 60 s makes no quote request');
  t = 61_000;
  await q.roundTrip({ chain: 'solana', token: BONK, sizeUsd: 100 });
  assert.equal(calls.length, 4);
});

test('Kyber round trip uses x-client-id, chain slug, amountOut of leg 1 and applies token taxes', async () => {
  const { fetchImpl, calls } = stubFetch((u) => ({ body: u.searchParams.get('tokenIn') === PEPE ? fx('kyber-route-back.json') : fx('kyber-route.json') }));
  const r = await client(fetchImpl).roundTrip({ chain: 'ethereum', token: PEPE, sizeUsd: 100, buyTaxPct: 1, sellTaxPct: 2 });
  assert.equal(r.method, 'kyber');
  assert.equal(calls[0].url.pathname, '/ethereum/api/v1/routes');
  assert.equal(calls[0].headers['x-client-id'], 'tradebot');
  assert.equal(calls[0].url.searchParams.get('amountIn'), '100000000');
  assert.equal(calls[1].url.searchParams.get('amountIn'), '9852216748768472906403940');
  assert.ok(Math.abs(r.getBackUsd - 99.41 * 0.99 * 0.98) < 1e-9);
});

test('no route on the sell leg -> sellRoute false; network error -> null (estimate fallback)', async () => {
  const { fetchImpl } = stubFetch((u) => (u.searchParams.get('inputMint') === BONK
    ? { status: 400, body: { error: 'Could not find any route', errorCode: 'COULD_NOT_FIND_ANY_ROUTE' } }
    : { body: fx('jupiter-usdc-bonk.json') }));
  const r = await client(fetchImpl).roundTrip({ chain: 'solana', token: BONK, sizeUsd: 100 });
  assert.deepEqual({ sellRoute: r.sellRoute, getBackUsd: r.getBackUsd }, { sellRoute: false, getBackUsd: 0 });

  const kyberNoRoute = stubFetch((u) => (u.searchParams.get('tokenIn') === PEPE ? { status: 400, body: { code: 4008, message: 'route not found' } } : { body: fx('kyber-route.json') }));
  assert.equal((await client(kyberNoRoute.fetchImpl).roundTrip({ chain: 'ethereum', token: PEPE, sizeUsd: 100 })).sellRoute, false);

  const down = async () => {
    throw new TypeError('fetch failed');
  };
  assert.equal(await client(down).roundTrip({ chain: 'solana', token: BONK, sizeUsd: 100 }), null);
  assert.equal(await client(down).roundTrip({ chain: 'linea', token: PEPE, sizeUsd: 100 }), null); // no kyber slug
  assert.equal(isNoRoute({ status: 500, body: 'route not found' }), false);
});

test('Jupiter sends x-api-key only when JUPITER_API_KEY is set', async () => {
  const { fetchImpl, calls } = stubFetch((u) => ({ body: u.searchParams.get('inputMint') === BONK ? fx('jupiter-bonk-usdc.json') : fx('jupiter-usdc-bonk.json') }));
  await client(fetchImpl, () => 0, 'k-123').roundTrip({ chain: 'solana', token: BONK, sizeUsd: 100 });
  assert.equal(calls[0].headers['x-api-key'], 'k-123');
});
