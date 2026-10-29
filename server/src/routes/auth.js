const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { signToken, authRequired, roleRequired } = require('../auth');
const { checkSeatQuota, quotaExceeded } = require('../usage');
const account = require('../account');
const { limitsForPlan } = require('../config/planLimits');
const {
  passwordError,
  clientIp,
  rateLimit,
  logAuthEvent,
  isLocked,
  recordFailedLogin,
  resetLoginCounters,
  seedOrgDefaults,
} = require('../authSecurity');
const { verifyGoogleIdToken } = require('../googleAuth');

const router = express.Router();

// --- Rate limiters (fixed-window, SQLite-backed) ---
const loginIpLimit = rateLimit({
  endpoint: 'login', limit: 10, windowSec: 900,
  keyFn: (req) => `ip:${clientIp(req)}`, eventName: 'login_rate_limited',
});
const loginEmailLimit = rateLimit({
  endpoint: 'login_email', limit: 5, windowSec: 900,
  keyFn: (req) => (req.body && req.body.email ? `email:${String(req.body.email).trim().toLowerCase()}` : null),
  eventName: 'login_rate_limited',
});
const signupIpLimit = rateLimit({
  endpoint: 'signup', limit: 5, windowSec: 3600,
  keyFn: (req) => `ip:${clientIp(req)}`, eventName: 'signup_rate_limited',
});
const forgotIpLimit = rateLimit({
  endpoint: 'password_forgot', limit: 5, windowSec: 3600,
  keyFn: (req) => `ip:${clientIp(req)}`, eventName: 'forgot_rate_limited',
});
const googleIpLimit = rateLimit({
  endpoint: 'google', limit: 10, windowSec: 900,
  keyFn: (req) => `ip:${clientIp(req)}`, eventName: 'google_rate_limited',
});

// Shared login response (token + safe user shape)
function buildLoginResponse(user) {
  // Super-admin bootstrap: the configured email is promoted on every login
  // (case-insensitive). Reads SUPERADMIN_EMAIL at request time.
  const superEmail = (process.env.SUPERADMIN_EMAIL || '').trim().toLowerCase();
  if (superEmail && user.email && user.email.toLowerCase() === superEmail && !user.is_superadmin) {
    db.prepare('UPDATE users SET is_superadmin = 1 WHERE id = ?').run(user.id);
    user.is_superadmin = 1;
  }

  // Heal a stale home-org pointer: if the user's org_id is not one of their
  // memberships (their workspace was deleted), re-point to the first
  // remaining workspace so the issued token actually works. Org-less users
  // keep the stale pointer; the auth middleware routes them to workspace
  // creation instead of a dead session.
  const home = db.prepare('SELECT org_id, role FROM user_orgs WHERE user_id = ? AND org_id = ?').get(user.id, user.org_id);
  if (!home) {
    const first = db.prepare('SELECT org_id, role FROM user_orgs WHERE user_id = ? ORDER BY org_id LIMIT 1').get(user.id);
    if (first) {
      db.prepare('UPDATE users SET org_id = ? WHERE id = ?').run(first.org_id, user.id);
      user.org_id = first.org_id;
      user.role = first.role;
    }
  }

  const safe = { id: user.id, org_id: user.org_id, email: user.email, name: user.name, role: user.role, is_superadmin: user.is_superadmin ? 1 : 0,
    phone: user.phone || '', title: user.title || '', email_verified: user.email_verified ? 1 : 0,
    has_avatar: !!user.avatar_blob, auth_provider: user.password_hash === 'google-sso' ? 'google' : 'password', created_at: user.created_at };
  const org = db.prepare('SELECT name FROM orgs WHERE id = ?').get(user.org_id);
  return { token: signToken(safe), user: { ...safe, orgName: org ? org.name : '' } };
}

