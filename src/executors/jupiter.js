// Solana live executor: Jupiter quote + swap, signed locally with a keypair from .env.
// @solana/web3.js is loaded with dynamic import() only when a real (non-dry) trade happens.
// Buys spend SOLANA_QUOTE_MINT (USDC by default); sells go back to it.
import { Executor, ExecutionError, markSent, sellAmountRaw, simulatedFill, slippageOf } from './base.js';
import { fetchJson } from '../http.js';
import { requireKeys } from '../config.js';
import { getLogger } from '../log.js';

const log = getLogger('jupiter');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 decode (Bitcoin alphabet). @returns {Uint8Array} */
export function decodeBase58(s) {
  const str = String(s).trim();
  let num = 0n;
  for (const ch of str) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error('invalid base58 character');
    num = num * 58n + BigInt(v);
  }
  const bytes = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  for (const ch of str) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** SOLANA_PRIVATE_KEY as base58 (Phantom export) or JSON array (solana-keygen file content). */
export function decodeSolanaSecret(s) {
  const t = String(s).trim();
  const bytes = t.startsWith('[') ? Uint8Array.from(JSON.parse(t)) : decodeBase58(t);
  if (bytes.length !== 64) throw new ExecutionError(`SOLANA_PRIVATE_KEY must decode to 64 bytes, got ${bytes.length}`);
  return bytes;
}

export class JupiterExecutor extends Executor {
  name = 'jupiter';

  /** @param {any} cfg full config @param {{dry: boolean, offline?: boolean}} opts */
  constructor(cfg, { dry, offline = false }) {
    super();
    this.cfg = cfg;
    this.live = cfg.live;
    this.trading = cfg.trading;
    this.dry = dry;
    this.offline = offline;
    this._ctx = null;
  }

  get headers() {
    // TODO(verify): lite-api.jup.ag is keyless; api.jup.ag needs x-api-key.
    return this.live.jupiterApiKey ? { 'x-api-key': this.live.jupiterApiKey } : {};
  }

  /** slippageBps: the engine's current setting (/settings slippage_bps); SLIPPAGE_BPS from .env when not given. */
  async quote({ inputMint, outputMint, amount, slippageBps = this.trading.slippageBps }) {
    return fetchJson(`${this.live.jupiterApiUrl}/quote`, {
      query: { inputMint, outputMint, amount: amount.toString(), slippageBps },
      headers: this.headers,
      timeoutMs: 10_000,
    });
  }

  async dryNote(side, token, usd, slippageBps = this.trading.slippageBps) {
    const base = `DRY: would ${side === 'BUY' ? `swap $${usd.toFixed(2)} USDC -> ${token.symbol}` : `swap ${token.symbol} -> USDC`} via Jupiter`;
    if (this.offline || !this.live.dryRunQuotes || side !== 'BUY') return base;
    try {
      const amount = BigInt(Math.floor(usd * 10 ** this.live.solanaQuoteDecimals));
      const q = await this.quote({ inputMint: this.live.solanaQuoteMint, outputMint: token.address, amount, slippageBps });
      const impact = Number(q.priceImpactPct ?? 0) * 100;
      return `${base} (quote: outAmount=${q.outAmount} raw, impact ${impact.toFixed(2)}%, ${q.routePlan?.length ?? 0} hop(s))`;
    } catch (err) {
      return `${base} (quote failed: ${err.message})`;
    }
  }

  async context() {
    if (this._ctx) return this._ctx;
    requireKeys([
      ['SOLANA_PRIVATE_KEY', this.live.solanaPrivateKey],
      ['SOLANA_RPC_URL', this.live.solanaRpcUrl],
    ]);
    let web3;
    try {
      web3 = await import('@solana/web3.js');
    } catch {
      throw new ExecutionError('@solana/web3.js is not installed (optional dependency): run `npm install @solana/web3.js@^1.99.0`');
    }
    const kp = web3.Keypair.fromSecretKey(decodeSolanaSecret(this.live.solanaPrivateKey));
    const conn = new web3.Connection(this.live.solanaRpcUrl, 'confirmed');
    log.info(`live wallet ${kp.publicKey.toBase58()}`);
    this._ctx = { web3, kp, conn };
    return this._ctx;
  }

  async decimals(mint) {
    const { web3, conn } = await this.context();
    const info = await conn.getParsedAccountInfo(new web3.PublicKey(mint));
    const d = info.value?.data?.parsed?.info?.decimals;
    if (typeof d !== 'number') throw new ExecutionError(`cannot read decimals for mint ${mint}`);
    return d;
  }

