// GoPlus Security: contract risk flags.
//   EVM:    GET /api/v1/token_security/{chain_id}?contract_addresses=0x...
//   Solana: GET /api/v1/solana/token_security?contract_addresses=...
// Public without a key (rate-limited). Values are mostly strings "0"/"1"; taxes are fractions ("0.05" = 5%).
import { fetchJson } from '../http.js';
import { chainInfo, isBurnAddress } from '../chains.js';

/**
 * Normalised security report. `null` = unknown.
 * @typedef {{
 *   sources: string[], kind: 'evm'|'solana',
 *   isHoneypot: boolean|null, cannotBuy: boolean|null, cannotSellAll: boolean|null,
 *   buyTaxPct: number|null, sellTaxPct: number|null, transferTaxPct: number|null,
 *   isMintable: boolean|null, isProxy: boolean|null, isOpenSource: boolean|null,
 *   hasBlacklist: boolean|null, hiddenOwner: boolean|null, canTakeBackOwnership: boolean|null,
 *   ownerChangeBalance: boolean|null, selfDestruct: boolean|null, externalCall: boolean|null,
 *   taxModifiable: boolean|null, personalTaxModifiable: boolean|null, transferPausable: boolean|null,
 *   tradingCooldown: boolean|null, ownerAddress: string|null, ownerRenounced: boolean|null,
 *   creatorPct: number|null, ownerPct: number|null, holderCount: number|null, top10Pct: number|null,
 *   lpLockedPct: number|null, honeypotSameCreator: boolean|null, inCex: boolean|null,
 *   freezable: boolean|null, balanceMutable: boolean|null, closable: boolean|null,
 *   metadataMutable: boolean|null, transferHook: boolean|null, nonTransferable: boolean|null,
 *   defaultFrozen: boolean|null, honeypotIs: any, errors: string[]
 * }} SecurityReport
 */

export function emptySecurity(kind) {
  return {
    sources: [], kind,
    isHoneypot: null, cannotBuy: null, cannotSellAll: null,
    buyTaxPct: null, sellTaxPct: null, transferTaxPct: null,
    isMintable: null, isProxy: null, isOpenSource: null, hasBlacklist: null, hiddenOwner: null,
    canTakeBackOwnership: null, ownerChangeBalance: null, selfDestruct: null, externalCall: null,
    taxModifiable: null, personalTaxModifiable: null, transferPausable: null, tradingCooldown: null,
    ownerAddress: null, ownerRenounced: null, creatorPct: null, ownerPct: null, holderCount: null,
    top10Pct: null, lpLockedPct: null, honeypotSameCreator: null, inCex: null,
    freezable: null, balanceMutable: null, closable: null, metadataMutable: null, transferHook: null,
    nonTransferable: null, defaultFrozen: null, honeypotIs: null, errors: [],
  };
}

const flag = (v) => (v === '1' || v === 1 ? true : v === '0' || v === 0 ? false : null);
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const fracToPct = (v) => {
  const x = num(v);
  return x === null ? null : x * 100;
};

/** Sum of the top-10 holder shares (%) excluding burn addresses, locked balances and LP pools. */
export function topHoldersPct(holders, excludeAddrs = []) {
  if (!Array.isArray(holders) || holders.length === 0) return null;
  const ex = new Set(excludeAddrs.map((a) => String(a).toLowerCase()));
  const rows = holders
    .filter((h) => {
      const a = h.address ?? h.account;
      return !isBurnAddress(a) && !ex.has(String(a).toLowerCase()) && Number(h.is_locked) !== 1;
    })
    .map((h) => num(h.percent) ?? 0)
    .sort((a, b) => b - a)
    .slice(0, 10);
  return rows.reduce((s, x) => s + x, 0) * 100;
}

/** % of LP tokens that are locked or burned. */
export function lpLockedPct(lpHolders) {
  if (!Array.isArray(lpHolders) || lpHolders.length === 0) return null;
  const locked = lpHolders
    .filter((h) => Number(h.is_locked) === 1 || isBurnAddress(h.address))
    .reduce((s, h) => s + (num(h.percent) ?? 0), 0);
  return Math.min(100, locked * 100);
}