// --- Sign up: creates org + owner user ---
router.post('/signup', signupIpLimit, (req, res) => {
  const { orgName, name, email, password, plan } = req.body || {};
  if (!orgName || !name || !email || !password) {
    return res.status(400).json({ error: 'Organization name, name, email and password are required' });
  }
  const pwErr = passwordError(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }
  // Optional plan intent (e.g. 'ai' for ClaimPaid AI signups) — sets the org's
  // plan up front so product gating applies from the first login (trialing).
  const { PLANS } = require('./billing');
  const planKey = plan && PLANS[plan] ? plan : null;

  const existing = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(email.trim());
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

  const orgId = Number(db.prepare('INSERT INTO orgs (name, plan) VALUES (?, ?)').run(orgName.trim(), planKey).lastInsertRowid);
  const hash = bcrypt.hashSync(password, 10);
  const userId = Number(
    db.prepare('INSERT INTO users (org_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)')
      .run(orgId, email.trim().toLowerCase(), hash, name.trim(), 'owner').lastInsertRowid
  );
  db.prepare('INSERT OR IGNORE INTO user_orgs (user_id, org_id, role) VALUES (?, ?, ?)')
    .run(userId, orgId, 'owner');

  // Seed default payers + filing rules for the new org
  seedOrgDefaults(orgId);

  const user = db.prepare('SELECT id, org_id, email, name, role FROM users WHERE id = ?').get(userId);
  res.status(201).json({ token: signToken(user), user });
});

// Shared MFA step for password login + Google sign-in.
// Returns null when no second factor is needed; otherwise the mfa-step body.
// When the ORG enforces MFA (orgs.mfa_required = 1) and the user is not enrolled
// (users.mfa_enabled = 0), the step is an 'org-enforce' challenge: verifying it
// enrolls the user and issues the session for this org.
async function maybeMfaStep(user) {
  const { issueMfaToken, issueCode, orgMfaBlocksUser } = require('../mfa');
  const enforced = orgMfaBlocksUser(user.org_id, user.id);
  if (!user.mfa_enabled && !enforced) return null;

  if (enforced && (!user.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email))) {
    return {
      noEmail: true,
      error: 'Your organization requires two-factor authentication, but no valid email is on file for your account. Ask your workspace owner to update your email address, then sign in again.',
    };
  }
  const purpose = enforced ? 'org-enforce' : 'login';
  await issueCode(user.id, purpose);
  return {
    mfaRequired: true,
    mfaToken: issueMfaToken(user.id, enforced ? user.org_id : null),
    orgEnforced: enforced,
    message: enforced
      ? 'Your organization requires two-factor authentication. A verification code was sent to your email.'
      : 'A verification code was sent to your email.',
  };
}

// --- Login ---
router.post('/login', loginIpLimit, loginEmailLimit, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const ip = clientIp(req);

  const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(email.trim());
  if (user && isLocked(user)) {
    logAuthEvent({ userId: user.id, email: user.email, ip, event: 'login_lockout_attempt' });
    return res.status(423).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }

  // Google-SSO accounts have no password — never let bcrypt touch the marker
  const passwordOk = user && user.password_hash !== 'google-sso'
    && bcrypt.compareSync(password, user.password_hash);
  if (!passwordOk) {
    if (user) {
      const nowLocked = recordFailedLogin(user, ip);
      if (nowLocked) {
        return res.status(423).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
      }
    }
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  resetLoginCounters(user.id);

  // MFA: password was correct, but a second factor is required —
  // either the user opted in (mfa_enabled) or their org enforces it.
  try {
    const step = await maybeMfaStep(user);
    if (step) {
      if (step.noEmail) return res.status(403).json({ error: step.error });
      return res.json(step);
    }
  } catch (e) {
    return res.status(500).json({ error: 'Could not send verification code. Please try again.' });
  }

  res.json(buildLoginResponse(user));
});

