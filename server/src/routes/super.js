// Super-admin API — /api/super/*
// Every route is behind authRequired + superAdminRequired (DB-checked, no org scoping).
// This surface is for the owner's eyes only.

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { authRequired, superAdminRequired } = require('../auth');
const { auditLog } = require('../audit');
const { deleteOrg } = require('../orgDelete');

const router = express.Router();
router.use(authRequired, superAdminRequired);

// Audit helper for super-admin power actions: the HIPAA audit_log wants an
// org context. We pass a minimal req-like object (spreading an Express req
// drops headers/ip), pinning the target org.
function superAudit(req, orgId, action, resourceType, resourceId, resourceLabel) {
  try {
    auditLog(
      { orgId, user: req.user, ip: req.ip, headers: req.headers || {} },
      action, resourceType, resourceId, resourceLabel
    );
  } catch (e) {
    console.error('superAudit failed:', e.message);
  }
}

// Lazy Stripe client (null when STRIPE_SECRET_KEY is not configured).
// All super-admin Stripe calls are defensive: a Stripe failure never crashes
// the endpoint — the app-side action still applies and a warning is returned.
let _stripe = null;
function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  try {
    _stripe = require('stripe')(key);
  } catch (e) {
    console.error('super: Stripe init failed:', e.message);
    return null;
  }
  return _stripe;
}

