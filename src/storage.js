// SQLite persistence via built-in node:sqlite (DatabaseSync). No native addons.
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS watchlist (
  address TEXT PRIMARY KEY,
  chain TEXT,
  symbol TEXT,
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,               -- paper | live
  dry INTEGER NOT NULL DEFAULT 0,   -- 1 = live mode with DRY_RUN (simulated fills)
  address TEXT NOT NULL,
  chain TEXT,
  symbol TEXT,
  qty REAL NOT NULL,
  entry_price REAL NOT NULL,
  cost_usd REAL NOT NULL,
  stop_loss REAL,
  take_profit REAL,
  trail_high REAL,
  status TEXT NOT NULL DEFAULT 'open', -- open | closed
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  exit_price REAL,
  realized_pnl_usd REAL NOT NULL DEFAULT 0,
  close_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_positions_open ON positions(mode, status, address);
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  mode TEXT NOT NULL,
  dry INTEGER NOT NULL DEFAULT 0,
  position_id INTEGER,
  address TEXT NOT NULL,
  chain TEXT,
  symbol TEXT,
  side TEXT NOT NULL,       -- BUY | SELL
  qty REAL NOT NULL,
  price REAL NOT NULL,
  usd REAL NOT NULL,        -- BUY: USD spent (incl. fee); SELL: USD received (net of fee)
  fee_usd REAL NOT NULL DEFAULT 0,
  pnl_usd REAL,             -- SELL only
  venue TEXT,
  tx_id TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(mode, ts);
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  address TEXT NOT NULL,
  symbol TEXT,
  action TEXT NOT NULL,
  verdict TEXT,
  risk_score REAL,
  price REAL,
  reason TEXT
);
-- Every evaluation (incl. skips) so /why can answer "why did / didn't the bot act". Identical consecutive
-- evaluations of a token are collapsed into one row (repeat count + last_ts).
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  address TEXT NOT NULL,
  chain TEXT,
  symbol TEXT,
  kind TEXT NOT NULL,          -- eval | alert | buy | skip | sell | error | pause | resume
  action TEXT,
  verdict TEXT,
  mode TEXT,
  codes TEXT,                  -- JSON [{code, sev, p}]
  text TEXT,
  event_id TEXT,
  repeat INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_decisions_addr ON decisions(address, id);
-- Position Guardian
CREATE TABLE IF NOT EXISTS token_snapshots (
  address TEXT NOT NULL,
  chain TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('entry','last')),
  ts INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY(address, kind)
);
CREATE TABLE IF NOT EXISTS guardian_events (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  address TEXT NOT NULL,
  symbol TEXT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  before TEXT,
  after TEXT,
  action TEXT,
  text TEXT
);
CREATE INDEX IF NOT EXISTS idx_guardian_addr ON guardian_events(address, type, ts);
-- Track record
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  address TEXT NOT NULL,
  chain TEXT,
  symbol TEXT,
  verdict TEXT,
  light TEXT,
  risk_score REAL,
  hard_avoid INTEGER,
  price REAL,
  liquidity_usd REAL,
  levels TEXT,
  features TEXT,
  source TEXT,
  synthetic INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_obs_addr_ts ON observations(address, ts);
