// Email-code MFA for Pulse RCM.
//
// Flow:
//   1. POST /api/auth/login  -> if user.mfa_enabled, returns { mfaRequired, mfaToken }
//      (mfaToken = short-lived JWT proving "password was correct", NOT a session)
//   2. POST /api/auth/mfa/verify { mfaToken, code } -> full session JWT on success
//   3. POST /api/auth/mfa/resend { mfaToken } -> new code (rate-limited)
// Enrollment: POST /api/auth/mfa/enable (authed) sends a code; verify it to activate.
// Disable:    POST /api/auth/mfa/disable (authed, password confirmed).
//
// Org-wide enforcement (workstream C): when orgs.mfa_required = 1, login /
// Google sign-in / org-switch return an org-enforce MFA step for members who
// are not MFA-enrolled (users.mfa_enabled = 0). The mfaToken carries an
// orgEnforce claim with the target org id; verifying with purpose
// 'org-enforce' ENROLLS the user (mfa_enabled = 1) and issues a session scoped
// to that org. No new enrollment column was needed — users.mfa_enabled doubles
// as the enrollment flag (design choice: smallest correct schema change).
// A mid-session safety net: POST /api/auth/mfa/org-challenge (authed) lets a
// member whose API calls are blocked by the authRequired MFA gate start the
// flow with their existing (restricted) session.

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

function issueMfaToken(userId, orgEnforceId = null) {
  return jwt.sign(
    { sub: userId, mfa: true, orgEnforce: orgEnforceId || null },
    JWT_SECRET,
    { expiresIn: MFA_TOKEN_TTL }
  );
}

function verifyMfaTokenPayload(token) {
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.mfa !== true) return null;
    return { userId: p.sub, orgEnforce: p.orgEnforce || null };
  } catch {
    return null;
  }
}

function verifyMfaToken(token) {
  const payload = token ? verifyMfaTokenPayload(token) : null;
  return payload ? payload.userId : null;
}

// 'org-enforce' = org-wide MFA enforcement challenge. Falls back to the token's
// orgEnforce claim so callers can omit purpose when the token already carries it.
function normalizePurpose(purpose, tokenOrgEnforce) {
  if (purpose === 'enroll') return 'enroll';
  if (purpose === 'org-enforce' || tokenOrgEnforce) return 'org-enforce';
  return 'login';
}

function validEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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
    const payload = mfaToken ? verifyMfaTokenPayload(mfaToken) : null;
    if (!payload) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    if (!code) return res.status(400).json({ error: 'Verification code is required' });

    const effPurpose = normalizePurpose(purpose, payload.orgEnforce);
    const result = checkCode(payload.userId, code, effPurpose);
    if (!result.ok) return res.status(401).json({ error: result.error });

    if (effPurpose === 'enroll') {
      db.prepare('UPDATE users SET mfa_enabled = 1 WHERE id = ?').run(payload.userId);
      return res.json({ enrolled: true, message: 'Two-factor authentication is now on.' });
    }

    // Org-enforced challenge: successful verification ENROLLS the user
    // (mfa_enabled = 1) and issues a session scoped to the enforced org —
    // which may differ from the user's home org (org-switch flow).
    if (effPurpose === 'org-enforce') {
      db.prepare('UPDATE users SET mfa_enabled = 1 WHERE id = ?').run(payload.userId);
      const orgId = payload.orgEnforce;
      const member = db.prepare(
        `SELECT u.id, u.email, u.name, m.role
         FROM user_orgs m JOIN users u ON u.id = m.user_id
         WHERE m.user_id = ? AND m.org_id = ?`
      ).get(payload.userId, orgId);
      if (!member) {
        return res.status(403).json({ error: 'You no longer belong to that workspace.' });
      }
      return res.json(issueSession(
        { id: member.id, email: member.email, name: member.name, role: member.role, org_id: orgId },
        orgId
      ));
    }

    // Full login session
    const user = db.prepare('SELECT id, org_id, name, email, role, mfa_enabled FROM users WHERE id = ?').get(payload.userId);
    if (!user) return res.status(401).json({ error: 'Account not found' });
    res.json(issueSession(user));
  });

  // --- Resend code (rate-limited) ---
  app.post('/api/auth/mfa/resend', async (req, res) => {
    const { mfaToken, purpose } = req.body || {};
    const payload = mfaToken ? verifyMfaTokenPayload(mfaToken) : null;
    if (!payload) return res.status(401).json({ error: 'Session expired. Please sign in again.' });

    const effPurpose = normalizePurpose(purpose, payload.orgEnforce);
    const last = lastCodeAt(payload.userId, effPurpose);
    if (last && (Date.now() - last.getTime()) / 1000 < RESEND_COOLDOWN_SEC) {
      const wait = Math.ceil(RESEND_COOLDOWN_SEC - (Date.now() - last.getTime()) / 1000);
      return res.status(429).json({ error: `Please wait ${wait}s before requesting another code.` });
    }
    try {
      await issueCode(payload.userId, effPurpose);
      res.json({ sent: true, message: 'A new code is on its way.' });
    } catch (e) {
      res.status(500).json({ error: 'Could not send code. Please try again.' });
    }
  });

  // --- Org-enforcement challenge for a signed-in (but API-blocked) member ---
  // authRequired's MFA gate exempts this path so a member whose session is
  // blocked by org enforcement can start the email-code flow. Verifying the
  // returned mfaToken (purpose 'org-enforce') enrolls them and issues a full
  // session for this org.
  app.post('/api/auth/mfa/org-challenge', authRequired, async (req, res) => {
    const org = db.prepare('SELECT id, name, mfa_required FROM orgs WHERE id = ?').get(req.orgId);
    const urow = db.prepare('SELECT mfa_enabled, is_superadmin, email FROM users WHERE id = ?').get(req.user.id);
    if (!org || !org.mfa_required || urow.mfa_enabled || urow.is_superadmin) {
      return res.status(400).json({ error: 'Two-factor enforcement is not required for your workspace right now.' });
    }
    if (!validEmail(urow.email)) {
      return res.status(422).json({
        error: 'No valid email is on file for your account. Ask your workspace owner to update your email address, then try again.',
      });
    }
    try {
      await issueCode(req.user.id, 'org-enforce');
      res.json({
        mfaToken: issueMfaToken(req.user.id, org.id),
        sent: true,
        orgName: org.name,
        message: 'Your organization requires two-factor authentication. A verification code was sent to your email.',
      });
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

// Returns true when the org enforces MFA and the user is not enrolled.
// Super-admins are exempt (their access must never be gated by org settings).
function orgMfaBlocksUser(orgId, userId) {
  const org = db.prepare('SELECT mfa_required FROM orgs WHERE id = ?').get(orgId);
  if (!org || org.mfa_required !== 1) return false;
  const u = db.prepare('SELECT mfa_enabled, is_superadmin FROM users WHERE id = ?').get(userId);
  if (!u) return false;
  return !u.mfa_enabled && !u.is_superadmin;
}

module.exports = { issueMfaToken, issueCode, registerRoutes, orgMfaBlocksUser, verifyMfaTokenPayload };