// --- Google sign-in (Google Identity Services ID-token flow) ---
router.post('/google', googleIpLimit, async (req, res) => {
  const { idToken: rawToken } = req.body || {};
  const idToken = typeof rawToken === 'string' ? rawToken.trim() : rawToken;
  if (!idToken) return res.status(400).json({ error: 'Google token is required' });
  const ip = clientIp(req);

  let claims;
  try {
    claims = await verifyGoogleIdToken(idToken);
  } catch (e) {
    logAuthEvent({ ip, event: 'google_failed', detail: e.message });
    return res.status(e.status || 401).json({ error: e.message || 'Google sign-in failed' });
  }

  const email = String(claims.email).trim().toLowerCase();
  let user = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(email);

  if (!user) {
    // New Google user: create their workspace + owner account
    const given = claims.given_name || String(claims.name || '').split(' ')[0] || email.split('@')[0];
    const orgName = `${given}'s Workspace`;
    const orgId = Number(db.prepare('INSERT INTO orgs (name) VALUES (?)').run(orgName).lastInsertRowid);
    const userId = Number(
      db.prepare(`INSERT INTO users (org_id, email, password_hash, name, role, email_verified)
                  VALUES (?, ?, 'google-sso', ?, 'owner', 1)`)
        .run(orgId, email, String(claims.name || email).trim()).lastInsertRowid
    );
    db.prepare('INSERT OR IGNORE INTO user_orgs (user_id, org_id, role) VALUES (?, ?, ?)')
      .run(userId, orgId, 'owner');
    seedOrgDefaults(orgId);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    logAuthEvent({ userId, email, ip, event: 'google_signup' });
  } else {
    // Existing account: Google verified the email, so sign-in is allowed even
    // if the account was originally created with a password — but log it.
    logAuthEvent({
      userId: user.id, email, ip,
      event: user.password_hash === 'google-sso' ? 'google_login' : 'google_login_password_account',
    });
    resetLoginCounters(user.id);
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(user.id);
    user.email_verified = 1;
  }

  if (isLocked(user)) {
    return res.status(423).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }

  // MFA: honor it for Google sign-ins too — user opt-in or org enforcement
  try {
    const step = await maybeMfaStep(user);
    if (step) {
      if (step.noEmail) return res.status(403).json({ error: step.error });
      return res.json(step);
    }
  } catch (e) {
    return res.status(500).json({ error: 'Could not send verification code. Please try again.' });
  }

  res.json(buildLoginResponse(user));
});

// --- Current user ---
function mePayload(userId, orgId) {
  const u = db.prepare(
    `SELECT id, org_id, email, name, role, phone, title, email_verified, created_at,
            is_superadmin, password_hash, (avatar_blob IS NOT NULL) AS has_avatar
     FROM users WHERE id = ?`).get(userId);
  if (!u) return null;
  const org = db.prepare('SELECT name FROM orgs WHERE id = ?').get(orgId || u.org_id);
  return {
    id: u.id, org_id: orgId || u.org_id, email: u.email, name: u.name, role: u.role,
    phone: u.phone || '', title: u.title || '',
    email_verified: u.email_verified ? 1 : 0, created_at: u.created_at,
    orgName: org ? org.name : '',
    is_superadmin: u.is_superadmin === 1 ? 1 : 0,
    has_avatar: !!u.has_avatar,
    auth_provider: u.password_hash === 'google-sso' ? 'google' : 'password',
  };
}

router.get('/me', authRequired, (req, res) => {
  const out = mePayload(req.user.id, req.orgId);
  if (!out) return res.status(404).json({ error: 'User not found' });
  res.json(out);
});