CREATE TABLE IF NOT EXISTS outcomes (
  observation_id INTEGER NOT NULL,
  horizon TEXT NOT NULL,
  ts INTEGER NOT NULL,
  price REAL,
  liquidity_usd REAL,
  ret_pct REAL,
  status TEXT,                 -- ok | rugged | delisted | no_data
  hit TEXT,                    -- tp | sl | none | NULL
  PRIMARY KEY(observation_id, horizon)
);
-- Shadow-first rules
CREATE TABLE IF NOT EXISTS shadow_fills (
  id INTEGER PRIMARY KEY,
  rule_id TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  ts INTEGER NOT NULL,
  entry_price REAL,
  entry_costs REAL,
  executable_price REAL,
  mark_price REAL,
  mark_ts INTEGER,
  mark_source TEXT,
  outcome TEXT,
  meta TEXT
);
CREATE TABLE IF NOT EXISTS muted (
  subject TEXT PRIMARY KEY,
  until INTEGER NOT NULL
);
`;

const rowToPosition = (r) =>
  !r ? null : {
    id: r.id,
    mode: r.mode,
    dry: !!r.dry,
    address: r.address,
    chain: r.chain,
    symbol: r.symbol,
    qty: r.qty,
    entryPrice: r.entry_price,
    costUsd: r.cost_usd,
    stopLoss: r.stop_loss,
    takeProfit: r.take_profit,
    trailHigh: r.trail_high,
    status: r.status,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
    exitPrice: r.exit_price,
    realizedPnlUsd: r.realized_pnl_usd,
    closeReason: r.close_reason,
  };

export class Storage {
  /** @param {string} dbPath file path or ':memory:' */
  constructor(dbPath) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    // getBuiltinModule (not a static import) so warnings.js can filter the ExperimentalWarning first.
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    // Migrations for databases created by older versions (guarded by PRAGMA table_info).
    this.addColumnIfMissing('trades', 'tax_usd', 'REAL NOT NULL DEFAULT 0');
    this.addColumnIfMissing('trades', 'impact_usd', 'REAL NOT NULL DEFAULT 0');
    this.addColumnIfMissing('watchlist', 'state', "TEXT CHECK(state IN ('shadow','live','paused')) DEFAULT 'shadow'");
    this.addColumnIfMissing('watchlist', 'promoted_at', 'INTEGER');
  }

  addColumnIfMissing(table, column, ddl) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }

  close() {
    this.db.close();
  }

  // --- kv ---
  getKv(key, def = null) {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return r ? JSON.parse(r.value) : def;
  }

  setKv(key, value) {
    this.db.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  // --- watchlist ---
  /** New entries start in `state` ('shadow' when SHADOW_NEW_RULES); re-adding keeps the existing state. */
  addWatch({ address, chain = null, symbol = null, state = 'shadow', now = Date.now() }) {
    this.db
      .prepare(
        `INSERT INTO watchlist(address, chain, symbol, added_at, state) VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET chain = excluded.chain, symbol = COALESCE(excluded.symbol, watchlist.symbol)`,
      )
      .run(address, chain, symbol, now, state);
  }

  /** Only Shadow.promote() sets 'live'. */
  setWatchState(address, state, now = Date.now()) {
    this.db.prepare('UPDATE watchlist SET state = ?, promoted_at = ? WHERE lower(address) = lower(?)').run(state, state === 'live' ? now : null, address);
  }

  getWatch(address) {
    return this.db.prepare('SELECT address, chain, symbol, added_at AS addedAt, state, promoted_at AS promotedAt FROM watchlist WHERE lower(address) = lower(?)').get(address) ?? null;
  }

  removeWatch(address) {
    return this.db.prepare('DELETE FROM watchlist WHERE lower(address) = lower(?)').run(address).changes > 0;
  }

  listWatch() {
    return this.db.prepare('SELECT address, chain, symbol, added_at AS addedAt, state, promoted_at AS promotedAt FROM watchlist ORDER BY added_at, rowid').all();
  }

  // --- positions ---
  insertPosition(p) {
    const r = this.db
      .prepare(
        `INSERT INTO positions(mode, dry, address, chain, symbol, qty, entry_price, cost_usd, stop_loss, take_profit, trail_high, opened_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.mode, p.dry ? 1 : 0, p.address, p.chain, p.symbol, p.qty, p.entryPrice, p.costUsd, p.stopLoss ?? null, p.takeProfit ?? null, p.trailHigh ?? p.entryPrice, p.openedAt ?? Date.now());
    return this.getPosition(Number(r.lastInsertRowid));
  }

  getPosition(id) {
    return rowToPosition(this.db.prepare('SELECT * FROM positions WHERE id = ?').get(id));
  }

  getOpenPosition(address, mode) {
    return rowToPosition(
      this.db.prepare(`SELECT * FROM positions WHERE status = 'open' AND mode = ? AND lower(address) = lower(?) ORDER BY id DESC LIMIT 1`).get(mode, address),
    );
  }

  listOpenPositions(mode) {
    return this.db.prepare(`SELECT * FROM positions WHERE status = 'open' AND mode = ? ORDER BY id`).all(mode).map(rowToPosition);
  }

  /** Open positions for a token in every mode (protective exits keep running after a mode switch / panic). */
  listOpenPositionsFor(address) {
    return this.db.prepare(`SELECT * FROM positions WHERE status = 'open' AND lower(address) = lower(?) ORDER BY id`).all(address).map(rowToPosition);
  }

  listAllOpenPositions() {
    return this.db.prepare(`SELECT * FROM positions WHERE status = 'open' ORDER BY id`).all().map(rowToPosition);
  }

  /** Closed positions, newest first. */
  listClosedPositions({ mode, limit = 50, since = 0 } = {}) {
    return this.db
      .prepare(`SELECT * FROM positions WHERE status = 'closed' AND mode = ? AND closed_at >= ? ORDER BY closed_at DESC, id DESC LIMIT ?`)
      .all(mode, since, limit)
      .map(rowToPosition);
  }

  positionOpenedBetween(address, from, to) {
    return !!this.db.prepare('SELECT 1 FROM positions WHERE lower(address) = lower(?) AND opened_at BETWEEN ? AND ? LIMIT 1').get(address, from, to);
  }

  /** @param {number} id @param {Record<string, any>} fields camelCase subset */
  updatePosition(id, fields) {
    const map = {
      qty: 'qty', entryPrice: 'entry_price', costUsd: 'cost_usd', stopLoss: 'stop_loss', takeProfit: 'take_profit',
      trailHigh: 'trail_high', status: 'status', closedAt: 'closed_at', exitPrice: 'exit_price',
      realizedPnlUsd: 'realized_pnl_usd', closeReason: 'close_reason',
    };
    const keys = Object.keys(fields).filter((k) => map[k]);
    if (!keys.length) return;
    const sql = `UPDATE positions SET ${keys.map((k) => `${map[k]} = ?`).join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...keys.map((k) => fields[k] ?? null), id);
  }

  // --- trades ---
  insertTrade(t) {
    const r = this.db
      .prepare(
        `INSERT INTO trades(ts, mode, dry, position_id, address, chain, symbol, side, qty, price, usd, fee_usd, pnl_usd, venue, tx_id, reason, tax_usd, impact_usd)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.ts ?? Date.now(), t.mode, t.dry ? 1 : 0, t.positionId ?? null, t.address, t.chain ?? null, t.symbol ?? null,
        t.side, t.qty, t.price, t.usd, t.feeUsd ?? 0, t.pnlUsd ?? null, t.venue ?? null, t.txId ?? null, t.reason ?? null,
        t.taxUsd ?? 0, t.impactUsd ?? 0,
      );
    return Number(r.lastInsertRowid);
  }

  listTrades({ mode, limit = 20 } = {}) {
    return this.db.prepare('SELECT * FROM trades WHERE mode = ? ORDER BY id DESC LIMIT ?').all(mode, limit);
  }

  /** The bot's own real-funds trades since a time (live mode, not dry): explains hot-wallet balance changes. */
  realFlowsSince(sinceMs) {
    return this.db.prepare(`SELECT ts, side, usd FROM trades WHERE mode = 'live' AND dry = 0 AND ts >= ? ORDER BY ts`).all(sinceMs);
  }

  realizedPnlSince(mode, sinceMs) {
    const r = this.db.prepare(`SELECT COALESCE(SUM(pnl_usd), 0) AS pnl FROM trades WHERE mode = ? AND side = 'SELL' AND ts >= ?`).get(mode, sinceMs);
    return r.pnl;
  }

  /** USD spent on buys since a time (daily budget). */
  spentSince(mode, sinceMs) {
    return this.db.prepare(`SELECT COALESCE(SUM(usd), 0) AS s FROM trades WHERE mode = ? AND side = 'BUY' AND ts >= ?`).get(mode, sinceMs).s;
  }

  /** Costs paid in a mode: bot-side fees, token taxes, price impact. */
  costsPaid(mode) {
    return this.db
      .prepare('SELECT COALESCE(SUM(fee_usd), 0) AS fees, COALESCE(SUM(tax_usd), 0) AS taxes, COALESCE(SUM(impact_usd), 0) AS impact FROM trades WHERE mode = ?')
      .get(mode);
  }

  countTradesSince(mode, sinceMs, side = null) {
    const r = side
      ? this.db.prepare('SELECT COUNT(*) AS n FROM trades WHERE mode = ? AND ts >= ? AND side = ?').get(mode, sinceMs, side)
      : this.db.prepare('SELECT COUNT(*) AS n FROM trades WHERE mode = ? AND ts >= ?').get(mode, sinceMs);
    return r.n;
  }

  closedPositionStats(mode) {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN realized_pnl_usd > 0 THEN 1 ELSE 0 END) AS wins,
                COALESCE(SUM(realized_pnl_usd), 0) AS pnl
         FROM positions WHERE mode = ? AND status = 'closed'`,
      )
      .get(mode);
  }

  // --- signals ---
  insertSignal(s) {
    this.db
      .prepare('INSERT INTO signals(ts, address, symbol, action, verdict, risk_score, price, reason) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.ts ?? Date.now(), s.address, s.symbol ?? null, s.action, s.verdict ?? null, s.riskScore ?? null, s.price ?? null, s.reason ?? null);
  }

  // --- decisions (/why) ---
  /** Insert, or collapse into the previous row when the token's last decision is identical. @returns {number} id */
  insertDecision(d) {
    const codes = JSON.stringify(d.codes ?? []);
    const last = this.db.prepare('SELECT * FROM decisions WHERE lower(address) = lower(?) ORDER BY id DESC LIMIT 1').get(d.address);
    if (last && last.kind === d.kind && last.action === (d.action ?? null) && last.verdict === (d.verdict ?? null) && last.codes === codes && last.mode === (d.mode ?? null) && d.kind === 'eval') {
      this.db.prepare('UPDATE decisions SET last_ts = ?, repeat = repeat + 1, text = ? WHERE id = ?').run(d.ts, d.text ?? last.text, last.id);
      return last.id;
    }
    const r = this.db
      .prepare('INSERT INTO decisions(ts, last_ts, address, chain, symbol, kind, action, verdict, mode, codes, text, event_id) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(d.ts, d.ts, d.address, d.chain ?? null, d.symbol ?? null, d.kind, d.action ?? null, d.verdict ?? null, d.mode ?? null, codes, d.text ?? null, d.eventId ?? null);
    return Number(r.lastInsertRowid);
  }

  setDecisionEvent(id, eventId) {
    this.db.prepare('UPDATE decisions SET event_id = ? WHERE id = ?').run(eventId, id);
  }

  getDecision(id) {
    return this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) ?? null;
  }

  getDecisionByEvent(eventId) {
    return this.db.prepare('SELECT * FROM decisions WHERE event_id = ?').get(eventId) ?? null;
  }

  decisionsFor(address, limit = 10) {
    return this.db.prepare('SELECT * FROM decisions WHERE lower(address) = lower(?) ORDER BY id DESC LIMIT ?').all(address, limit).reverse();
  }

  // --- guardian ---
  getSnapshot(address, kind) {
    const r = this.db.prepare('SELECT * FROM token_snapshots WHERE lower(address) = lower(?) AND kind = ?').get(address, kind);
    return r ? { ...JSON.parse(r.data), _ts: r.ts } : null;
  }

  setSnapshot(address, chain, kind, ts, data) {
    const { _ts, ...clean } = data ?? {};
    void _ts;
    this.db
      .prepare(`INSERT INTO token_snapshots(address, chain, kind, ts, data) VALUES(?, ?, ?, ?, ?)
                ON CONFLICT(address, kind) DO UPDATE SET chain = excluded.chain, ts = excluded.ts, data = excluded.data`)
      .run(String(address).toLowerCase(), chain, kind, ts, JSON.stringify(clean));
  }

  insertGuardianEvent(e) {
    const r = this.db
      .prepare('INSERT INTO guardian_events(ts, address, symbol, type, severity, before, after, action, text) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.ts, e.address, e.symbol ?? null, e.type, e.severity, String(e.before ?? ''), String(e.after ?? ''), e.action ?? null, e.text ?? null);
    return Number(r.lastInsertRowid);
  }

  getGuardianEvent(id) {
    return this.db.prepare('SELECT * FROM guardian_events WHERE id = ?').get(id) ?? null;
  }

  latestGuardianEvents(address, limit = 3) {
    return this.db.prepare('SELECT * FROM guardian_events WHERE lower(address) = lower(?) ORDER BY id DESC LIMIT ?').all(address, limit);
  }

  lastGuardianAlertAt(address, type) {
    const r = this.db.prepare("SELECT MAX(ts) AS t FROM guardian_events WHERE lower(address) = lower(?) AND type = ? AND action != 'suppressed'").get(address, type);
    return r?.t ?? null;
  }

  // --- track record ---
  insertObservation(o) {
    const r = this.db
      .prepare(`INSERT INTO observations(ts, address, chain, symbol, verdict, light, risk_score, hard_avoid, price, liquidity_usd, levels, features, source, synthetic)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        o.ts, o.address, o.chain ?? null, o.symbol ?? null, o.verdict ?? null, o.light ?? null, o.riskScore ?? null, o.hardAvoid ? 1 : 0,
        o.price ?? null, o.liquidityUsd ?? null, o.levels ? JSON.stringify(o.levels) : null, JSON.stringify(o.features ?? {}), o.source ?? null, o.synthetic ? 1 : 0,
      );
    return Number(r.lastInsertRowid);
  }

  /** Latest observation of a token at or after `since` (dedupe), or before `before` (Seen before). */
  lastObservation(address, { since = 0, before = Number.MAX_SAFE_INTEGER } = {}) {
    return this.db
      .prepare('SELECT * FROM observations WHERE lower(address) = lower(?) AND ts >= ? AND ts < ? AND synthetic = 0 ORDER BY ts DESC LIMIT 1')
      .get(address, since, before) ?? null;
  }

  /** Observations whose horizon passed without an outcome (ignoring those more than maxLateMs past it). */
  dueObservations(now, horizons, maxLateMs) {
    const out = [];
    for (const { h, ms } of horizons) {
      const rows = this.db
        .prepare(`SELECT o.* FROM observations o LEFT JOIN outcomes x ON x.observation_id = o.id AND x.horizon = ?
                  WHERE x.observation_id IS NULL AND o.synthetic = 0 AND o.ts + ? <= ? AND o.ts + ? + ? >= ? ORDER BY o.id`)
        .all(h, ms, now, ms, maxLateMs, now);
      for (const r of rows) out.push({ ...r, horizon: h });
    }
    return out;
  }

  /** @returns {number} 1 when written, 0 when it already existed */
  insertOutcome(o) {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO outcomes(observation_id, horizon, ts, price, liquidity_usd, ret_pct, status, hit) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(o.observationId, o.horizon, o.ts, o.price ?? null, o.liquidityUsd ?? null, o.retPct ?? null, o.status, o.hit ?? null);
    return r.changes;
  }

  outcomeRows({ horizon, since = 0 }) {
    return this.db
      .prepare(`SELECT o.id, o.ts, o.address, o.chain, o.symbol, o.verdict, o.light, o.price AS obs_price, o.synthetic, o.levels,
                       x.ret_pct, x.status, x.hit, x.price
                FROM observations o JOIN outcomes x ON x.observation_id = o.id
                WHERE x.horizon = ? AND o.ts >= ? ORDER BY o.id`)
      .all(horizon, since)
      .map((r) => ({ ...r, synthetic: !!r.synthetic }));
  }

  // --- shadow fills ---
  insertShadowFill(f) {
    const r = this.db
      .prepare('INSERT INTO shadow_fills(rule_id, subject_ref, ts, entry_price, entry_costs, executable_price, meta, outcome) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(f.ruleId, f.subjectRef, f.ts, f.entryPrice, f.entryCosts, f.executablePrice, JSON.stringify(f.meta ?? {}), 'open');
    return Number(r.lastInsertRowid);
  }

  listShadowFills({ ruleId = null } = {}) {
    return ruleId
      ? this.db.prepare('SELECT * FROM shadow_fills WHERE rule_id = ? ORDER BY id').all(ruleId)
      : this.db.prepare('SELECT * FROM shadow_fills ORDER BY id').all();
  }

  updateShadowMark(id, { markPrice, markTs, markSource, outcome, netValue }) {
    const row = this.db.prepare('SELECT meta FROM shadow_fills WHERE id = ?').get(id);
    const meta = { ...JSON.parse(row?.meta ?? '{}'), netValue };
    this.db
      .prepare('UPDATE shadow_fills SET mark_price = ?, mark_ts = ?, mark_source = ?, outcome = ?, meta = ? WHERE id = ?')
      .run(markPrice, markTs, markSource, outcome, JSON.stringify(meta), id);
  }

  // --- mute ---
  mute(subject, until) {
    this.db.prepare('INSERT INTO muted(subject, until) VALUES(?, ?) ON CONFLICT(subject) DO UPDATE SET until = excluded.until').run(String(subject).toLowerCase(), until);
  }

  isMuted(subject, now = Date.now()) {
    const r = this.db.prepare('SELECT until FROM muted WHERE subject = ?').get(String(subject).toLowerCase());
    return !!r && r.until > now;
  }
}
