// Email-code MFA for Pulse RCM.
//
// Flow:
//   1. POST /api/auth/login  -> if user.mfa_enabled, returns { mfaRequired, mfaToken }
//      (mfaToken = short-lived JWT proving "password was correct", NOT a session)
//   2. POST /api/auth/mfa/verify { mfaToken, code } -> full session JWT on success
//   3. POST /api/auth/mfa/resend { mfaToken } -> new code (rate-limited)
// Enrollment: POST /api/auth/mfa/enable (authed) sends a code; verify it to activate.
// Disable:    POST /api/auth/mfa/disable (authed, password confirmed).

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const { sendMfaCode } = require('./email');
const { authRequired } = require('./auth');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const CODE_TTL_MIN = 10;
const MFA_TOKEN_TTL = '10m';
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SEC = 60;

function ensureSchema() {
  db.exec(`ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS mfa_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      used INTEGER NOT NULL DEFAULT 0,
      purpose TEXT NOT NULL DEFAULT 'login',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mfa_user ON mfa_codes(user_id);
  `);
}
// ALTER TABLE fails if column exists — ignore that specific error
try { ensureSchema(); } catch (e) {
  if (!/duplicate column name/i.test(e.message)) throw e;
  db.exec(`CREATE TABLE IF NOT EXISTS mfa_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
    code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    used INTEGER NOT NULL DEFAULT 0, purpose TEXT NOT NULL DEFAULT 'login',
    created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mfa_user ON mfa_codes(user_id);`);
}

function issueMfaToken(userId) {
  return jwt.sign({ sub: userId, mfa: true }, JWT_SECRET, { expiresIn: MFA_TOKEN_TTL });
}

function verifyMfaToken(token) {
  try {
    const p = jwt.verify(token, JWT_SECRET);
    return p.mfa === true ? p.sub : null;
  } catch {
    return null;
  }
}

async function issueCode(userId, purpose = 'login') {
  // Invalidate any outstanding codes for this purpose
  db.prepare(`UPDATE mfa_codes SET used = 1 WHERE user_id = ? AND purpose = ? AND used = 0`).run(userId, purpose);

  const code = String(crypto.randomInt(100000, 1000000)); // 6 digits
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  db.prepare(`
    INSERT INTO mfa_codes (user_id, code_hash, expires_at, purpose)
    VALUES (?, ?, datetime('now', '+${CODE_TTL_MIN} minutes'), ?)
  `).run(userId, codeHash, purpose);

  const user = db.prepare('SELECT email, name FROM users WHERE id = ?').get(userId);
  await sendMfaCode(user.email, code, user.name);
  return true;
}

function checkCode(userId, code, purpose = 'login') {
  const row = db.prepare(`
    SELECT * FROM mfa_codes
    WHERE user_id = ? AND purpose = ? AND used = 0
    ORDER BY id DESC LIMIT 1
  `).get(userId, purpose);
  if (!row) return { ok: false, error: 'No active code. Request a new one.' };
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('UPDATE mfa_codes SET used = 1 WHERE id = ?').run(row.id);
    return { ok: false, error: 'Code expired. Request a new one.' };
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    db.prepare('UPDATE mfa_codes SET used = 1 WHERE id = ?').run(row.id);
    return { ok: false, error: 'Too many attempts. Request a new code.' };
  }
  const hash = crypto.createHash('sha256').update(String(code).trim()).digest('hex');
  if (hash !== row.code_hash) {
    db.prepare('UPDATE mfa_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    const left = MAX_ATTEMPTS - row.attempts - 1;
    return { ok: false, error: `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` };
  }
  db.prepare('UPDATE mfa_codes SET used = 1 WHERE id = ?').run(row.id);
  return { ok: true };
}

function lastCodeAt(userId, purpose = 'login') {
  const row = db.prepare(`
    SELECT created_at FROM mfa_codes
    WHERE user_id = ? AND purpose = ? ORDER BY id DESC LIMIT 1
  `).get(userId, purpose);
  return row ? new Date(row.created_at) : null;
}

function registerRoutes(app, issueSession) {
  // --- Verify MFA code -> full session ---
  app.post('/api/auth/mfa/verify', async (req, res) => {
    const { mfaToken, code, purpose } = req.body || {};
    const userId = mfaToken ? verifyMfaToken(mfaToken) : null;
    if (!userId) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    if (!code) return res.status(400).json({ error: 'Verification code is required' });

    const result = checkCode(userId, code, purpose === 'enroll' ? 'enroll' : 'login');
    if (!result.ok) return res.status(401).json({ error: result.error });

    if (purpose === 'enroll') {
      db.prepare('UPDATE users SET mfa_enabled = 1 WHERE id = ?').run(userId);
      return res.json({ enrolled: true, message: 'Two-factor authentication is now on.' });
    }

    // Full login session
    const user = db.prepare('SELECT id, org_id, name, email, role, mfa_enabled FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(401).json({ error: 'Account not found' });
    res.json(issueSession(user));
  });

  // --- Resend code (rate-limited) ---
  app.post('/api/auth/mfa/resend', async (req, res) => {
    const { mfaToken, purpose } = req.body || {};
    const userId = mfaToken ? verifyMfaToken(mfaToken) : null;
    if (!userId) return res.status(401).json({ error: 'Session expired. Please sign in again.' });

    const last = lastCodeAt(userId, purpose === 'enroll' ? 'enroll' : 'login');
    if (last && (Date.now() - last.getTime()) / 1000 < RESEND_COOLDOWN_SEC) {
      const wait = Math.ceil(RESEND_COOLDOWN_SEC - (Date.now() - last.getTime()) / 1000);
      return res.status(429).json({ error: `Please wait ${wait}s before requesting another code.` });
    }
    try {
      await issueCode(userId, purpose === 'enroll' ? 'enroll' : 'login');
      res.json({ sent: true, message: 'A new code is on its way.' });
    } catch (e) {
      res.status(500).json({ error: 'Could not send code. Please try again.' });
    }
  });

  // --- Enrollment: start (sends code to the signed-in user's email) ---
  app.post('/api/auth/mfa/enable', authRequired, async (req, res) => {
    if (req.user.mfa_enabled) return res.status(400).json({ error: 'Two-factor is already on.' });
    try {
      await issueCode(req.user.id, 'enroll');
      res.json({ mfaToken: issueMfaToken(req.user.id), sent: true, message: 'Code sent to your email.' });
    } catch (e) {
      res.status(500).json({ error: 'Could not send code. Please try again.' });
    }
  });

  // --- Disable (requires password confirmation) ---
  app.post('/api/auth/mfa/disable', authRequired, async (req, res) => {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Password is required to turn off two-factor.' });
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!bcrypt.compareSync(password, row.password_hash)) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }
    db.prepare('UPDATE users SET mfa_enabled = 0 WHERE id = ?').run(req.user.id);
    db.prepare('UPDATE mfa_codes SET used = 1 WHERE user_id = ? AND used = 0').run(req.user.id);
    res.json({ disabled: true, message: 'Two-factor authentication is now off.' });
  });

  // --- Status ---
  app.get('/api/auth/mfa/status', authRequired, (req, res) => {
    const row = db.prepare('SELECT mfa_enabled FROM users WHERE id = ?').get(req.user.id);
    res.json({ enabled: !!row.mfa_enabled });
  });
}

module.exports = { issueMfaToken, issueCode, registerRoutes };