// --- Update profile (name / title / phone) ---
router.patch('/me', authRequired, (req, res) => {
  const { name, title, phone } = req.body || {};
  const updates = [], params = [];
  if (name !== undefined) {
    const n = String(name).trim();
    if (n.length < 1 || n.length > 80) return res.status(400).json({ error: 'Name must be 1–80 characters.' });
    updates.push('name = ?'); params.push(n);
  }
  if (title !== undefined) {
    const t = String(title).trim().slice(0, 80);
    updates.push('title = ?'); params.push(t || null);
  }
  if (phone !== undefined) {
    const ph = String(phone).trim().slice(0, 32);
    updates.push('phone = ?'); params.push(ph || null);
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update.' });
  params.push(req.user.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(mePayload(req.user.id, req.orgId));
});

// --- Profile photo (client sends a downscaled data URL; stored in the DB
// so it survives deploys and rides the encrypted backups) ---
router.post('/me/avatar', authRequired, (req, res) => {
  const { dataUrl } = req.body || {};
  const m = typeof dataUrl === 'string' && dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return res.status(400).json({ error: 'Please upload a PNG, JPG or WebP image.' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 100 || buf.length > 300 * 1024) {
    return res.status(400).json({ error: 'Image must be between 1 KB and 300 KB after resizing.' });
  }
  db.prepare('UPDATE users SET avatar_mime = ?, avatar_blob = ? WHERE id = ?').run(m[1], buf, req.user.id);
  res.json({ ok: true, has_avatar: true });
});

router.delete('/me/avatar', authRequired, (req, res) => {
  db.prepare('UPDATE users SET avatar_mime = NULL, avatar_blob = NULL WHERE id = ?').run(req.user.id);
  res.json({ ok: true, has_avatar: false });
});

// --- Serve a user's avatar: self, same-workspace members, super-admin ---
router.get('/avatar/:userId', authRequired, (req, res) => {
  const target = Number(req.params.userId);
  if (target !== req.user.id && !req.isSuperAdmin) {
    const shared = db.prepare(
      `SELECT 1 FROM user_orgs a JOIN user_orgs b ON a.org_id = b.org_id
       WHERE a.user_id = ? AND b.user_id = ? LIMIT 1`).get(req.user.id, target);
    if (!shared) return res.status(404).json({ error: 'No avatar' });
  }
  const row = db.prepare('SELECT avatar_mime, avatar_blob FROM users WHERE id = ?').get(target);
  if (!row || !row.avatar_blob) return res.status(404).json({ error: 'No avatar' });
  res.setHeader('Content-Type', row.avatar_mime || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=300');
  // node:sqlite returns BLOBs as Uint8Array — Express would JSON-encode
  // that instead of sending bytes; wrap it as a Buffer first.
  res.send(Buffer.from(row.avatar_blob));
});

// --- Change password (kills every other session; this one is re-issued) ---
router.post('/change-password', authRequired, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.password_hash === 'google-sso') {
    return res.status(400).json({ error: 'This account signs in with Google — there is no password to change.' });
  }
  if (!currentPassword || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(400).json({ error: 'Your current password is incorrect.' });
  }
  const policyError = passwordError(newPassword || '');
  if (policyError) return res.status(400).json({ error: policyError });
  db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?')
    .run(bcrypt.hashSync(newPassword, 10), user.id);
  resetLoginCounters(user.id);
  logAuthEvent({ userId: user.id, email: user.email, ip: clientIp(req), event: 'password_changed' });
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json({ ok: true, token: signToken({ ...fresh, org_id: req.orgId }) });
});

// --- Log out everywhere (kills every other session; this one is re-issued) ---
router.post('/logout-all', authRequired, (req, res) => {
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(req.user.id);
  logAuthEvent({ userId: req.user.id, email: req.user.email, ip: clientIp(req), event: 'logout_all' });
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ ok: true, token: signToken({ ...fresh, org_id: req.orgId }) });
});

// --- Password reset: request ---
router.post('/password/forgot', forgotIpLimit, async (req, res) => {
  const { email } = req.body || {};
  // Always return success to prevent email enumeration
  const done = () => res.json({ sent: true, message: 'If an account exists for that email, a reset link is on its way.' });
  if (!email) return done();

  const user = db.prepare('SELECT id, email, name FROM users WHERE LOWER(email) = LOWER(?)').get(email.trim());
  if (!user) return done();

  // Invalidate old tokens
  db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0').run(user.id);

  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare(`
    INSERT INTO password_resets (user_id, token_hash, expires_at)
    VALUES (?, ?, datetime('now', '+1 hour'))
  `).run(user.id, tokenHash);

  const base = process.env.APP_URL || 'http://localhost:4000/app';
  const resetUrl = `${base}/reset-password?token=${token}`;
  try {
    const { sendPasswordReset } = require('../email');
    await sendPasswordReset(user.email, resetUrl, user.name);
  } catch (e) {
    console.error('Password reset email failed:', e.message);
  }
  return done();
});

// --- Password reset: complete ---
router.post('/password/reset', (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Token and new password are required' });
  const pwErr = passwordError(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const crypto = require('crypto');
  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
  const row = db.prepare(`
    SELECT * FROM password_resets WHERE token_hash = ? AND used = 0
  `).get(tokenHash);
  if (!row) return res.status(400).json({ error: 'Invalid or expired reset link.' });
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(row.id);
    return res.status(400).json({ error: 'This reset link has expired. Request a new one.' });
  }

  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, row.user_id);
  db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(row.id);
  // Kill any outstanding MFA codes too
  db.prepare('UPDATE mfa_codes SET used = 1 WHERE user_id = ? AND used = 0').run(row.user_id);
  res.json({ reset: true, message: 'Password updated. You can now sign in.' });
});

// --- Team management (owner only) ---
// Team = members of the current workspace (roles are per-workspace via user_orgs)
router.get('/team', authRequired, (req, res) => {
  const users = db.prepare(
    `SELECT u.id, u.email, u.name, m.role, u.created_at, (u.avatar_blob IS NOT NULL) AS has_avatar
     FROM user_orgs m JOIN users u ON u.id = m.user_id
     WHERE m.org_id = ? ORDER BY u.created_at`
  ).all(req.orgId);
  res.json(users);
});

