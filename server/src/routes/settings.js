// Org settings — General, Team seats, API keys, Notifications, Customization.
// (Security / MFA enforcement lives at PUT /api/settings/security, owned by the
// MFA-enforcement workstream; this router deliberately does not define it.)
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db } = require('../db');
const { authRequired, roleRequired, requireProduct } = require('../auth');
const { seatUsage } = require('../config/planLimits');
const { sha256Hex } = require('../middleware/apiKeyAuth');

const router = express.Router();
router.use(authRequired, requireProduct('rcm'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
const LOGO_DIR = path.join(__dirname, '..', '..', 'uploads', 'org-logos');
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

function hasColumn(table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  } catch {
    return false;
  }
}

function orgSettingsRow(orgId) {
  const o = db.prepare(
    `SELECT id, name, plan, plan_status, timezone, date_format, rows_per_page,
            brand_color, logo_path, logo_updated_at,
            notify_demo_requests, notify_support_replies,
            notify_trial_reminders, notify_weekly_digest, created_at
     FROM orgs WHERE id = ?`
  ).get(orgId);
  if (!o) return null;
  // mfa_required belongs to the MFA workstream — read defensively so this
  // endpoint works before/after their migration lands.
  let mfa_required = false;
  if (hasColumn('orgs', 'mfa_required')) {
    mfa_required = !!db.prepare('SELECT mfa_required FROM orgs WHERE id = ?').get(orgId).mfa_required;
  }
  return {
    id: o.id,
    name: o.name,
    plan: o.plan || 'trial',
    plan_status: o.plan_status || 'trialing',
    timezone: o.timezone || 'America/New_York',
    date_format: o.date_format || 'MM/DD/YYYY',
    rows_per_page: o.rows_per_page || 25,
    brand_color: o.brand_color || null,
    logo_url: o.logo_path ? `/uploads/org-logos/${o.id}.png?v=${encodeURIComponent(o.logo_updated_at || o.created_at || '')}` : null,
    mfa_required,
    notifications: {
      demo_requests: o.notify_demo_requests !== 0,
      support_replies: o.notify_support_replies !== 0,
      trial_reminders: o.notify_trial_reminders !== 0,
      weekly_digest: o.notify_weekly_digest !== 0,
    },
    created_at: o.created_at,
  };
}

// ---- GET /api/settings — full settings payload for the current org ----
router.get('/', (req, res) => {
  const s = orgSettingsRow(req.orgId);
  if (!s) return res.status(404).json({ error: 'Workspace not found' });
  res.json(s);
});

// ---- General: rename + timezone + display prefs (owner only) ----
const DATE_FORMATS = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'];
const ROWS_OPTIONS = [10, 25, 50, 100];

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

router.put('/general', roleRequired('owner'), (req, res) => {
  const { name, timezone, date_format, rows_per_page } = req.body || {};
  const updates = [], params = [];
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: 'Workspace name is required' });
    updates.push('name = ?'); params.push(String(name).trim().slice(0, 80));
  }
  if (timezone !== undefined) {
    if (!validTimezone(timezone)) return res.status(400).json({ error: 'Invalid timezone' });
    updates.push('timezone = ?'); params.push(timezone);
  }
  if (date_format !== undefined) {
    if (!DATE_FORMATS.includes(date_format)) return res.status(400).json({ error: 'Invalid date format' });
    updates.push('date_format = ?'); params.push(date_format);
  }
  if (rows_per_page !== undefined) {
    const rpp = Number(rows_per_page);
    if (!ROWS_OPTIONS.includes(rpp)) return res.status(400).json({ error: 'Invalid rows per page' });
    updates.push('rows_per_page = ?'); params.push(rpp);
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.orgId);
  db.prepare(`UPDATE orgs SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(orgSettingsRow(req.orgId));
});

// ---- Seat usage vs limit (any member) ----
router.get('/seats', (req, res) => {
  res.json(seatUsage(db, req.orgId));
});

// ---- Developer API keys (owner only) ----
const KEY_RE = /^cp_sk_live_[0-9a-f]{48}$/;

function publicKeyRow(k) {
  return {
    id: k.id, name: k.name, key_prefix: k.key_prefix,
    created_at: k.created_at, last_used_at: k.last_used_at,
    revoked_at: k.revoked_at, revoked: !!k.revoked_at,
    created_by: k.created_by_name || k.created_by_email || null,
  };
}

router.get('/api-keys', roleRequired('owner'), (req, res) => {
  const rows = db.prepare(
    `SELECT k.id, k.name, k.key_prefix, k.created_at, k.last_used_at, k.revoked_at,
            u.name AS created_by_name, u.email AS created_by_email
     FROM api_keys k LEFT JOIN users u ON u.id = k.created_by
     WHERE k.org_id = ? ORDER BY k.created_at DESC, k.id DESC`
  ).all(req.orgId);
  res.json(rows.map(publicKeyRow)); // hashes are NEVER listed
});

router.post('/api-keys', roleRequired('owner'), (req, res) => {
  const name = typeof (req.body || {}).name === 'string' ? req.body.name.trim().slice(0, 60) : '';
  if (!name) return res.status(400).json({ error: 'Key name is required' });

  const secret = 'cp_sk_live_' + crypto.randomBytes(24).toString('hex'); // 48 hex chars
  if (!KEY_RE.test(secret)) return res.status(500).json({ error: 'Key generation failed' });
  const hash = sha256Hex(secret);
  const prefix = secret.slice(0, 18); // "cp_sk_live_" + 7 chars — enough to identify, useless to forge

  const id = Number(db.prepare(
    `INSERT INTO api_keys (org_id, name, key_hash, key_prefix, created_by) VALUES (?, ?, ?, ?, ?)`
  ).run(req.orgId, name, hash, prefix, req.user.id).lastInsertRowid);

  const row = db.prepare(
    `SELECT k.id, k.name, k.key_prefix, k.created_at, k.last_used_at, k.revoked_at,
            u.name AS created_by_name, u.email AS created_by_email
     FROM api_keys k LEFT JOIN users u ON u.id = k.created_by WHERE k.id = ?`
  ).get(id);
  // The plaintext key is returned HERE ONLY — it is never stored and never shown again.
  res.status(201).json({ ...publicKeyRow(row), key: secret });
});

router.delete('/api-keys/:id', roleRequired('owner'), (req, res) => {
  const row = db.prepare('SELECT id, revoked_at FROM api_keys WHERE id = ? AND org_id = ?')
    .get(req.params.id, req.orgId);
  if (!row) return res.status(404).json({ error: 'API key not found' });
  if (!row.revoked_at) {
    db.prepare(`UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ?`).run(row.id);
  }
  res.json({ revoked: true, id: row.id });
});

// ---- Notification preferences ----
// trial_reminders and weekly_digest have no sender yet — the preferences are
// stored (and the UI says so) so the future sender can read them.
const NOTIF_MAP = {
  demo_requests: 'notify_demo_requests',
  support_replies: 'notify_support_replies',
  trial_reminders: 'notify_trial_reminders',
  weekly_digest: 'notify_weekly_digest',
};

function getNotifPrefs(orgId) {
  const o = db.prepare(
    `SELECT notify_demo_requests, notify_support_replies, notify_trial_reminders, notify_weekly_digest
     FROM orgs WHERE id = ?`
  ).get(orgId);
  return {
    demo_requests: o.notify_demo_requests !== 0,
    support_replies: o.notify_support_replies !== 0,
    trial_reminders: o.notify_trial_reminders !== 0,
    weekly_digest: o.notify_weekly_digest !== 0,
  };
}

router.get('/notifications', (req, res) => {
  res.json(getNotifPrefs(req.orgId));
});

router.put('/notifications', roleRequired('owner'), (req, res) => {
  const body = req.body || {};
  const updates = [], params = [];
  for (const [key, col] of Object.entries(NOTIF_MAP)) {
    if (body[key] !== undefined) {
      updates.push(`${col} = ?`); params.push(body[key] ? 1 : 0);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'No preferences to update' });
  params.push(req.orgId);
  db.prepare(`UPDATE orgs SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(getNotifPrefs(req.orgId));
});