  async balanceRaw(mint) {
    const { web3, conn, kp } = await this.context();
    const res = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { mint: new web3.PublicKey(mint) });
    return res.value.reduce((s, acc) => s + BigInt(acc.account.data.parsed.info.tokenAmount.amount), 0n);
  }

  /**
   * Hot-wallet balance of the quote token (SOLANA_QUOTE_MINT, USDC by default) in USD, for the balance-drop auto-pause.
   * SOL for fees and token holdings are not counted. TODO(verify): run against a real wallet and RPC.
   * @returns {Promise<number|null>} null without SOLANA_PRIVATE_KEY
   */
  async walletBalanceUsd() {
    if (!this.live.solanaPrivateKey) return null;
    const raw = await this.balanceRaw(this.live.solanaQuoteMint);
    return Number(raw) / 10 ** this.live.solanaQuoteDecimals;
  }

  /** Request the swap tx for a quote, sign, send and confirm. @returns {Promise<string>} signature */
  async swap(quote) {
    const { web3, conn, kp } = await this.context();
    // TODO(verify): Jupiter swap v1 body/fields (prioritizationFeeLamports format may change).
    const res = await fetchJson(`${this.live.jupiterApiUrl}/swap`, {
      method: 'POST',
      headers: this.headers,
      body: {
        quoteResponse: quote,
        userPublicKey: kp.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      },
      retries: 0,
      timeoutMs: 20_000,
    });
    if (!res?.swapTransaction) throw new ExecutionError(`Jupiter swap returned no transaction: ${JSON.stringify(res).slice(0, 200)}`);
    const tx = web3.VersionedTransaction.deserialize(Buffer.from(res.swapTransaction, 'base64'));
    tx.sign([kp]);
    let sig;
    try {
      sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    } catch (err) {
      throw markSent(err); // the RPC may have forwarded it before failing
    }
    let conf;
    try {
      conf = await conn.confirmTransaction(
        { signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: res.lastValidBlockHeight },
        'confirmed',
      );
    } catch (err) {
      throw markSent(err, sig);
    }
    if (conf.value?.err) throw new ExecutionError(`swap failed on-chain (${sig}): ${JSON.stringify(conf.value.err)}`);
    return sig;
  }

  async buy({ token, usd, price, costs = null, slippageBps }) {
    const slip = slippageOf({ slippageBps }, this.trading);
    if (this.dry) {
      return simulatedFill('BUY', { usd, price, costs }, { ...this.trading, slippageBps: slip }, 'jupiter', true, await this.dryNote('BUY', token, usd, slip));
    }
    await this.context(); // validate keys / deps before any network call
    // Everything that can fail runs before the swap is sent: after it lands the fill must be returned, not thrown.
    const dec = await this.decimals(token.address);
    const amount = BigInt(Math.floor(usd * 10 ** this.live.solanaQuoteDecimals));
    const q = await this.quote({ inputMint: this.live.solanaQuoteMint, outputMint: token.address, amount, slippageBps: slip });
    const sig = await this.swap(q);
    const qty = Number(q.outAmount) / 10 ** dec;
    // TODO(verify): use actual received amount from tx meta instead of quoted outAmount.
    return { side: 'BUY', price: usd / qty, qty, usd, feeUsd: 0, venue: 'jupiter', txId: sig, dry: false };
  }

  /** Sells `qty` tokens (pct % of the bot's position), capped at the wallet balance; never the wallet's other tokens. */
  async sell({ token, qty, pct, price, costs = null, slippageBps }) {
    const slip = slippageOf({ slippageBps }, this.trading);
    if (this.dry) {
      return simulatedFill('SELL', { qty, price, costs }, { ...this.trading, slippageBps: slip }, 'jupiter', true, await this.dryNote('SELL', token, qty * price, slip));
    }
    const dec = await this.decimals(token.address);
    const bal = await this.balanceRaw(token.address);
    const { amount, all } = sellAmountRaw({ balanceRaw: bal, qty, decimals: dec });
    if (amount <= 0n) throw new ExecutionError(`no ${token.symbol} balance to sell`);
    const q = await this.quote({ inputMint: token.address, outputMint: this.live.solanaQuoteMint, amount, slippageBps: slip });
    const sig = await this.swap(q);
    const soldQty = Number(amount) / 10 ** dec;
    const usd = Number(q.outAmount) / 10 ** this.live.solanaQuoteDecimals;
    // all: the wallet held no more than this sale, so the position's share is gone even if it held a little less.
    return { side: 'SELL', price: usd / soldQty, qty: all && pct >= 100 ? qty : Math.min(qty, soldQty), usd, feeUsd: 0, venue: 'jupiter', txId: sig, dry: false };
  }
}
