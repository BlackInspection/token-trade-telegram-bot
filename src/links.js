// "Sign it yourself" swap links. Pure URL builders; the bot never sees a private key in link mode.
// Only allowlisted hosts; addresses must pass chains.js validation (never built from free text).
import { chainInfo, isEvmAddress, isSolanaAddress, SOLANA_USDC } from './chains.js';

export const ALLOWED_HOSTS = new Set(['phantom.com', 'jup.ag', 'app.uniswap.org', 'pancakeswap.finance']);

export class LinkError extends Error {}

function assertAddress(chain, address) {
  const info = chainInfo(chain);
  if (!info) throw new LinkError(`unsupported chain "${chain}"`);
  const ok = info.kind === 'solana' ? isSolanaAddress(address) : isEvmAddress(address);
  if (!ok) throw new LinkError(`malformed ${info.kind} address "${String(address).slice(0, 60)}"`);
  return info;
}

/** CAIP-19 asset id as Phantom expects it: solana:101/address:<mint> or eip155:<chainId>/address:<0x>. */
export function caip19(chain, address) {
  const info = assertAddress(chain, address);
  return info.kind === 'solana' ? `solana:101/address:${address}` : `eip155:${info.chainId}/address:${address}`;
}

export function assertAllowed(url) {
  const host = new URL(url).hostname;
  if (!ALLOWED_HOSTS.has(host)) throw new LinkError(`host ${host} is not on the link allowlist`);
  return url;
}

const build = (base, params) => {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  return assertAllowed(u.toString());
};

function usdcFor(chain) {
  const info = chainInfo(chain);
  if (info?.kind === 'solana') return SOLANA_USDC.address;
  if (!info?.usdc) throw new LinkError(`no USDC mapping for chain "${chain}"`);
  return info.usdc.address;
}

/** Phantom universal link (checked in Phantom docs 2026-10-28: no session needed; no amount parameter documented). */
export function phantomSwapLink({ chain, buy, sell }) {
  return build('https://phantom.com/ul/v1/swap', { buy: caip19(chain, buy), sell: caip19(chain, sell) });
}

/** Jupiter: returns HTTP 200. TODO(verify): whether ?sell=&buy= pre-fills the swap form. */
export function jupiterLink({ sell, buy }) {
  assertAddress('solana', sell);
  assertAddress('solana', buy);
  return build('https://jup.ag/swap', { sell, buy });
}

/**
 * Uniswap: inputCurrency, outputCurrency, value and field are documented; value and field must be set together.
 * TODO(verify): the ?chain= parameter is undocumented.
 */
export function uniswapLink({ chain, input, output, valueUsd = null }) {
  const info = assertAddress(chain, input);
  assertAddress(chain, output);
  const params = { chain: info.uniswap ?? chain, inputCurrency: input, outputCurrency: output };
  if (valueUsd !== null && valueUsd !== undefined) Object.assign(params, { value: Number(valueUsd).toFixed(2), field: 'input' });
  return build('https://app.uniswap.org/swap', params);
}

/** PancakeSwap (BSC). TODO(verify): parameter names of the PancakeSwap swap URL. */
export function pancakeLink({ input, output }) {
  assertAddress('bsc', input);
  assertAddress('bsc', output);
  return build('https://pancakeswap.finance/swap', { chain: 'bsc', inputCurrency: input, outputCurrency: output });
}

/** Links to BUY `token` with USDC. @returns {{label: string, url: string}[]} */
export function buyLinks({ chain, token, usd = null }) {
  const usdc = usdcFor(chain);
  const out = [{ label: 'Open in Phantom', url: phantomSwapLink({ chain, buy: token, sell: usdc }) }];
  const kind = chainInfo(chain).kind;
  if (kind === 'solana') out.push({ label: 'Open in Jupiter', url: jupiterLink({ sell: usdc, buy: token }) });
  else if (chain === 'bsc') out.push({ label: 'Open in PancakeSwap', url: pancakeLink({ input: usdc, output: token }) });
  else out.push({ label: 'Open in Uniswap', url: uniswapLink({ chain, input: usdc, output: token, valueUsd: usd }) });
  return out;
}

/** Links to SELL `token` back to USDC. */
export function sellLinks({ chain, token }) {
  const usdc = usdcFor(chain);
  const out = [{ label: 'Open in Phantom', url: phantomSwapLink({ chain, buy: usdc, sell: token }) }];
  const kind = chainInfo(chain).kind;
  if (kind === 'solana') out.push({ label: 'Open in Jupiter', url: jupiterLink({ sell: token, buy: usdc }) });
  else if (chain === 'bsc') out.push({ label: 'Open in PancakeSwap', url: pancakeLink({ input: token, output: usdc }) });
  else out.push({ label: 'Open in Uniswap', url: uniswapLink({ chain, input: token, output: usdc }) });
  return out;
}
