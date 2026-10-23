const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { signToken, authRequired, roleRequired } = require('../auth');

const router = express.Router();

// --- Sign up: creates org + owner user ---
router.post('/signup', (req, res) => {
  const { orgName, name, email, password, plan } = req.body || {};
  if (!orgName || !name || !email || !password) {
    return res.status(400).json({ error: 'Organization name, name, email and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
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

  const user = db.prepare('SELECT id, org_id, email, name, role FROM users WHERE id = ?').get(userId);
  res.status(201).json({ token: signToken(user), user });
});

// --- Login ---
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(email.trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // MFA: password was correct, but a second factor is required
  if (user.mfa_enabled) {
    try {
      const { issueMfaToken, issueCode } = require('../mfa');
      await issueCode(user.id, 'login');
      return res.json({
        mfaRequired: true,
        mfaToken: issueMfaToken(user.id),
        message: 'A verification code was sent to your email.',
      });
    } catch (e) {
      return res.status(500).json({ error: 'Could not send verification code. Please try again.' });
    }
  }

  // Super-admin bootstrap: the configured email is promoted on every login
  // (case-insensitive). Reads SUPERADMIN_EMAIL at request time.
  const superEmail = (process.env.SUPERADMIN_EMAIL || '').trim().toLowerCase();
  if (superEmail && user.email && user.email.toLowerCase() === superEmail && !user.is_superadmin) {
    db.prepare('UPDATE users SET is_superadmin = 1 WHERE id = ?').run(user.id);
    user.is_superadmin = 1;
  }

  const safe = { id: user.id, org_id: user.org_id, email: user.email, name: user.name, role: user.role, is_superadmin: user.is_superadmin ? 1 : 0 };
  const org = db.prepare('SELECT name FROM orgs WHERE id = ?').get(user.org_id);
  res.json({ token: signToken(safe), user: { ...safe, orgName: org ? org.name : '' } });
});

// --- Current user ---
router.get('/me', authRequired, (req, res) => {
  const org = db.prepare('SELECT name FROM orgs WHERE id = ?').get(req.orgId);
  const flag = db.prepare('SELECT is_superadmin FROM users WHERE id = ?').get(req.user.id);
  res.json({ ...req.user, orgName: org ? org.name : '', is_superadmin: flag && flag.is_superadmin === 1 ? 1 : 0 });
});

// --- Password reset: request ---
router.post('/password/forgot', async (req, res) => {
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
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

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
    `SELECT u.id, u.email, u.name, m.role, u.created_at
     FROM user_orgs m JOIN users u ON u.id = m.user_id
     WHERE m.org_id = ? ORDER BY u.created_at`
  ).all(req.orgId);
  res.json(users);
});

router.post('/team', authRequired, roleRequired('owner'), (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required' });
  if (!['owner', 'biller', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

  const existing = db.prepare('SELECT id, name FROM users WHERE LOWER(email) = LOWER(?)').get(email.trim());
  if (existing) {
    // Existing ClaimPaid user: just add them to this workspace (no new password needed)
    const already = db.prepare('SELECT 1 FROM user_orgs WHERE user_id = ? AND org_id = ?').get(existing.id, req.orgId);
    if (already) return res.status(409).json({ error: 'This person is already in this workspace' });
    db.prepare('INSERT INTO user_orgs (user_id, org_id, role) VALUES (?, ?, ?)')
      .run(existing.id, req.orgId, role);
    return res.status(201).json({ id: existing.id, email: email.trim().toLowerCase(), name: existing.name, role, addedToWorkspace: true });
  }

  if (!name || !password) return res.status(400).json({ error: 'Name and password are required for a new user' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const hash = bcrypt.hashSync(password, 10);
  const id = Number(
    db.prepare('INSERT INTO users (org_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)')
      .run(req.orgId, email.trim().toLowerCase(), hash, name.trim(), role).lastInsertRowid
  );
  db.prepare('INSERT OR IGNORE INTO user_orgs (user_id, org_id, role) VALUES (?, ?, ?)')
    .run(id, req.orgId, role);
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
  // If they belong to no workspaces left, remove the login entirely
  const remaining = db.prepare('SELECT COUNT(*) c FROM user_orgs WHERE user_id = ?').get(member.user_id).c;
  if (remaining === 0) db.prepare('DELETE FROM users WHERE id = ?').run(member.user_id);
  res.json({ deleted: true });
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

// Create a new workspace (seeds default payers + filing rules)
router.post('/orgs', authRequired, (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Workspace name is required' });

  const orgId = Number(db.prepare('INSERT INTO orgs (name) VALUES (?)').run(name.trim()).lastInsertRowid);
  db.prepare('INSERT INTO user_orgs (user_id, org_id, role) VALUES (?, ?, ?)')
    .run(req.user.id, orgId, 'owner');

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

  res.status(201).json({ id: orgId, name: name.trim(), role: 'owner' });
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
router.post('/switch', authRequired, (req, res) => {
  const orgId = Number(req.body && req.body.org_id);
  if (!orgId) return res.status(400).json({ error: 'org_id is required' });
  const member = db.prepare(
    `SELECT m.role, u.id, u.email, u.name
     FROM user_orgs m JOIN users u ON u.id = m.user_id
     WHERE m.user_id = ? AND m.org_id = ?`
  ).get(req.user.id, orgId);
  if (!member) return res.status(403).json({ error: 'You do not belong to that workspace' });

  const token = signToken({ id: member.id, org_id: orgId, role: member.role, email: member.email, name: member.name });
  const org = db.prepare('SELECT name FROM orgs WHERE id = ?').get(orgId);
  res.json({ token, orgName: org.name, role: member.role });
});

module.exports = router;
