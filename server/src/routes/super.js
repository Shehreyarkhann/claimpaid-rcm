// Super-admin API — /api/super/*
// Every route is behind authRequired + superAdminRequired (DB-checked, no org scoping).
// This surface is for the owner's eyes only.

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { authRequired, superAdminRequired } = require('../auth');
const { deleteOrg } = require('../orgDelete');

const router = express.Router();
router.use(authRequired, superAdminRequired);

// ---- Plans (must match billing.js) ----
const PLAN_MRR = { starter: 19900, pro: 49900, ai: 9900, enterprise: 0, trial: 0 };
const VALID_PLANS = ['starter', 'pro', 'ai', 'enterprise', 'trial'];
const VALID_STATUSES = ['trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired'];
const VALID_ROLES = ['owner', 'biller', 'viewer'];

function mrrFor(plan, status) {
  if (!['active', 'trialing'].includes(status)) return 0;
  return PLAN_MRR[plan] || 0;
}

function orgRow(id) {
  return db.prepare('SELECT * FROM orgs WHERE id = ?').get(id);
}

// ================= OVERVIEW =================
router.get('/overview', (req, res) => {
  const rcm_orgs = db.prepare('SELECT COUNT(*) AS n FROM orgs').get().n;
  const total_users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  const subs = db.prepare('SELECT plan, plan_status FROM orgs').all();
  let mrr_cents = 0, trialing = 0, past_due = 0;
  for (const s of subs) {
    mrr_cents += mrrFor(s.plan, s.plan_status);
    if (s.plan_status === 'trialing') trialing++;
    if (s.plan_status === 'past_due') past_due++;
  }

  const open_demos = db.prepare('SELECT COUNT(*) AS n FROM demo_requests WHERE contacted = 0').get().n;
  const open_tickets = db.prepare("SELECT COUNT(*) AS n FROM support_tickets WHERE status = 'open'").get().n;

  let ai_orgs = 0;
  try {
    const adb = openAiDb();
    if (adb) { ai_orgs = adb.prepare('SELECT COUNT(*) AS n FROM orgs').get().n; adb.close(); }
  } catch {}

  const recent_orgs = db.prepare(
    `SELECT id, name, plan, plan_status, created_at FROM orgs ORDER BY id DESC LIMIT 5`
  ).all();

  res.json({ rcm_orgs, ai_orgs, total_users, mrr_cents, trialing, past_due, open_demos, open_tickets, recent_orgs });
});

// ================= CLIENTS (RCM orgs) =================
router.get('/orgs', (req, res) => {
  const rows = db.prepare(`
    SELECT o.id, o.name, o.plan, o.plan_status, o.stripe_customer_id, o.stripe_subscription_id,
           o.created_at,
           (SELECT COUNT(*) FROM user_orgs m WHERE m.org_id = o.id) AS user_count,
           (SELECT COUNT(*) FROM claims c WHERE c.org_id = o.id) AS claim_count,
           b.baa_version, b.signed_at AS baa_signed_at
    FROM orgs o
    LEFT JOIN baa_signatures b ON b.org_id = o.id
    ORDER BY o.id DESC
  `).all();
  res.json(rows);
});

router.get('/orgs/:id', (req, res) => {
  const org = orgRow(req.params.id);
  if (!org) return res.status(404).json({ error: 'Org not found' });
  const users = db.prepare(`
    SELECT u.id, u.name, u.email, m.role, u.created_at
    FROM user_orgs m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ? ORDER BY m.role, u.name
  `).all(org.id);
  const claimsByStatus = db.prepare(
    `SELECT status, COUNT(*) AS n FROM claims WHERE org_id = ? GROUP BY status`
  ).all(org.id);
  const openAppeals = db.prepare(
    `SELECT COUNT(*) AS n FROM appeals WHERE org_id = ? AND status = 'open'`
  ).get(org.id).n;
  const baa = db.prepare('SELECT * FROM baa_signatures WHERE org_id = ?').get(org.id) || null;
  res.json({ org, users, claimsByStatus, openAppeals, baa });
});