// ---- Plans (must match billing.js) ----
const PLAN_MRR = { starter: 19900, pro: 49900, ai: 9900, enterprise: 0, trial: 0 };
const VALID_PLANS = ['starter', 'pro', 'ai', 'enterprise', 'trial'];
const VALID_STATUSES = ['trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'expired'];
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
  const overdue_tickets = db.prepare(
    `SELECT COUNT(*) AS n FROM support_tickets
     WHERE status IN ('open','pending') AND sla_due_at IS NOT NULL AND sla_due_at < datetime('now')`
  ).get().n;
  const avg_first_response_hours = db.prepare(
    `SELECT AVG((julianday(first_response_at) - julianday(created_at)) * 24) AS h
     FROM support_tickets
     WHERE first_response_at IS NOT NULL AND created_at > datetime('now', '-30 days')`
  ).get().h;

  let ai_orgs = 0;
  try {
    const adb = openAiDb();
    if (adb) { ai_orgs = adb.prepare('SELECT COUNT(*) AS n FROM orgs').get().n; adb.close(); }
  } catch {}

  const recent_orgs = db.prepare(
    `SELECT id, name, plan, plan_status, created_at FROM orgs ORDER BY id DESC LIMIT 5`
  ).all();

  res.json({ rcm_orgs, ai_orgs, total_users, mrr_cents, trialing, past_due, open_demos, open_tickets, overdue_tickets, avg_first_response_hours, recent_orgs });
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
  const eligTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='eligibility_lookups'`).get();
  const eligibility = eligTable ? {
    vendor: org.eligibility_vendor || 'demo',
    configured: !!(org.eligibility_endpoint && org.eligibility_endpoint.trim()),
    checks_30d: db.prepare(
      `SELECT COUNT(*) AS n FROM eligibility_lookups WHERE org_id = ? AND created_at >= datetime('now', '-30 days')`
    ).get(org.id).n,
  } : null;
  const batchTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='claim_batches'`).get();
  const transmission = batchTable ? {
    vendor: org.xmit_vendor || 'manual',
    batches_30d: db.prepare(
      `SELECT COUNT(*) AS n FROM claim_batches WHERE org_id = ? AND created_at >= datetime('now', '-30 days')`
    ).get(org.id).n,
    claims_transmitted_30d: db.prepare(
      `SELECT COUNT(*) AS n FROM claims WHERE org_id = ? AND x12_status IN ('transmitted','accepted','rejected')
       AND last_batch_id IN (SELECT id FROM claim_batches WHERE org_id = ? AND created_at >= datetime('now', '-30 days'))`
    ).get(org.id, org.id).n,
    acceptance_rate: (() => {
      const r = db.prepare(
        `SELECT SUM(CASE WHEN x12_status = 'accepted' THEN 1 ELSE 0 END) AS a,
                SUM(CASE WHEN x12_status IN ('accepted','rejected') THEN 1 ELSE 0 END) AS t
         FROM claims WHERE org_id = ? AND x12_status IN ('accepted','rejected')`
      ).get(org.id);
      return r.t ? Math.round((r.a / r.t) * 100) : null;
    })(),
  } : null;
  const ehrTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ehr_connections'`).get();
  const ehr = ehrTable ? {
    connections: db.prepare(
      `SELECT provider, status, practice_id, last_sync_at FROM ehr_connections WHERE org_id = ?`
    ).all(org.id),
    encounters_30d: db.prepare(
      `SELECT COUNT(*) AS n FROM ehr_encounters WHERE org_id = ? AND synced_at >= datetime('now', '-30 days')`
    ).get(org.id).n,
  } : null;
  const codingTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='coding_jobs'`).get();
  const coding = codingTable ? {
    jobs_30d: db.prepare(
      `SELECT COUNT(*) AS n FROM coding_jobs WHERE org_id = ? AND created_at >= datetime('now', '-30 days')`
    ).get(org.id).n,
    acceptance_rate: (() => {
      const r = db.prepare(
        `SELECT SUM(CASE WHEN decision IN ('accepted','modified') THEN 1 ELSE 0 END) AS a,
                COUNT(*) AS t
         FROM coding_decisions d JOIN coding_jobs j ON j.id = d.job_id
         WHERE j.org_id = ? AND j.created_at >= datetime('now', '-30 days')`
      ).get(org.id);
      return r.t ? Math.round((r.a / r.t) * 100) : null;
    })(),
  } : null;
  res.json({ org, users, claimsByStatus, openAppeals, baa, eligibility, transmission, ehr, coding });
});

router.patch('/orgs/:id/plan', (req, res) => {
  const { plan, plan_status } = req.body || {};
  if (!VALID_PLANS.includes(plan)) return res.status(400).json({ error: 'Invalid plan' });
  if (!VALID_STATUSES.includes(plan_status)) return res.status(400).json({ error: 'Invalid plan status' });
  const org = orgRow(req.params.id);
  if (!org) return res.status(404).json({ error: 'Org not found' });
  db.prepare('UPDATE orgs SET plan = ?, plan_status = ? WHERE id = ?').run(plan, plan_status, org.id);
  superAudit(req, org.id, 'super.plan_change', 'org', org.id,
    `${org.name}: ${org.plan}/${org.plan_status} → ${plan}/${plan_status}`);
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
  superAudit(req, null, 'super.org_delete', 'org', org.id, org.name);
  res.json({ deleted: true });
});

// ---- Trial controls ----
// POST /api/super/orgs/:id/trial  { action: 'revoke' | 'extend', days?: 7|14|30 }
router.post('/orgs/:id/trial', async (req, res) => {
  const org = orgRow(req.params.id);
  if (!org) return res.status(404).json({ error: 'Org not found' });
  const { action, days } = req.body || {};

  if (action === 'revoke') {
    db.prepare("UPDATE orgs SET plan_status = 'expired', trial_ends_at = datetime('now') WHERE id = ?")
      .run(org.id);
    superAudit(req, org.id, 'super.trial_revoke', 'org', org.id, org.name);
    let stripeWarning = null;
    // If there's a live Stripe trialing subscription, cancel it immediately too.
    if (org.stripe_subscription_id) {
      const stripe = getStripe();
      if (stripe) {
        try {
          const sub = await stripe.subscriptions.retrieve(org.stripe_subscription_id);
          if (sub && sub.status === 'trialing') {
            await stripe.subscriptions.cancel(org.stripe_subscription_id);
            db.prepare('UPDATE orgs SET stripe_subscription_id = NULL WHERE id = ?').run(org.id);
          }
        } catch (e) {
          stripeWarning = 'App trial revoked, but the Stripe subscription could not be cancelled: ' + e.message;
          console.error('super trial revoke stripe:', e.message);
        }
      } else {
        stripeWarning = 'App trial revoked. No Stripe key configured — check for a live Stripe trial manually.';
      }
    }
    return res.json({ ok: true, plan_status: 'expired', stripeWarning });
  }

  if (action === 'extend') {
    const d = Number(days);
    if (![7, 14, 30].includes(d)) return res.status(400).json({ error: 'days must be 7, 14, or 30' });
    const nowMs = Date.now();
    const endsMs = org.trial_ends_at ? new Date(org.trial_ends_at).getTime() : NaN;
    // Extend from the current end date when the trial is still live; otherwise start fresh now.
    const baseMs = (org.plan_status === 'trialing' && Number.isFinite(endsMs) && endsMs > nowMs) ? endsMs : nowMs;
    const newEnd = new Date(baseMs + d * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    db.prepare(`UPDATE orgs SET plan_status = 'trialing', trial_ends_at = ?,
                trial_started_at = COALESCE(trial_started_at, datetime('now')) WHERE id = ?`)
      .run(newEnd, org.id);
    superAudit(req, org.id, 'super.trial_extend', 'org', org.id, `${org.name} +${d}d → ${newEnd.slice(0, 10)}`);
    return res.json({ ok: true, plan_status: 'trialing', trial_ends_at: newEnd });
  }

  return res.status(400).json({ error: "action must be 'revoke' or 'extend'" });
});

// ---- Subscription controls ----
// POST /api/super/orgs/:id/subscription/cancel  { immediate: boolean }
router.post('/orgs/:id/subscription/cancel', async (req, res) => {
  const org = orgRow(req.params.id);
  if (!org) return res.status(404).json({ error: 'Org not found' });
  const immediate = !!(req.body || {}).immediate;

  // No Stripe subscription on record: app-side cancel only (plan row stays for the record).
  if (!org.stripe_subscription_id) {
    db.prepare("UPDATE orgs SET plan_status = 'expired' WHERE id = ?").run(org.id);
    superAudit(req, org.id, 'super.subscription_cancel', 'org', org.id,
      `${org.name} — no Stripe sub on file; app-side plan set to expired`);
    return res.json({ ok: true, plan_status: 'expired', stripe: 'none', message: 'No Stripe subscription on file — plan set to expired.' });
  }

  const stripe = getStripe();
  if (!stripe) {
    // Stripe not configured here: still apply the app-side effect, warn loudly.
    db.prepare("UPDATE orgs SET plan_status = ? WHERE id = ?")
      .run(immediate ? 'expired' : org.plan_status, org.id);
    superAudit(req, org.id, 'super.subscription_cancel', 'org', org.id,
      `${org.name} — Stripe key missing; app-side ${immediate ? 'expired immediately' : 'left as-is'}`);
    return res.json({
      ok: true,
      plan_status: immediate ? 'expired' : org.plan_status,
      stripeWarning: 'Stripe is not configured on this server — the Stripe subscription was NOT touched. Cancel it in the Stripe dashboard.',
    });
  }

  try {
    if (immediate) {
      await stripe.subscriptions.cancel(org.stripe_subscription_id);
      db.prepare(`UPDATE orgs SET plan_status = 'expired', stripe_subscription_id = NULL,
                  stripe_cancel_at_period_end = 0 WHERE id = ?`).run(org.id);
      superAudit(req, org.id, 'super.subscription_cancel', 'org', org.id, `${org.name} — cancelled immediately`);
      return res.json({ ok: true, plan_status: 'expired' });
    }
    await stripe.subscriptions.update(org.stripe_subscription_id, { cancel_at_period_end: true });
    let periodEnd = org.current_period_end || null;
    try {
      const sub = await stripe.subscriptions.retrieve(org.stripe_subscription_id);
      if (sub.current_period_end) {
        periodEnd = new Date(sub.current_period_end * 1000).toISOString().slice(0, 19).replace('T', ' ');
        db.prepare('UPDATE orgs SET current_period_end = ? WHERE id = ?').run(periodEnd, org.id);
      }
    } catch {}
    db.prepare('UPDATE orgs SET stripe_cancel_at_period_end = 1 WHERE id = ?').run(org.id);
    superAudit(req, org.id, 'super.subscription_cancel', 'org', org.id,
      `${org.name} — set to cancel at period end${periodEnd ? ` (${periodEnd.slice(0, 10)})` : ''}`);
    return res.json({ ok: true, plan_status: org.plan_status, cancel_at_period_end: true, current_period_end: periodEnd });
  } catch (e) {
    console.error('super subscription cancel stripe:', e.message);
    return res.status(502).json({
      error: 'Stripe cancel failed: ' + e.message,
      hint: 'The app-side plan was NOT changed. Fix Stripe and retry, or change plan_status manually.',
    });
  }
});

// ---- Onboarding reset: owner sees the funnel again on next login ----
router.post('/orgs/:id/onboarding/reset', (req, res) => {
  const org = orgRow(req.params.id);
  if (!org) return res.status(404).json({ error: 'Org not found' });
  db.prepare('UPDATE orgs SET onboarding_completed_at = NULL WHERE id = ?').run(org.id);
  superAudit(req, org.id, 'super.onboarding_reset', 'org', org.id, org.name);
  res.json({ ok: true });
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
  const u = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  const guard = lastSuperadminGuard(id);
  if (guard) return res.status(400).json({ error: guard });
  // Cannot orphan an org: block if this user is the last owner of any workspace.
  const ownedOrgs = db.prepare(
    `SELECT m.org_id, o.name FROM user_orgs m JOIN orgs o ON o.id = m.org_id
     WHERE m.user_id = ? AND m.role = 'owner'`
  ).all(id);
  for (const o of ownedOrgs) {
    const owners = db.prepare(
      `SELECT COUNT(*) AS n FROM user_orgs WHERE org_id = ? AND role = 'owner' AND user_id != ?`
    ).get(o.org_id, id).n;
    if (owners === 0) {
      return res.status(400).json({
        error: `Cannot delete — this user is the last owner of workspace "${o.name}". Transfer ownership or delete the workspace first.`,
      });
    }
  }
  const memberships = db.prepare('SELECT org_id FROM user_orgs WHERE user_id = ?').all(id);
  const firstOrgId = memberships.length ? memberships[0].org_id : null;
  db.prepare('DELETE FROM user_orgs WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  superAudit(req, firstOrgId, 'super.user_delete', 'user', id,
    `${u.name || ''} <${u.email}> (${memberships.length} membership${memberships.length === 1 ? '' : 's'} removed)`);
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
    SELECT t.*, o.name AS org_name, u.name AS user_name,
      (SELECT COUNT(*) FROM support_replies r WHERE r.ticket_id = t.id) AS reply_count,
      (SELECT r2.author_type FROM support_replies r2
        WHERE r2.ticket_id = t.id ORDER BY r2.created_at DESC, r2.id DESC LIMIT 1) AS latest_reply_author
    FROM support_tickets t
    LEFT JOIN orgs o ON o.id = t.org_id
    LEFT JOIN users u ON u.id = t.user_id
    ORDER BY t.last_activity_at DESC, t.created_at DESC LIMIT 200
  `).all();
  res.json(rows);
});

