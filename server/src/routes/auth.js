const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { signToken, authRequired, roleRequired } = require('../auth');

const router = express.Router();

// --- Sign up: creates org + owner user ---
router.post('/signup', (req, res) => {
  const { orgName, name, email, password } = req.body || {};
  if (!orgName || !name || !email || !password) {
    return res.status(400).json({ error: 'Organization name, name, email and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(email.trim());
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

  const orgId = Number(db.prepare('INSERT INTO orgs (name) VALUES (?)').run(orgName.trim()).lastInsertRowid);
  const hash = bcrypt.hashSync(password, 10);
  const userId = Number(
    db.prepare('INSERT INTO users (org_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)')
      .run(orgId, email.trim().toLowerCase(), hash, name.trim(), 'owner').lastInsertRowid
  );

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

  const safe = { id: user.id, org_id: user.org_id, email: user.email, name: user.name, role: user.role };
  const org = db.prepare('SELECT name FROM orgs WHERE id = ?').get(user.org_id);
  res.json({ token: signToken(safe), user: { ...safe, orgName: org ? org.name : '' } });
});

// --- Current user ---
router.get('/me', authRequired, (req, res) => {
  const org = db.prepare('SELECT name FROM orgs WHERE id = ?').get(req.orgId);
  res.json({ ...req.user, orgName: org ? org.name : '' });
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
router.get('/team', authRequired, (req, res) => {
  const users = db.prepare(
    'SELECT id, email, name, role, created_at FROM users WHERE org_id = ? ORDER BY created_at'
  ).all(req.orgId);
  res.json(users);
});

router.post('/team', authRequired, roleRequired('owner'), (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!['owner', 'biller', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

  const existing = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(email.trim());
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

  const hash = bcrypt.hashSync(password, 10);
  const id = Number(
    db.prepare('INSERT INTO users (org_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)')
      .run(req.orgId, email.trim().toLowerCase(), hash, name.trim(), role).lastInsertRowid
  );
  res.status(201).json(db.prepare('SELECT id, email, name, role, created_at FROM users WHERE id = ?').get(id));
});

router.put('/team/:id', authRequired, roleRequired('owner'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot change your own role' });
  if (!['owner', 'biller', 'viewer'].includes(req.body.role)) return res.status(400).json({ error: 'Invalid role' });

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(req.body.role, target.id);
  res.json(db.prepare('SELECT id, email, name, role, created_at FROM users WHERE id = ?').get(target.id));
});

router.delete('/team/:id', authRequired, roleRequired('owner'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot remove yourself' });

  // Unassign their appeals
  db.prepare('UPDATE appeals SET assigned_to = NULL WHERE assigned_to = ?').run(target.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  res.json({ deleted: true });
});

module.exports = router;