router.patch('/orgs/:id/plan', (req, res) => {
  const { plan, plan_status } = req.body || {};
  if (!VALID_PLANS.includes(plan)) return res.status(400).json({ error: 'Invalid plan' });
  if (!VALID_STATUSES.includes(plan_status)) return res.status(400).json({ error: 'Invalid plan status' });
  const org = orgRow(req.params.id);
  if (!org) return res.status(404).json({ error: 'Org not found' });
  db.prepare('UPDATE orgs SET plan = ?, plan_status = ? WHERE id = ?').run(plan, plan_status, org.id);
  res.json({ ok: true, plan, plan_status });
});

router.delete('/orgs/:id', (req, res) => {
  const org = orgRow(req.params.id);
  if (!org) return res.status(404).json({ error: 'Org not found' });
  try {
    deleteOrg(org.id);
  } catch (e) {
    return res.status(500).json({ error: 'Delete failed: ' + e.message });
  }
  res.json({ deleted: true });
});

// ================= AI CLIENTS (read-only) =================
function aiDbPath() {
  return process.env.AI_DB_PATH ||
    path.join(__dirname, '..', '..', '..', '..', 'askbase', 'server', 'askbase.db');
}

function openAiDb() {
  const fs = require('fs');
  const p = aiDbPath();
  if (!fs.existsSync(p)) return null;
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(p, { readOnly: true });
}

router.get('/ai-orgs', (req, res) => {
  let adb;
  try {
    adb = openAiDb();
    if (!adb) return res.json([]);
    const rows = adb.prepare(`
      SELECT o.id, o.name, o.rcm_org_id, o.created_at,
        (SELECT COUNT(*) FROM users u WHERE u.org_id = o.id) AS user_count,
        (SELECT COUNT(*) FROM knowledge_bases k WHERE k.org_id = o.id) AS kb_count,
        (SELECT COUNT(*) FROM chunks c WHERE c.org_id = o.id) AS chunk_count
      FROM orgs o ORDER BY o.id DESC
    `).all();
    // Attach linked RCM org names where possible
    const out = rows.map((r) => {
      let rcm_org_name = null;
      if (r.rcm_org_id) {
        const hit = db.prepare('SELECT name FROM orgs WHERE id = ?').get(r.rcm_org_id);
        rcm_org_name = hit ? hit.name : null;
      }
      return { ...r, rcm_org_name };
    });
    adb.close();
    res.json(out);
  } catch (e) {
    try { adb && adb.close(); } catch {}
    console.error('super /ai-orgs failed:', e.message);
    res.json([]);
  }
});

// ================= USERS =================
router.get('/users', (req, res) => {
  const q = (req.query.search || '').trim();
  const where = q ? `WHERE LOWER(u.name) LIKE ? OR LOWER(u.email) LIKE ?` : '';
  const args = q ? [`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`] : [];
  const rows = db.prepare(`
    SELECT u.id, u.name, u.email, u.is_superadmin, u.created_at,
           GROUP_CONCAT(o.name, ', ') AS orgs,
           GROUP_CONCAT(m.role, ', ') AS roles
    FROM users u
    LEFT JOIN user_orgs m ON m.user_id = u.id
    LEFT JOIN orgs o ON o.id = m.org_id
    ${where}
    GROUP BY u.id ORDER BY u.id DESC LIMIT 200
  `).all(...args);
  res.json(rows);
});

function lastSuperadminGuard(userId) {
  const u = db.prepare('SELECT is_superadmin FROM users WHERE id = ?').get(userId);
  if (u && u.is_superadmin === 1) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_superadmin = 1').get().n;
    if (n <= 1) return 'Cannot remove the last super-admin';
  }
  return null;
}

