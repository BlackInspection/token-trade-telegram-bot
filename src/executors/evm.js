// EVM live executor: 0x Swap API v2 (allowance-holder) + ethers signing.
// ethers is loaded with dynamic import() only for real (non-dry) trades.
// Buys spend the chain's USDC (see chains.js); sells go back to USDC.
import { Executor, ExecutionError, markSent, sellAmountRaw, simulatedFill, slippageOf } from './base.js';
import { fetchJson } from '../http.js';
import { requireKeys } from '../config.js';
import { chainInfo } from '../chains.js';
import { getLogger } from '../log.js';

const log = getLogger('evm');
const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

export class EvmExecutor extends Executor {
  name = '0x';

  constructor(cfg, { dry, offline = false }) {
    super();
    this.live = cfg.live;
    this.trading = cfg.trading;
    this.dry = dry;
    this.offline = offline;
    /** @type {Map<string, any>} */
    this.ctxByChain = new Map();
  }

  get headers() {
    return { '0x-api-key': this.live.zeroxApiKey, '0x-version': 'v2' };
  }

  chain(token) {
    const info = chainInfo(token.chain);
    if (!info || info.kind !== 'evm') throw new ExecutionError(`chain "${token.chain}" is not a supported EVM chain`);
    if (!info.usdc || !info.zerox) throw new ExecutionError(`live trading not configured for chain "${token.chain}" (no USDC/0x mapping in chains.js)`);
    return info;
  }

  /**
   * 0x v2 endpoint: "price" (indicative, no taker) or "quote" (firm, with tx). TODO(verify): params/response vs current 0x docs.
   * slippageBps: the engine's current setting (/settings slippage_bps); SLIPPAGE_BPS from .env when not given.
   */
  async zeroX(kind, { chainId, sellToken, buyToken, sellAmount, taker, slippageBps = this.trading.slippageBps }) {
    return fetchJson(`${this.live.zeroxApiUrl}/swap/allowance-holder/${kind}`, {
      query: { chainId, sellToken, buyToken, sellAmount: sellAmount.toString(), taker, slippageBps },
      headers: this.headers,
      timeoutMs: 15_000,
    });
  }

  async dryNote(side, token, usd, slippageBps = this.trading.slippageBps) {
    const base = `DRY: would ${side === 'BUY' ? `swap $${usd.toFixed(2)} USDC -> ${token.symbol}` : `swap ${token.symbol} -> USDC`} via 0x on ${token.chain}`;
    if (this.offline || !this.live.dryRunQuotes || side !== 'BUY') return base;
    if (!this.live.zeroxApiKey) return `${base} (no ZEROX_API_KEY: quote skipped)`;
    try {
      const info = this.chain(token);
      const sellAmount = BigInt(Math.floor(usd * 10 ** Math.min(info.usdc.decimals, 6))) * 10n ** BigInt(Math.max(0, info.usdc.decimals - 6));
      const q = await this.zeroX('price', { chainId: info.chainId, sellToken: info.usdc.address, buyToken: token.address, sellAmount, slippageBps });
      return `${base} (price: buyAmount=${q.buyAmount} raw, liquidity ${q.liquidityAvailable === false ? 'NO' : 'ok'})`;
    } catch (err) {
      return `${base} (price check failed: ${err.message})`;
    }
  }

  async context(token) {
    const info = this.chain(token);
    if (this.ctxByChain.has(token.chain)) return this.ctxByChain.get(token.chain);
    const rpc = this.live.evmRpcUrls[token.chain];
    requireKeys([
      ['EVM_PRIVATE_KEY', this.live.evmPrivateKey],
      ['ZEROX_API_KEY', this.live.zeroxApiKey],
      [`EVM_RPC_URLS (entry "${token.chain}=https://...")`, rpc],
    ]);
    let ethers;
    try {
      ({ ethers } = await import('ethers'));
    } catch {
      throw new ExecutionError('ethers is not installed (optional dependency): run `npm install ethers@^6`');
    }
    const provider = new ethers.JsonRpcProvider(rpc, info.chainId);
    const wallet = new ethers.Wallet(this.live.evmPrivateKey, provider);
    log.info(`live wallet ${wallet.address} on ${token.chain}`);
    const ctx = { ethers, provider, wallet, info };
    this.ctxByChain.set(token.chain, ctx);
    return ctx;
  }

  /**
   * Hot-wallet USDC balance in USD, summed over every chain with an EVM_RPC_URLS entry and a USDC mapping, for the
   * balance-drop auto-pause. Gas tokens and token holdings are not counted. Any failed read throws (a partial sum would
   * look like a drop). TODO(verify): run against a real wallet and RPCs.
   * @returns {Promise<number|null>} null without EVM_PRIVATE_KEY or without any usable chain
   */
  async walletBalanceUsd() {
    if (!this.live.evmPrivateKey) return null;
    const chains = Object.keys(this.live.evmRpcUrls ?? {}).filter((c) => {
      const info = chainInfo(c);
      return info?.kind === 'evm' && info.usdc && info.zerox;
    });
    if (!chains.length) return null;
    let total = 0;
    for (const chain of chains) {
      const { ethers, wallet, info } = await this.context({ chain, address: '', symbol: 'USDC' });
      const bal = await new ethers.Contract(info.usdc.address, ERC20_ABI, wallet).balanceOf(wallet.address);
      total += Number(ethers.formatUnits(bal, info.usdc.decimals));
    }
    return total;
  }