// GET /api/super/tickets/:id — ticket + ordered thread + requester info (internal_note included: staff only)
router.get('/tickets/:id', (req, res) => {
  const t = db.prepare(`
    SELECT t.*, o.name AS org_name, u.name AS user_name
    FROM support_tickets t
    LEFT JOIN orgs o ON o.id = t.org_id
    LEFT JOIN users u ON u.id = t.user_id
    WHERE t.id = ?
  `).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const replies = db.prepare(
    `SELECT r.*, u.name AS author_name
     FROM support_replies r LEFT JOIN users u ON u.id = r.author_user_id
     WHERE r.ticket_id = ? ORDER BY r.created_at ASC, r.id ASC`
  ).all(t.id);
  res.json({ ticket: t, replies });
});

// POST /api/super/tickets/:id/reply — staff reply (marks first response; moves open -> pending)
router.post('/tickets/:id/reply', (req, res) => {
  const t = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const body = typeof (req.body || {}).body === 'string' ? req.body.body.trim().slice(0, 4000) : '';
  if (!body) return res.status(400).json({ error: 'Reply cannot be empty.' });

  db.prepare(
    `INSERT INTO support_replies (ticket_id, author_type, author_user_id, body)
     VALUES (?, 'staff', ?, ?)`
  ).run(t.id, req.user.id, body);
  db.prepare(
    `UPDATE support_tickets
     SET last_activity_at = datetime('now'), updated_at = datetime('now'),
         first_response_at = COALESCE(first_response_at, datetime('now')),
         status = CASE WHEN status = 'open' THEN 'pending' ELSE status END
     WHERE id = ?`
  ).run(t.id);
  res.status(201).json({ ok: true });
});

router.patch('/tickets/:id', (req, res) => {
  const { status, internal_note, priority } = req.body || {};
  const t = db.prepare('SELECT id FROM support_tickets WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (status !== undefined) {
    if (!['open', 'pending', 'closed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    db.prepare("UPDATE support_tickets SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, t.id);
  }
  if (priority !== undefined) {
    if (!['low', 'normal', 'high', 'urgent'].includes(priority)) return res.status(400).json({ error: 'Invalid priority' });
    db.prepare("UPDATE support_tickets SET priority = ?, updated_at = datetime('now') WHERE id = ?").run(priority, t.id);
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
  'eligibility_checks', 'eligibility_lookups', 'appeal_letter_templates', 'demo_requests',
  'support_tickets', 'support_replies', 'custom_scrub_rules', 'rule_suggestions',
  'baa_signatures', 'claim_batches', 'coding_jobs', 'coding_decisions',
  'ehr_connections', 'ehr_encounters', 'edi_control_numbers',
  'audit_log', 'auth_events', 'auth_rate_limits', 'mfa_codes', 'password_resets',
  'era_remittances', 'era_claim_lines',
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