router.patch('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const { name, role, is_active } = req.body || {};
  if (role !== undefined && !VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });

  const updates = [];
  const args = [];
  if (typeof name === 'string' && name.trim()) { updates.push('name = ?'); args.push(name.trim().slice(0, 120)); }
  if (is_active !== undefined) { updates.push('is_active = ?'); args.push(is_active ? 1 : 0); }
  if (updates.length) {
    // users table may not have is_active yet — add it if needed
    const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    if (updates.some((x) => x.startsWith('is_active')) && !cols.includes('is_active')) {
      db.exec('ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
    }
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...args, id);
  }
  if (role !== undefined) {
    db.prepare('UPDATE user_orgs SET role = ? WHERE user_id = ?').run(role, id);
  }
  res.json({ ok: true });
});

router.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const guard = lastSuperadminGuard(id);
  if (guard) return res.status(400).json({ error: guard });
  db.prepare('DELETE FROM user_orgs WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ deleted: true });
});

router.post('/users/:id/reset-password', (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT id, email FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const temp = crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'Temp' + Date.now().toString(36);
  const hash = bcrypt.hashSync(temp, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
  res.json({ ok: true, email: u.email, temp_password: temp });
});

// ================= SUBSCRIPTIONS =================
router.get('/subscriptions', (req, res) => {
  const rows = db.prepare(`
    SELECT id, name, plan, plan_status, stripe_customer_id, stripe_subscription_id,
           current_period_end, created_at
    FROM orgs ORDER BY id DESC
  `).all();
  const out = rows.map((r) => ({ ...r, mrr_cents: mrrFor(r.plan, r.plan_status) }));
  const totals = {
    mrr_cents: out.reduce((a, r) => a + r.mrr_cents, 0),
    trialing: out.filter((r) => r.plan_status === 'trialing').length,
    active: out.filter((r) => r.plan_status === 'active').length,
    past_due: out.filter((r) => r.plan_status === 'past_due').length,
    canceled: out.filter((r) => r.plan_status === 'canceled').length,
  };
  res.json({ subscriptions: out, totals });
});

// ================= DEMO REQUESTS =================
router.get('/demos', (req, res) => {
  const rows = db.prepare('SELECT * FROM demo_requests ORDER BY created_at DESC LIMIT 200').all();
  res.json(rows);
});

router.patch('/demos/:id', (req, res) => {
  const { contacted, notes } = req.body || {};
  const d = db.prepare('SELECT id FROM demo_requests WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (contacted !== undefined) db.prepare('UPDATE demo_requests SET contacted = ? WHERE id = ?').run(contacted ? 1 : 0, d.id);
  if (typeof notes === 'string') db.prepare('UPDATE demo_requests SET notes = ? WHERE id = ?').run(notes.slice(0, 2000), d.id);
  res.json({ ok: true });
});

// ================= SUPPORT TICKETS =================
router.get('/tickets', (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, o.name AS org_name, u.name AS user_name
    FROM support_tickets t
    LEFT JOIN orgs o ON o.id = t.org_id
    LEFT JOIN users u ON u.id = t.user_id
    ORDER BY t.created_at DESC LIMIT 200
  `).all();
  res.json(rows);
});

router.patch('/tickets/:id', (req, res) => {
  const { status, internal_note } = req.body || {};
  const t = db.prepare('SELECT id FROM support_tickets WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (status !== undefined) {
    if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    db.prepare("UPDATE support_tickets SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, t.id);
  }
  if (typeof internal_note === 'string') {
    db.prepare("UPDATE support_tickets SET internal_note = ?, updated_at = datetime('now') WHERE id = ?").run(internal_note.slice(0, 4000), t.id);
  }
  res.json({ ok: true });
});

// ================= DATABASE MANAGER (whitelist only) =================
const TABLE_WHITELIST = [
  'orgs', 'users', 'user_orgs', 'payers', 'claims', 'appeals', 'appeal_notes',
  'payer_filing_rules', 'payer_playbook', 'claim_activity', 'auth_requests', 'auth_notes',
  'eligibility_checks', 'appeal_letter_templates', 'demo_requests', 'support_tickets',
  'custom_scrub_rules', 'rule_suggestions',
];

function tableInfo(name) {
  return db.prepare(`PRAGMA table_info(${name})`).all();
}

router.get('/tables', (req, res) => {
  const out = TABLE_WHITELIST.map((t) => {
    let count = 0;
    try { count = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch {}
    return { name: t, rows: count };
  });
  res.json(out);
});

router.get('/tables/:name', (req, res) => {
  const name = req.params.name;
  if (!TABLE_WHITELIST.includes(name)) return res.status(400).json({ error: 'Table not allowed' });
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const search = (req.query.search || '').trim();
  const cols = tableInfo(name);
  const textCols = cols.filter((c) => /TEXT|CHAR|CLOB/i.test(c.type)).map((c) => c.name);

  let where = '', args = [];
  if (search && textCols.length) {
    where = 'WHERE ' + textCols.map((c) => `${c} LIKE ?`).join(' OR ');
    args = textCols.map(() => `%${search}%`);
  }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ${name} ${where}`).get(...args).n;
  // Tables without an `id` column (e.g. user_orgs) are addressed by rowid
  const idCol = cols.some((c) => c.name === 'id') ? 'id' : 'rowid';
  const idExpr = idCol === 'id' ? 'id' : 'rowid AS id';
  const rows = db.prepare(
    `SELECT ${idExpr}, ${name}.* FROM ${name} ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...args, limit, (page - 1) * limit);
  res.json({ idCol, columns: cols.map((c) => ({ name: c.name, type: c.type, pk: c.pk > 0 })), total, page, limit, rows });
});

function filterToColumns(name, body) {
  const cols = tableInfo(name).map((c) => c.name).filter((n) => n !== 'id');
  const out = {};
  for (const c of cols) {
    if (body[c] !== undefined) out[c] = body[c] === '' ? null : body[c];
  }
  return out;
}

router.post('/tables/:name', (req, res) => {
  const name = req.params.name;
  if (!TABLE_WHITELIST.includes(name)) return res.status(400).json({ error: 'Table not allowed' });
  const data = filterToColumns(name, req.body || {});
  const keys = Object.keys(data);
  if (!keys.length) return res.status(400).json({ error: 'No valid columns provided' });
  const placeholders = keys.map(() => '?').join(', ');
  const id = Number(db.prepare(`INSERT INTO ${name} (${keys.join(', ')}) VALUES (${placeholders})`)
    .run(...keys.map((k) => data[k])).lastInsertRowid);
  res.status(201).json({ ok: true, id });
});

router.patch('/tables/:name/:id', (req, res) => {
  const name = req.params.name;
  if (!TABLE_WHITELIST.includes(name)) return res.status(400).json({ error: 'Table not allowed' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const idCol = tableInfo(name).some((c) => c.name === 'id') ? 'id' : 'rowid';
  const data = filterToColumns(name, req.body || {});
  const keys = Object.keys(data);
  if (!keys.length) return res.status(400).json({ error: 'No valid columns provided' });
  db.prepare(`UPDATE ${name} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${idCol} = ?`)
    .run(...keys.map((k) => data[k]), id);
  res.json({ ok: true });
});

router.delete('/tables/:name/:id', (req, res) => {
  const name = req.params.name;
  if (!TABLE_WHITELIST.includes(name)) return res.status(400).json({ error: 'Table not allowed' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const idCol = tableInfo(name).some((c) => c.name === 'id') ? 'id' : 'rowid';
  if (name === 'users') {
    const guard = lastSuperadminGuard(id);
    if (guard) return res.status(400).json({ error: guard });
    db.prepare('DELETE FROM user_orgs WHERE user_id = ?').run(id);
    db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
    return res.json({ deleted: true });
  }
  if (name === 'orgs') {
    // FK-safe wipe, same as the Clients tab (never leaves dangling rows)
    try { deleteOrg(id); } catch (e) { return res.status(500).json({ error: 'Delete failed: ' + e.message }); }
    return res.json({ deleted: true });
  }
  db.prepare(`DELETE FROM ${name} WHERE ${idCol} = ?`).run(id);
  res.json({ deleted: true });
});

module.exports = router;
