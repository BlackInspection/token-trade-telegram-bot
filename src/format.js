// Human-readable formatting helpers (pure).

/** Price with enough decimals for micro-cap tokens, never in exponent form. */
export function fmtPrice(p) {
  if (p === null || p === undefined || !Number.isFinite(p)) return 'n/a';
  if (p === 0) return '$0';
  const abs = Math.abs(p);
  if (abs >= 1000) return `$${p.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (abs >= 1) return `$${p.toFixed(4)}`;
  const decimals = Math.min(18, Math.max(4, -Math.floor(Math.log10(abs)) + 3));
  return `$${p.toFixed(decimals)}`;
}

/** Compact USD: $1.23K / $4.5M / $2.01B. */
export function fmtUsd(v, { compact = true } = {}) {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'n/a';
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (!compact || a < 1000) return `${sign}$${a.toFixed(2)}`;
  if (a < 1e6) return `${sign}$${(a / 1e3).toFixed(2)}K`;
  if (a < 1e9) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  return `${sign}$${(a / 1e9).toFixed(2)}B`;
}

export function fmtPct(v, digits = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'n/a';
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

export function fmtNum(v, digits = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'n/a';
  return v.toFixed(digits);
}

export function fmtAge(hours) {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return 'n/a';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours / 24)}d`;
}

export function shortAddr(a) {
  if (!a) return '';
  const s = String(a);
  return s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

export const yesNo = (v) => (v === true ? 'YES' : v === false ? 'no' : '?');

/** Split long text for Telegram's 4096-char limit, preferring line breaks. */
export function chunkText(text, max = 4000) {
  const out = [];
  let rest = String(text);
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}

/** Escape text for Telegram HTML parse mode. */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** HTML (Telegram subset) -> plain text with the same lines (for stdout and CLI). */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Money for sentences: "$50", "$37.50", "$0.50", "$1,250". */
export function money(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'n/a';
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1000) return `${sign}$${Math.round(a).toLocaleString('en-US')}`;
  if (Math.abs(a - Math.round(a)) < 0.005) return `${sign}$${Math.round(a)}`;
  return `${sign}$${a.toFixed(2)}`;
}

/** Percent for sentences: "25%", "6.8%". */
export function pctText(v, digits = 1) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '?%';
  const r = Math.abs(v - Math.round(v)) < 0.05 ? Math.round(v).toString() : v.toFixed(digits);
  return `${r}%`;
}
