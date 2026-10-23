// Auth hardening helpers: password policy, fixed-window rate limiting
// (SQLite-backed, no new dependencies), account lockout helpers,
// auth security event logging, and shared org seeding for new signups.
const { db } = require('./db');

// ---------------------------------------------------------------------------
// Password policy: min 8 chars + uppercase + lowercase + digit + symbol
// ---------------------------------------------------------------------------
function passwordIssues(pw) {
  const issues = [];
  const s = String(pw || '');
  if (s.length < 8) issues.push('at least 8 characters');
  if (!/[A-Z]/.test(s)) issues.push('an uppercase letter');
  if (!/[a-z]/.test(s)) issues.push('a lowercase letter');
  if (!/[0-9]/.test(s)) issues.push('a number');
  if (!/[^A-Za-z0-9]/.test(s)) issues.push('a symbol');
  return issues;
}

function passwordError(pw) {
  const issues = passwordIssues(pw);
  if (!issues.length) return null;
  return 'Password must include ' + issues.join(', ') + '.';
}

// ---------------------------------------------------------------------------
// Client IP (works behind the nginx reverse proxy)
// ---------------------------------------------------------------------------
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------------------
// Fixed-window rate limiter. Keyed by (rl_key, endpoint) in SQLite.
// ---------------------------------------------------------------------------
function rateLimit({ endpoint, limit, windowSec, keyFn, eventName }) {
  const windowMs = windowSec * 1000;
  return (req, res, next) => {
    try {
      const key = keyFn(req);
      if (!key) return next();
      const now = Date.now();
      // Opportunistic cleanup of expired buckets (cheap, keeps table small)
      db.prepare('DELETE FROM auth_rate_limits WHERE window_start_ms < ?')
        .run(now - windowMs);
      const row = db.prepare(
        'SELECT window_start_ms, count FROM auth_rate_limits WHERE rl_key = ? AND endpoint = ?'
      ).get(key, endpoint);
      if (!row || row.window_start_ms <= now - windowMs) {
        db.prepare(
          `INSERT OR REPLACE INTO auth_rate_limits (rl_key, endpoint, window_start_ms, count)
           VALUES (?, ?, ?, 1)`
        ).run(key, endpoint, now);
        return next();
      }
      if (row.count >= limit) {
        logAuthEvent({
          email: req.body?.email || null,
          ip: clientIp(req),
          event: eventName || 'rate_limited',
          detail: `${endpoint} (${limit}/${windowSec}s)`,
        });
        res.set('Retry-After', String(windowSec));
        return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
      }
      db.prepare('UPDATE auth_rate_limits SET count = count + 1 WHERE rl_key = ? AND endpoint = ?')
        .run(key, endpoint);
      return next();
    } catch (e) {
      // Rate limiting must never break auth — fail open with a log line
      console.error('rateLimit error:', e.message);
      return next();
    }
  };
}

// ---------------------------------------------------------------------------
// Auth security events (pre-auth; the HIPAA audit_log requires an org, so
// these live in their own table)
// ---------------------------------------------------------------------------
function logAuthEvent({ userId = null, email = null, ip = null, event, detail = null }) {
  try {
    db.prepare(
      `INSERT INTO auth_events (user_id, email, ip, event, detail) VALUES (?, ?, ?, ?, ?)`
    ).run(userId, email ? String(email).toLowerCase() : null, ip, event, detail);
  } catch (e) {
    console.error('logAuthEvent failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Account lockout
// ---------------------------------------------------------------------------
const LOCKOUT_THRESHOLD = 5;          // consecutive failures -> lock
const LOCKOUT_MINUTES = 15;

function isLocked(user) {
  if (!user || !user.locked_until) return false;
  // stored as 'YYYY-MM-DD HH:MM:SS' (UTC, from datetime('now'))
  return new Date(String(user.locked_until).replace(' ', 'T') + 'Z') > new Date();
}

function recordFailedLogin(user, ip) {
  const attempts = (user.failed_attempts || 0) + 1;
  if (attempts >= LOCKOUT_THRESHOLD) {
    db.prepare(
      `UPDATE users SET failed_attempts = ?, locked_until = datetime('now', '+${LOCKOUT_MINUTES} minutes') WHERE id = ?`
    ).run(attempts, user.id);
    logAuthEvent({ userId: user.id, email: user.email, ip, event: 'login_lockout', detail: `${attempts} consecutive failures` });
    return true; // now locked
  }
  db.prepare('UPDATE users SET failed_attempts = ? WHERE id = ?').run(attempts, user.id);
  logAuthEvent({ userId: user.id, email: user.email, ip, event: 'login_failed', detail: `attempt ${attempts}` });
  return false;
}

function resetLoginCounters(userId) {
  try {
    db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(userId);
  } catch (e) {
    console.error('resetLoginCounters failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Shared org seeding for new signups (password or Google)
// ---------------------------------------------------------------------------
const DEFAULT_PAYERS = [
  ['Aetna', 'Commercial', 120], ['Cigna', 'Commercial', 180], ['UnitedHealthcare', 'Commercial', 90],
  ['Anthem BCBS', 'Commercial', 180], ['Medicare', 'Government', 365], ['Medicaid', 'Government', 90],
  ['Humana', 'Commercial', 180], ['Self-Pay', 'Patient', 365],
];

function seedOrgDefaults(orgId) {
  const ins = db.prepare('INSERT INTO payers (org_id, name, type) VALUES (?, ?, ?)');
  const insRule = db.prepare('INSERT INTO payer_filing_rules (org_id, payer_id, filing_days) VALUES (?, ?, ?)');
  for (const [n, t, days] of DEFAULT_PAYERS) {
    const pid = Number(ins.run(orgId, n, t).lastInsertRowid);
    insRule.run(orgId, pid, days);
  }
}

module.exports = {
  passwordIssues,
  passwordError,
  clientIp,
  rateLimit,
  logAuthEvent,
  isLocked,
  recordFailedLogin,
  resetLoginCounters,
  seedOrgDefaults,
  LOCKOUT_THRESHOLD,
  LOCKOUT_MINUTES,
};