// ---- Logo upload (owner only) ----
const IMAGE_SIGS = [
  { ext: 'png', sig: [0x89, 0x50, 0x4e, 0x47] },
  { ext: 'jpg', sig: [0xff, 0xd8, 0xff] },
  { ext: 'gif', sig: [0x47, 0x49, 0x46, 0x38] },
  { ext: 'webp', sig: [0x52, 0x49, 0x46, 0x46] }, // RIFF....WEBP (bytes 8-11 checked below)
];
function detectImage(buf) {
  for (const { ext, sig } of IMAGE_SIGS) {
    if (sig.every((b, i) => buf[i] === b)) {
      if (ext === 'webp' && buf.slice(8, 12).toString('ascii') !== 'WEBP') continue;
      return ext;
    }
  }
  return null;
}

router.post('/logo', roleRequired('owner'), (req, res, next) => {
  // Translate multer errors (e.g. LIMIT_FILE_SIZE) into clean 400s.
  upload.single('logo')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Logo must be 2 MB or smaller' : `Upload failed: ${err.message}`;
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (req.file.size > LOGO_MAX_BYTES) return res.status(400).json({ error: 'Logo must be 2 MB or smaller' });
  const ext = detectImage(req.file.buffer);
  if (!ext) return res.status(400).json({ error: 'File is not a supported image (PNG, JPG, GIF, WebP)' });

  fs.mkdirSync(LOGO_DIR, { recursive: true });
  // Single canonical filename per org (always .png on disk regardless of
  // source format — the header serves it as an image).
  const dest = path.join(LOGO_DIR, `${req.orgId}.png`);
  fs.writeFileSync(dest, req.file.buffer);
  db.prepare(`UPDATE orgs SET logo_path = ?, logo_updated_at = datetime('now') WHERE id = ?`)
    .run(`org-logos/${req.orgId}.png`, req.orgId);
  const s = orgSettingsRow(req.orgId);
  res.json({ logo_url: s.logo_url });
});

