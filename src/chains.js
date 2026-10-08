// Chain registry: DexScreener chainId -> ids used by GoPlus / GeckoTerminal / 0x / honeypot.is.

/**
 * @typedef {{kind: 'evm'|'solana', chainId?: number, goplus: string|null, gecko: string,
 *   honeypotIs?: boolean, zerox?: boolean, kyber?: string, uniswap?: string,
 *   usdc?: {address: string, decimals: number}|null}} ChainInfo
 *   kyber: KyberSwap aggregator chain slug (round-trip quotes); uniswap: app.uniswap.org ?chain= name.
 */

/** USDC mint on Solana (quote currency for buys, links and round-trip quotes). */
export const SOLANA_USDC = { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };

/** @type {Record<string, ChainInfo>} */
export const CHAINS = {
  solana: { kind: 'solana', goplus: 'solana', gecko: 'solana' },
  ethereum: {
    kyber: 'ethereum', uniswap: 'mainnet',
    kind: 'evm', chainId: 1, goplus: '1', gecko: 'eth', honeypotIs: true, zerox: true,
    usdc: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  },
  bsc: {
    kyber: 'bsc',
    kind: 'evm', chainId: 56, goplus: '56', gecko: 'bsc', honeypotIs: true, zerox: true,
    // Binance-Peg USDC has 18 decimals on BSC.
    usdc: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
  },
  base: {
    kyber: 'base', uniswap: 'base',
    kind: 'evm', chainId: 8453, goplus: '8453', gecko: 'base', honeypotIs: true, zerox: true,
    usdc: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  },
  arbitrum: {
    kyber: 'arbitrum', uniswap: 'arbitrum',
    kind: 'evm', chainId: 42161, goplus: '42161', gecko: 'arbitrum', zerox: true,
    usdc: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
  },
  polygon: {
    kyber: 'polygon', uniswap: 'polygon',
    kind: 'evm', chainId: 137, goplus: '137', gecko: 'polygon_pos', zerox: true,
    usdc: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
  },
  avalanche: {
    kyber: 'avalanche', uniswap: 'avalanche',
    kind: 'evm', chainId: 43114, goplus: '43114', gecko: 'avax', zerox: true,
    usdc: { address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6 },
  },
  optimism: {
    kyber: 'optimism', uniswap: 'optimism',
    kind: 'evm', chainId: 10, goplus: '10', gecko: 'optimism', zerox: true,
    usdc: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
  },
  // Analysis-only chains (no USDC mapping -> live EVM executor refuses).
  // TODO(verify): GoPlus chain ids / GeckoTerminal network ids for these.
  linea: { kind: 'evm', chainId: 59144, goplus: '59144', gecko: 'linea', usdc: null },
  blast: { kind: 'evm', chainId: 81457, goplus: '81457', gecko: 'blast', usdc: null },
  scroll: { kind: 'evm', chainId: 534352, goplus: '534352', gecko: 'scroll', usdc: null },
  mantle: { kind: 'evm', chainId: 5000, goplus: '5000', gecko: 'mantle', usdc: null },
  fantom: { kind: 'evm', chainId: 250, goplus: '250', gecko: 'ftm', usdc: null },
  zksync: { kind: 'evm', chainId: 324, goplus: '324', gecko: 'zksync', usdc: null },
  cronos: { kind: 'evm', chainId: 25, goplus: '25', gecko: 'cro', usdc: null },
  sonic: { kind: 'evm', chainId: 146, goplus: '146', gecko: 'sonic', usdc: null },
  pulsechain: { kind: 'evm', chainId: 369, goplus: null, gecko: 'pulsechain', usdc: null },
};

export const CHAIN_ALIASES = {
  eth: 'ethereum', mainnet: 'ethereum', sol: 'solana', bnb: 'bsc', binance: 'bsc', arb: 'arbitrum',
  matic: 'polygon', pol: 'polygon', avax: 'avalanche', op: 'optimism', ftm: 'fantom',
};

/** Normalise a user-supplied chain name to a DexScreener chainId. */
export function normalizeChain(chain) {
  if (!chain) return null;
  const c = String(chain).trim().toLowerCase();
  return CHAIN_ALIASES[c] ?? c;
}

/** @returns {ChainInfo|null} */
export function chainInfo(chain) {
  return CHAINS[normalizeChain(chain)] ?? null;
}

/** 'evm' | 'solana' | null by chain id; unknown chains fall back to address shape. */
export function chainKind(chain, address) {
  const info = chainInfo(chain);
  if (info) return info.kind;
  return detectAddressKind(address);
}

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const isEvmAddress = (a) => EVM_RE.test(String(a ?? ''));
export const isSolanaAddress = (a) => SOL_RE.test(String(a ?? ''));

/** @returns {'evm'|'solana'|null} */
export function detectAddressKind(a) {
  if (isEvmAddress(a)) return 'evm';
  if (isSolanaAddress(a)) return 'solana';
  return null;
}

/**
 * Find a token address in free text (plain address, DexScreener/explorer URL, etc.).
 * @returns {string|null}
 */
export function extractAddress(text) {
  const s = String(text ?? '');
  const evm = s.match(/0x[0-9a-fA-F]{40}/);
  if (evm) return evm[0];
  for (const tok of s.split(/[\s/?&=#:,;"'()<>]+/)) {
    if (isSolanaAddress(tok)) return tok;
  }
  return null;
}

const EVM_BURN = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0xdead000000000000000042069420694206942069',
]);
const SOL_BURN = new Set(['1nc1nerator11111111111111111111111111111111', '11111111111111111111111111111111']);

export function isBurnAddress(a) {
  if (!a) return false;
  return EVM_BURN.has(String(a).toLowerCase()) || SOL_BURN.has(String(a));
}