/** @returns {SecurityReport} */
export function parseEvmSecurity(raw) {
  const s = emptySecurity('evm');
  s.sources.push('goplus');
  const owner = raw.owner_address ?? null;
  const pairs = Array.isArray(raw.dex) ? raw.dex.map((d) => d.pair).filter(Boolean) : [];
  Object.assign(s, {
    isHoneypot: flag(raw.is_honeypot),
    cannotBuy: flag(raw.cannot_buy),
    cannotSellAll: flag(raw.cannot_sell_all),
    buyTaxPct: fracToPct(raw.buy_tax),
    sellTaxPct: fracToPct(raw.sell_tax),
    transferTaxPct: fracToPct(raw.transfer_tax),
    isMintable: flag(raw.is_mintable),
    isProxy: flag(raw.is_proxy),
    isOpenSource: flag(raw.is_open_source),
    hasBlacklist: flag(raw.is_blacklisted),
    hiddenOwner: flag(raw.hidden_owner),
    canTakeBackOwnership: flag(raw.can_take_back_ownership),
    ownerChangeBalance: flag(raw.owner_change_balance),
    selfDestruct: flag(raw.selfdestruct),
    externalCall: flag(raw.external_call),
    taxModifiable: flag(raw.slippage_modifiable),
    personalTaxModifiable: flag(raw.personal_slippage_modifiable),
    transferPausable: flag(raw.transfer_pausable),
    tradingCooldown: flag(raw.trading_cooldown),
    ownerAddress: owner || null,
    ownerRenounced: owner === null || owner === undefined ? null : owner === '' || isBurnAddress(owner),
    creatorPct: fracToPct(raw.creator_percent),
    ownerPct: fracToPct(raw.owner_percent),
    holderCount: num(raw.holder_count),
    top10Pct: topHoldersPct(raw.holders, pairs),
    lpLockedPct: lpLockedPct(raw.lp_holders),
    honeypotSameCreator: flag(raw.honeypot_with_same_creator),
    inCex: raw.is_in_cex ? raw.is_in_cex.listed === '1' : null,
  });
  return s;
}

const status = (o) => (o && typeof o === 'object' && 'status' in o ? o.status === '1' || o.status === 1 : null);

/** @returns {SecurityReport} */
export function parseSolanaSecurity(raw) {
  const s = emptySecurity('solana');
  s.sources.push('goplus');
  // TODO(verify): exact shape of transfer_fee for Token-2022 mints; assumed {current_fee_rate: {fee_rate}} in bps or fraction.
  let feePct = 0;
  const tf = raw.transfer_fee;
  if (tf && typeof tf === 'object' && Object.keys(tf).length) {
    const rate = num(tf.current_fee_rate?.fee_rate ?? tf.fee_rate);
    if (rate !== null) feePct = rate > 1 ? rate / 100 : rate * 100;
  }
  const pools = Array.isArray(raw.dex) ? raw.dex.map((d) => d.id).filter(Boolean) : [];
  Object.assign(s, {
    isHoneypot: null, // GoPlus has no honeypot simulation for Solana
    buyTaxPct: feePct,
    sellTaxPct: feePct,
    transferTaxPct: feePct,
    isMintable: status(raw.mintable),
    freezable: status(raw.freezable),
    balanceMutable: status(raw.balance_mutable_authority),
    closable: status(raw.closable),
    metadataMutable: status(raw.metadata_mutable),
    transferHook: Array.isArray(raw.transfer_hook) ? raw.transfer_hook.length > 0 : null,
    nonTransferable: flag(raw.non_transferable),
    // SPL default account state: 1 = initialized, 2 = frozen (new holders can't move tokens).
    defaultFrozen: raw.default_account_state === undefined ? null : String(raw.default_account_state) === '2',
    holderCount: num(raw.holder_count),
    top10Pct: topHoldersPct(raw.holders, pools),
    lpLockedPct: null, // TODO(verify): derive from dex[].burn_percent / lp_holders for Raydium pools
    ownerRenounced: null,
  });
  return s;
}

/** GoPlus lowercases EVM keys in `result`; Solana keeps the original case. */
function pickResult(result, address) {
  if (!result || typeof result !== 'object') return null;
  return result[address] ?? result[String(address).toLowerCase()] ?? Object.values(result)[0] ?? null;
}

export class GoPlusClient {
  constructor({ baseUrl = 'https://api.gopluslabs.io', accessToken = '', timeoutMs = 15000 } = {}) {
    this.baseUrl = baseUrl;
    this.accessToken = accessToken;
    this.timeoutMs = timeoutMs;
  }

  /** @returns {Promise<SecurityReport|null>} null when the chain is unsupported or no data. */
  async getTokenSecurity(chain, address) {
    const info = chainInfo(chain);
    if (!info?.goplus) return null;
    const url =
      info.kind === 'solana'
        ? `${this.baseUrl}/api/v1/solana/token_security`
        : `${this.baseUrl}/api/v1/token_security/${info.goplus}`;
    // TODO(verify): header format for GoPlus access tokens (obtained via /api/v1/token with app_key+sign).
    const headers = this.accessToken ? { Authorization: this.accessToken } : {};
    const data = await fetchJson(url, { query: { contract_addresses: address }, headers, timeoutMs: this.timeoutMs });
    // code 1 = ok; 2 = partial data. TODO(verify): other codes (e.g. 4029 rate limit) are surfaced as errors.
    if (data?.code !== 1 && data?.code !== 2) throw new Error(`GoPlus error ${data?.code}: ${data?.message}`);
    const raw = pickResult(data.result, address);
    if (!raw || Object.keys(raw).length === 0) return null;
    return info.kind === 'solana' ? parseSolanaSecurity(raw) : parseEvmSecurity(raw);
  }
}