router.post('/team', authRequired, roleRequired('owner'), checkSeatQuota, (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required' });
  if (!['owner', 'biller', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

  // Seat cap (deploy #100): seats are UNIQUE PEOPLE on the account roster.
  // Inviting someone already on the roster into another workspace consumes
  // NO seat and is never blocked; only a brand-new person at the roster cap
  // is. (The checkSeatQuota middleware 402s that case first with the
  // plan-limit shape; this route check is the backstop.)
  const { seatUsage } = require('../config/planLimits');
  const seats = seatUsage(db, req.orgId);
  const holderId = account.ownerOfOrg(req.orgId);
  const existing = db.prepare('SELECT id, name FROM users WHERE LOWER(email) = LOWER(?)').get(email.trim());
  const already = existing && db.prepare('SELECT 1 FROM user_orgs WHERE user_id = ? AND org_id = ?').get(existing.id, req.orgId);
  const onRoster = !!(existing && holderId && account.rosterUserIds(holderId).includes(existing.id));
  if (!onRoster && seats.atCap) {
    const planLabel = { starter: 'Starter', pro: 'Pro', ai: 'AI', enterprise: 'Enterprise' }[seats.plan] || seats.plan;
    return res.status(403).json({
      error: `Seat limit reached — ${seats.used} of ${seats.limit} seats used on the ${planLabel} plan. Remove a team member or upgrade your plan to invite more people.`,
      seats,
    });
  }
  if (existing) {
    // Existing ClaimPaid user: just add them to this workspace (no new password needed)
    if (already) return res.status(409).json({ error: 'This person is already in this workspace' });
    db.prepare('INSERT INTO user_orgs (user_id, org_id, role) VALUES (?, ?, ?)')
      .run(existing.id, req.orgId, role);
    // Share-team ON: a roster member joins every account workspace.
    if (holderId && account.shareTeamEnabled(holderId)) {
      account.addUserToAllAccountOrgs(holderId, existing.id, role);
    }
    return res.status(201).json({ id: existing.id, email: email.trim().toLowerCase(), name: existing.name, role, addedToWorkspace: true });
  }

  if (!name || !password) return res.status(400).json({ error: 'Name and password are required for a new user' });
  const pwErr = passwordError(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const hash = bcrypt.hashSync(password, 10);
  const id = Number(
    db.prepare('INSERT INTO users (org_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)')
      .run(req.orgId, email.trim().toLowerCase(), hash, name.trim(), role).lastInsertRowid
  );
  db.prepare('INSERT OR IGNORE INTO user_orgs (user_id, org_id, role) VALUES (?, ?, ?)')
    .run(id, req.orgId, role);
  // Share-team ON: a new invite joins every account workspace.
  if (holderId && account.shareTeamEnabled(holderId)) {
    account.addUserToAllAccountOrgs(holderId, id, role);
  }
  res.status(201).json(db.prepare('SELECT id, email, name, role, created_at FROM users WHERE id = ?').get(id));
});

router.put('/team/:id', authRequired, roleRequired('owner'), (req, res) => {
  const member = db.prepare('SELECT * FROM user_orgs WHERE user_id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!member) return res.status(404).json({ error: 'User not found in this workspace' });
  if (member.user_id === req.user.id) return res.status(400).json({ error: 'You cannot change your own role' });
  if (!['owner', 'biller', 'viewer'].includes(req.body.role)) return res.status(400).json({ error: 'Invalid role' });

  db.prepare('UPDATE user_orgs SET role = ? WHERE user_id = ? AND org_id = ?')
    .run(req.body.role, member.user_id, req.orgId);
  // Keep home-org role in sync
  db.prepare('UPDATE users SET role = ? WHERE id = ? AND org_id = ?')
    .run(req.body.role, member.user_id, req.orgId);
  res.json(db.prepare(
    `SELECT u.id, u.email, u.name, m.role, u.created_at
     FROM user_orgs m JOIN users u ON u.id = m.user_id
     WHERE m.user_id = ? AND m.org_id = ?`, ).get(member.user_id, req.orgId));
});

router.delete('/team/:id', authRequired, roleRequired('owner'), (req, res) => {
  const member = db.prepare('SELECT * FROM user_orgs WHERE user_id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!member) return res.status(404).json({ error: 'User not found in this workspace' });
  if (member.user_id === req.user.id) return res.status(400).json({ error: 'You cannot remove yourself' });

  // Unassign their appeals in this workspace
  db.prepare('UPDATE appeals SET assigned_to = NULL WHERE assigned_to = ? AND org_id = ?').run(member.user_id, req.orgId);
  db.prepare('DELETE FROM user_orgs WHERE user_id = ? AND org_id = ?').run(member.user_id, req.orgId);
  // Deploy #100 (account model): removing a member from a workspace never
  // deletes their login. If it was their last workspace they stay a user
  // with no workspace and land on the org-less flow (deploy #59). Logins
  // are deleted only through the explicit super-admin user delete, which
  // uses orgDelete.purgeUser.
  res.json({ deleted: true });
});

// --- Account team (deploy #100) ---
// The roster lives at ACCOUNT level: the caller must be an account holder
// (owns at least one workspace). A member who owns nothing manages nothing
// here — their Team page keeps the per-workspace list.
function accountTeamPayload(userId) {
  const { seatUsage } = require('../config/planLimits');
  const orgIds = account.orgIdsOwnedBy(userId);
  const planOrg = account.planOfRecordOrg(orgIds);
  const { orgs, members } = account.rosterForOwner(userId);
  const nameById = new Map(orgs.map((o) => [o.id, o.name]));
  return {
    plan: planOrg ? planOrg.plan : null,
    plan_status: planOrg ? planOrg.plan_status : null,
    share_team: account.shareTeamEnabled(userId),
    seats: planOrg ? seatUsage(db, planOrg.id) : { used: members.length, limit: null, plan: null, atCap: false },
    workspaces: account.workspaceUsage(userId, planOrg ? planOrg.plan : null),
    orgs,
    members: members.map((m) => ({
      ...m,
      workspaces: m.workspaces.map((w) => ({ ...w, name: nameById.get(w.org_id) || `Workspace ${w.org_id}` })),
    })),
  };
}

function requireAccountHolder(req, res, next) {
  if (!account.orgIdsOwnedBy(req.user.id).length) {
    return res.status(403).json({ error: 'The account team is managed by the account owner.' });
  }
  return next();
}

router.get('/account/team', authRequired, requireAccountHolder, (req, res) => {
  res.json(accountTeamPayload(req.user.id));
});

// Grant a person access to one of the account's workspaces. Granting an
// existing roster member consumes no seat; granting a NEW person at the
// roster cap is blocked with the plan-limit (402) shape.
router.post('/account/team/access', authRequired, requireAccountHolder, (req, res) => {
  const { user_id, org_id, role } = req.body || {};
  const uid = Number(user_id); const oid = Number(org_id);
  if (!Number.isInteger(uid) || !Number.isInteger(oid)) {
    return res.status(400).json({ error: 'user_id and org_id are required' });
  }
  if (!account.orgIdsOwnedBy(req.user.id).includes(oid)) {
    return res.status(404).json({ error: 'Workspace not found in your account' });
  }
  const target = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(uid);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const existingMembership = db.prepare('SELECT role FROM user_orgs WHERE user_id = ? AND org_id = ?').get(uid, oid);
  if (existingMembership) return res.json({ ok: true, already: true, member: account.rosterForOwner(req.user.id).members.find((m) => m.id === uid) || null });

  const onRoster = account.rosterUserIds(req.user.id).includes(uid);
  if (!onRoster) {
    const { seatUsage } = require('../config/planLimits');
    const planOrg = account.planOfRecordOrg(account.orgIdsOwnedBy(req.user.id));
    const seats = planOrg ? seatUsage(db, planOrg.id) : { used: 0, limit: null, atCap: false };
    if (seats.atCap) return quotaExceeded(res, 'seat_limit_reached', seats.plan, seats.limit, seats.used);
  }
  const grantRole = uid === req.user.id
    ? 'owner'
    : (['owner', 'biller', 'viewer'].includes(role) ? role : account.resolvedRoleFor(req.user.id, uid));
  account.addUserToOrg(uid, oid, grantRole);
  const member = account.rosterForOwner(req.user.id).members.find((m) => m.id === uid) || null;
  return res.status(201).json({ ok: true, member });
});

// Revoke a person's access to ONE workspace of the account. The account
// holder themself can never be revoked. The user is NEVER deleted: losing
// their last membership leaves them workspace-less (org-less flow, #59).
router.post('/account/team/access/revoke', authRequired, requireAccountHolder, (req, res) => {
  const { user_id, org_id } = req.body || {};
  const uid = Number(user_id); const oid = Number(org_id);
  if (!Number.isInteger(uid) || !Number.isInteger(oid)) {
    return res.status(400).json({ error: 'user_id and org_id are required' });
  }
  if (uid === req.user.id) return res.status(400).json({ error: 'You cannot revoke your own access' });
  if (!account.orgIdsOwnedBy(req.user.id).includes(oid)) {
    return res.status(404).json({ error: 'Workspace not found in your account' });
  }
  const membership = db.prepare('SELECT role FROM user_orgs WHERE user_id = ? AND org_id = ?').get(uid, oid);
  if (!membership) return res.status(404).json({ error: 'That person is not a member of this workspace' });
  db.prepare('UPDATE appeals SET assigned_to = NULL WHERE assigned_to = ? AND org_id = ?').run(uid, oid);
  db.prepare('DELETE FROM user_orgs WHERE user_id = ? AND org_id = ?').run(uid, oid);
  const member = account.rosterForOwner(req.user.id).members.find((m) => m.id === uid) || null;
  return res.json({ ok: true, member });
});

// "Share team across workspaces" switch. Turning it ON backfills the whole
// roster into every account workspace; turning it OFF revokes nothing —
// propagation simply stops.
router.put('/account/team/share', authRequired, requireAccountHolder, (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  account.setShareTeam(req.user.id, enabled);
  if (enabled) account.backfillRoster(req.user.id);
  res.json(accountTeamPayload(req.user.id));
});

// --- Workspaces (multi-tenant switching) ---
// List workspaces the current user belongs to
router.get('/orgs', authRequired, (req, res) => {
  const orgs = db.prepare(
    `SELECT o.id, o.name, m.role, o.created_at
     FROM user_orgs m JOIN orgs o ON o.id = m.org_id
     WHERE m.user_id = ? ORDER BY o.name`
  ).all(req.user.id);
  res.json(orgs);
});

// Create a new workspace (seeds default payers + filing rules).
// Deploy #100 (account model): the workspace belongs to the CREATOR's
// account. The account's workspace limit gates creation ONLY (accounts
// already over the limit keep everything — grandfathered). The new
// workspace INHERITS the account plan + trial window from the account's
// plan-of-record workspace; no plan is ever chosen per workspace.
router.post('/orgs', authRequired, (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Workspace name is required' });

  const ownedIds = account.orgIdsOwnedBy(req.user.id);
  const planOrg = account.planOfRecordOrg(ownedIds);
  const inherit = planOrg ? account.planFieldsOf(planOrg) : null;

  if (planOrg && !req.isSuperAdmin) {
    const ws = account.workspaceUsage(req.user.id, planOrg.plan);
    if (ws.limit !== null && ws.used >= ws.limit) {
      const planLabel = { starter: 'RCM Starter', pro: 'RCM Pro + AI', ai: 'ClaimPaid AI', enterprise: 'Enterprise' }[planOrg.plan] || 'your';
      return res.status(403).json({
        error: `Workspace limit reached — ${ws.used} of ${ws.limit} workspaces used on the ${planLabel} plan. Upgrade your plan to add another workspace.`,
        code: 'WORKSPACE_LIMIT',
        plan: planOrg.plan,
        workspaces: ws,
        upgrade: '/app/billing',
      });
    }
  }

  const orgId = inherit
    ? Number(db.prepare(
      'INSERT INTO orgs (name, plan, plan_status, trial_started_at, trial_ends_at) VALUES (?, ?, ?, ?, ?)',
    ).run(name.trim(), inherit.plan, inherit.plan_status, inherit.trial_started_at, inherit.trial_ends_at).lastInsertRowid)
    : Number(db.prepare('INSERT INTO orgs (name) VALUES (?)').run(name.trim()).lastInsertRowid);
  db.prepare('INSERT INTO user_orgs (user_id, org_id, role) VALUES (?, ?, ?)')
    .run(req.user.id, orgId, 'owner');

  // Share-team ON: the whole account roster joins the new workspace.
  if (account.shareTeamEnabled(req.user.id)) account.addRosterToOrg(req.user.id, orgId);

  const defaultPayers = [
    ['Aetna', 'Commercial', 120], ['Cigna', 'Commercial', 180], ['UnitedHealthcare', 'Commercial', 90],
    ['Anthem BCBS', 'Commercial', 180], ['Medicare', 'Government', 365], ['Medicaid', 'Government', 90],
    ['Humana', 'Commercial', 180], ['Self-Pay', 'Patient', 365],
  ];
  const ins = db.prepare('INSERT INTO payers (org_id, name, type) VALUES (?, ?, ?)');
  const insRule = db.prepare('INSERT INTO payer_filing_rules (org_id, payer_id, filing_days) VALUES (?, ?, ?)');
  for (const [n, t, days] of defaultPayers) {
    const pid = Number(ins.run(orgId, n, t).lastInsertRowid);
    insRule.run(orgId, pid, days);
  }

  res.status(201).json({ id: orgId, name: name.trim(), role: 'owner', plan: inherit ? inherit.plan : null });
});

// Delete a workspace permanently (owner of that workspace only).
// Deletes ALL org data: claims, appeals, auths, payers, rules, memberships, etc.
router.delete('/orgs/:id', authRequired, (req, res) => {
  const orgId = Number(req.params.id);
  const member = db.prepare('SELECT role FROM user_orgs WHERE user_id = ? AND org_id = ?')
    .get(req.user.id, orgId);
  if (!member) return res.status(404).json({ error: 'Workspace not found' });
  if (member.role !== 'owner') return res.status(403).json({ error: 'Only workspace owners can delete it' });

  // FK-safe wipe via shared helper (also covers custom rules, suggestions, tickets)
  try {
    require('../orgDelete').deleteOrg(orgId);
  } catch (e) {
    return res.status(500).json({ error: 'Delete failed: ' + e.message });
  }

  // Remove users left with no workspaces; move the requester elsewhere or log them out
  // (orphan cleanup happens inside deleteOrg)

  const remaining = db.prepare(
    `SELECT o.id, o.name, m.role FROM user_orgs m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ? ORDER BY o.name`
  ).all(req.user.id);

  if (remaining.length === 0) {
    return res.json({ deleted: true, logout: true });
  }
  const next = remaining[0];
  const u = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(req.user.id);
  const token = signToken({ id: u.id, org_id: next.id, role: next.role, email: u.email, name: u.name });
  res.json({ deleted: true, token, orgName: next.name });
});
router.post('/switch', authRequired, async (req, res) => {
  const orgId = Number(req.body && req.body.org_id);
  if (!orgId) return res.status(400).json({ error: 'org_id is required' });
  const member = db.prepare(
    `SELECT m.role, u.id, u.email, u.name
     FROM user_orgs m JOIN users u ON u.id = m.user_id
     WHERE m.user_id = ? AND m.org_id = ?`
  ).get(req.user.id, orgId);
  if (!member) return res.status(403).json({ error: 'You do not belong to that workspace' });

  // Org-switch into an enforcing org: no session until the email-code flow
  // completes. Verifying enrolls the user and issues the session for this org.
  const { orgMfaBlocksUser, issueMfaToken, issueCode } = require('../mfa');
  if (orgMfaBlocksUser(orgId, req.user.id)) {
    if (!member.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(member.email)) {
      return res.status(403).json({
        error: 'That workspace requires two-factor authentication, but no valid email is on file for your account. Ask its owner to update your email address.',
      });
    }
    try {
      await issueCode(req.user.id, 'org-enforce');
    } catch (e) {
      return res.status(500).json({ error: 'Could not send verification code. Please try again.' });
    }
    const org = db.prepare('SELECT name FROM orgs WHERE id = ?').get(orgId);
    return res.json({
      mfaRequired: true,
      mfaToken: issueMfaToken(req.user.id, orgId),
      orgEnforced: true,
      orgName: org.name,
      message: 'That workspace requires two-factor authentication. A verification code was sent to your email.',
    });
  }

  const token = signToken({ id: member.id, org_id: orgId, role: member.role, email: member.email, name: member.name });
  const org = db.prepare('SELECT name FROM orgs WHERE id = ?').get(orgId);
  res.json({ token, orgName: org.name, role: member.role });
});

module.exports = router;