router.delete('/logo', roleRequired('owner'), (req, res) => {
  try { fs.unlinkSync(path.join(LOGO_DIR, `${req.orgId}.png`)); } catch { /* already gone */ }
  db.prepare(`UPDATE orgs SET logo_path = NULL, logo_updated_at = NULL WHERE id = ?`).run(req.orgId);
  res.json({ logo_url: null });
});

// ---- Org-wide MFA enforcement (workstream C; owner-only writes) ----
// Contract: PUT /api/settings/security { mfa_required: boolean } → { mfa_required: boolean }
// GET returns the current flag for any member (used by the Security tab UI).
//
// When ON, every member must complete the existing email-code MFA flow (and
// becomes MFA-enrolled) before receiving a session for this org — enforced at
// password login, Google sign-in, and org-switch, plus a hard API block for
// unenrolled members (see authRequired in ../auth.js).
//
// LOCKOUT ESCAPE: the owner who flips this on is subject to the same block on
// their NEXT request — they complete the email-code flow like everyone else.
// If an owner cannot complete MFA (e.g. no access to their email): (1) any
// other owner of the org who can complete MFA turns the flag back off here;
// (2) the super-admin is exempt from the block (checked live in authRequired)
// and can clear the flag directly:
//   UPDATE orgs SET mfa_required = 0 WHERE id = <orgId>;
// API keys (apiKeyAuth) are machine credentials and are NOT gated by this flag,
// but they are revocable at any time from Settings → API keys.
const { auditLog } = require('../audit');

router.get('/security', (req, res) => {
  const org = db.prepare('SELECT mfa_required FROM orgs WHERE id = ?').get(req.orgId);
  if (!org) return res.status(404).json({ error: 'Workspace not found' });
  res.json({ mfa_required: org.mfa_required === 1 });
});

router.put('/security', roleRequired('owner'), (req, res) => {
  const { mfa_required } = req.body || {};
  if (typeof mfa_required !== 'boolean') {
    return res.status(400).json({ error: 'mfa_required must be a boolean' });
  }
  db.prepare('UPDATE orgs SET mfa_required = ? WHERE id = ?').run(mfa_required ? 1 : 0, req.orgId);
  auditLog(req, 'org.mfa_required.updated', 'org', req.orgId, `mfa_required=${mfa_required ? 1 : 0}`);
  res.json({ mfa_required });
});

// ---- Brand accent color (owner only) ----
router.put('/brand', roleRequired('owner'), (req, res) => {
  const { brand_color } = req.body || {};
  if (brand_color !== null && brand_color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(brand_color)) {
    return res.status(400).json({ error: 'Brand color must be a hex color like #10b981, or null to reset' });
  }
  db.prepare('UPDATE orgs SET brand_color = ? WHERE id = ?').run(brand_color || null, req.orgId);
  res.json({ brand_color: brand_color || null });
});

module.exports = router;