  /** Firm quote -> approve if needed -> send tx -> wait. @returns {Promise<{hash: string, quote: any}>} */
  async execute(ctx, { sellToken, buyToken, sellAmount, slippageBps = this.trading.slippageBps }) {
    const { ethers, wallet, info } = ctx;
    const args = { chainId: info.chainId, sellToken, buyToken, sellAmount, taker: wallet.address, slippageBps };
    let q = await this.zeroX('quote', args);
    if (q.liquidityAvailable === false) throw new ExecutionError('0x: no liquidity for this swap');
    if (q.issues?.balance) throw new ExecutionError(`0x: insufficient balance (${JSON.stringify(q.issues.balance)})`);
    if (q.issues?.allowance) {
      const spender = q.issues.allowance.spender;
      log.info(`approving ${sellAmount} of ${sellToken} for ${spender}`);
      const erc20 = new ethers.Contract(sellToken, ERC20_ABI, wallet);
      await (await erc20.approve(spender, sellAmount)).wait();
      q = await this.zeroX('quote', args); // re-quote after approval
    }
    const t = q.transaction;
    if (!t?.to || !t?.data) throw new ExecutionError(`0x quote has no transaction: ${JSON.stringify(q).slice(0, 200)}`);
    let tx;
    try {
      tx = await wallet.sendTransaction({
        to: t.to,
        data: t.data,
        value: t.value ? BigInt(t.value) : 0n,
        gasLimit: t.gas ? (BigInt(t.gas) * 12n) / 10n : undefined,
      });
    } catch (err) {
      throw markSent(err); // the RPC may have broadcast it before failing
    }
    let rcpt;
    try {
      rcpt = await tx.wait();
    } catch (err) {
      throw markSent(err, tx.hash);
    }
    if (rcpt?.status !== 1) throw new ExecutionError(`swap tx reverted: ${tx.hash}`);
    return { hash: tx.hash, quote: q };
  }

  async buy({ token, usd, price, costs = null, slippageBps }) {
    const slip = slippageOf({ slippageBps }, this.trading);
    if (this.dry) return simulatedFill('BUY', { usd, price, costs }, { ...this.trading, slippageBps: slip }, '0x', true, await this.dryNote('BUY', token, usd, slip));
    const ctx = await this.context(token);
    const { ethers, wallet, info } = ctx;
    const sellAmount = ethers.parseUnits(usd.toFixed(Math.min(6, info.usdc.decimals)), info.usdc.decimals);
    // Read decimals before sending: after the swap lands the fill must be returned, not thrown.
    const dec = Number(await new ethers.Contract(token.address, ERC20_ABI, wallet).decimals());
    const { hash, quote } = await this.execute(ctx, { sellToken: info.usdc.address, buyToken: token.address, sellAmount, slippageBps: slip });
    // TODO(verify): read the actual received amount from the receipt logs instead of quoted buyAmount.
    const qty = Number(ethers.formatUnits(quote.buyAmount, dec));
    return { side: 'BUY', price: usd / qty, qty, usd, feeUsd: 0, venue: '0x', txId: hash, dry: false };
  }

  /** Sells `qty` tokens (pct % of the bot's position), capped at the wallet balance; never the wallet's other tokens. */
  async sell({ token, qty, pct, price, costs = null, slippageBps }) {
    const slip = slippageOf({ slippageBps }, this.trading);
    if (this.dry) return simulatedFill('SELL', { qty, price, costs }, { ...this.trading, slippageBps: slip }, '0x', true, await this.dryNote('SELL', token, qty * price, slip));
    const ctx = await this.context(token);
    const { ethers, wallet, info } = ctx;
    const erc20 = new ethers.Contract(token.address, ERC20_ABI, wallet);
    const dec = Number(await erc20.decimals());
    const bal = BigInt(await erc20.balanceOf(wallet.address));
    const { amount, all } = sellAmountRaw({ balanceRaw: bal, qty, decimals: dec });
    if (amount <= 0n) throw new ExecutionError(`no ${token.symbol} balance to sell`);
    const { hash, quote } = await this.execute(ctx, { sellToken: token.address, buyToken: info.usdc.address, sellAmount: amount, slippageBps: slip });
    const soldQty = Number(ethers.formatUnits(amount, dec));
    const usd = Number(ethers.formatUnits(quote.buyAmount, info.usdc.decimals));
    // all: the wallet held no more than this sale, so the position's share is gone even if it held a little less.
    return { side: 'SELL', price: usd / soldQty, qty: all && pct >= 100 ? qty : Math.min(qty, soldQty), usd, feeUsd: 0, venue: '0x', txId: hash, dry: false };
  }
}
