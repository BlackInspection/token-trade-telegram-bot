// Shared event log, schema suite.event.v1: one JSON object per line (data/events.jsonl), rotated to .1 at EVENTS_MAX_MB.
// Only the schema and the reason-code names are shared with the sibling bots; nothing is imported from them.
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA = 'suite.event.v1';
export const BOT_NAME = 'crypto-trading-bot';
export const KINDS = ['alert', 'buy', 'skip', 'sell', 'error', 'pause', 'resume'];
export const MODES = ['dry', 'live', 'shadow'];
export const SUBJECT_TYPES = ['gift', 'nft', 'token', 'market', 'wallet'];
export const CCYS = ['TON', 'USDC', 'SOL', 'ETH'];
export const VERDICTS = ['BUY', 'WATCH', 'AVOID', 'SKIP', 'COPY'];
export const SEVS = ['good', 'warn', 'bad'];
export const CONFIDENCES = ['high', 'med', 'low'];

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Dependency-free validator. @returns {{ok: boolean, errors: string[]}} */
export function validateEvent(ev) {
  const e = [];
  if (!isObj(ev)) return { ok: false, errors: ['event must be an object'] };
  if (ev.v !== 1) e.push('v must be 1');
  if (!Number.isFinite(ev.ts)) e.push('ts must be a number (ms)');
  if (typeof ev.bot !== 'string' || !ev.bot) e.push('bot is required');
  if (!KINDS.includes(ev.kind)) e.push(`kind must be one of ${KINDS.join('|')}`);
  if (!MODES.includes(ev.mode)) e.push(`mode must be one of ${MODES.join('|')}`);
  if (typeof ev.id !== 'string' || !ev.id) e.push('id is required');
  if (!isObj(ev.subject) || !SUBJECT_TYPES.includes(ev.subject.type) || typeof ev.subject.ref !== 'string') e.push('subject {type, ref, title, url} is required');
  if (ev.money !== undefined && ev.money !== null) {
    if (!isObj(ev.money) || !CCYS.includes(ev.money.ccy)) e.push('money.ccy must be one of TON|USDC|SOL|ETH');
  }
  if (ev.verdict !== undefined && ev.verdict !== null && !VERDICTS.includes(ev.verdict)) e.push('verdict is invalid');
  if (ev.score !== undefined && ev.score !== null && !(Number.isFinite(ev.score) && ev.score >= 0 && ev.score <= 100)) e.push('score must be 0-100 or null');
  if (ev.confidence !== undefined && !CONFIDENCES.includes(ev.confidence)) e.push('confidence must be high|med|low');
  if (!Array.isArray(ev.reasons)) e.push('reasons must be an array');
  else {
    for (const r of ev.reasons) {
      if (!isObj(r) || typeof r.code !== 'string' || !SEVS.includes(r.sev) || !isObj(r.p ?? {})) {
        e.push('each reason is {code, sev: good|warn|bad, p: {...}}');
        break;
      }
    }
  }
  if (ev.tx !== undefined && ev.tx !== null && typeof ev.tx !== 'string') e.push('tx must be a string or null');
  return { ok: e.length === 0, errors: e };
}

/** Parse a JSONL file; malformed or schema-mismatched lines are counted, not thrown. */
export function readEventsFile(file) {
  const events = [];
  let bad = 0;
  if (!fs.existsSync(file)) return { events, bad, missing: true };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (validateEvent(ev).ok) events.push(ev);
      else bad += 1;
    } catch {
      bad += 1;
    }
  }
  return { events, bad, missing: false };
}

const filterEvents = (list, { since = 0, ref = null, kinds = null, limit = null } = {}) => {
  let out = list.filter((e) => e.ts >= since && (!ref || String(e.subject?.ref).toLowerCase() === String(ref).toLowerCase()) && (!kinds || kinds.includes(e.kind)));
  if (limit) out = out.slice(-limit);
  return out;
};

/** In-memory log (tests, and engines constructed without a file). Same interface as EventLog. */
export class MemoryEventLog {
  constructor() {
    this.events = [];
  }

  append(ev) {
    const v = validateEvent(ev);
    if (!v.ok) throw new Error(`invalid event: ${v.errors.join('; ')}`);
    this.events.push(ev);
    return ev;
  }

  read(opts = {}) {
    return filterEvents(this.events, opts);
  }
}

/** JSONL file log with size rotation (file -> file.1). */
export class EventLog {
  /** @param {{file: string, maxMb?: number}} opts */
  constructor({ file, maxMb = 20 }) {
    this.file = file;
    this.maxBytes = maxMb * 1024 * 1024;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  append(ev) {
    const v = validateEvent(ev);
    if (!v.ok) throw new Error(`invalid event: ${v.errors.join('; ')}`);
    const line = `${JSON.stringify(ev)}\n`;
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      size = 0;
    }
    if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) fs.renameSync(this.file, `${this.file}.1`);
    fs.appendFileSync(this.file, line);
    return ev;
  }

  read(opts = {}) {
    const all = [...readEventsFile(`${this.file}.1`).events, ...readEventsFile(this.file).events];
    return filterEvents(all, opts);
  }
}

/** Build a valid event with defaults. */
export function makeEvent({ ts = Date.now(), kind, mode, id, subject, money = null, verdict = null, score = null, confidence = 'low', reasons = [], rule_id = null, tx = null }) {
  return { v: 1, ts, bot: BOT_NAME, kind, mode, id, subject, money, verdict, score, confidence, reasons, rule_id, tx };
}
