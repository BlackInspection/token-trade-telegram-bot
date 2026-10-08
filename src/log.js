// Minimal leveled logger + secret masking.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let current = LEVELS.info;

export function setLogLevel(level) {
  current = LEVELS[level] ?? LEVELS.info;
}

function out(level, scope, args) {
  if (LEVELS[level] < current) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  const fn = level === 'error' || level === 'warn' ? console.error : console.log;
  fn(line, ...args);
}

/** @param {string} scope */
export function getLogger(scope) {
  return {
    debug: (...a) => out('debug', scope, a),
    info: (...a) => out('info', scope, a),
    warn: (...a) => out('warn', scope, a),
    error: (...a) => out('error', scope, a),
  };
}

/** Truncate a secret for logging: "abcd…wxyz". Never log full keys/tokens. */
export function mask(secret, keep = 4) {
  if (!secret) return '';
  const s = String(secret);
  if (s.length <= keep * 2 + 2) return '***';
  return `${s.slice(0, keep)}…${s.slice(-keep)}`;
}
