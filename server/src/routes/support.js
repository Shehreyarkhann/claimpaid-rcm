// Public support-ticket intake — POST /api/support (no auth).
// Mirrors the anti-spam pattern from routes/demo.js: honeypot + per-email rate limit.

const express = require('express');
const { db } = require('../db');
const { sendEmail } = require('../email');
const { authRequired } = require('../auth');

const router = express.Router();

// Columns safe to expose to customers (internal_note is staff-only, never sent here).
const TICKET_PUBLIC_COLS = `id, org_id, user_id, name, email, subject, message, status, priority,
  first_response_at, last_activity_at, sla_due_at, created_at, updated_at`;

function notifyOwner(orgId, subject, text) {
  // Per-org preference: support reply/new-ticket staff alerts. Tickets with no
  // org (or orgs on the default) still send.
  if (orgId) {
    try {
      const row = db.prepare('SELECT notify_support_replies FROM orgs WHERE id = ?').get(orgId);
      if (row && row.notify_support_replies === 0) return;
    } catch { /* column missing — send as before */ }
  }
  const notifyTo = process.env.SUPPORT_NOTIFY_EMAIL || process.env.DEMO_NOTIFY_EMAIL || process.env.SMTP_FROM || 'hello@claimpaid.io';
  sendEmail({ to: notifyTo, subject, text }).catch((e) => console.error('Support notify email failed:', e.message));
}

router.post('/', async (req, res) => {
  const { name, email, subject, message, website, org_id } = req.body || {};
  // Honeypot: bots fill this hidden field; silently "succeed"
  if (website) return res.json({ ok: true });

  const clean = {
    name: typeof name === 'string' ? name.trim().slice(0, 80) : '',
    email: typeof email === 'string' ? email.trim().toLowerCase().slice(0, 120) : '',
    subject: typeof subject === 'string' ? subject.trim().slice(0, 160) : '',
    message: typeof message === 'string' ? message.trim().slice(0, 4000) : '',
  };
  if (!clean.name) return res.status(400).json({ error: 'Please enter your name.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (!clean.subject) return res.status(400).json({ error: 'Please enter a subject.' });
  if (!clean.message) return res.status(400).json({ error: 'Please describe your issue.' });

  // Basic rate limit: max 5 tickets per email per day
  const recent = db.prepare(
    `SELECT COUNT(*) AS n FROM support_tickets WHERE email = ? AND created_at > datetime('now', '-1 day')`
  ).get(clean.email).n;
  if (recent >= 5) return res.status(429).json({ error: 'Too many requests — please try again tomorrow.' });

  // Attach org/user when the submitter is logged in (optional, best-effort)
  let orgId = null, userId = null;
  const oid = Number(org_id);
  if (Number.isInteger(oid) && oid > 0) {
    const hit = db.prepare('SELECT id FROM orgs WHERE id = ?').get(oid);
    if (hit) orgId = hit.id;
  }

  const id = Number(db.prepare(
    `INSERT INTO support_tickets (org_id, user_id, name, email, subject, message, sla_due_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+24 hours'), datetime('now'))`
  ).run(orgId, userId, clean.name, clean.email, clean.subject, clean.message).lastInsertRowid);

  notifyOwner(
    orgId,
    `ClaimPaid support ticket #${id} — ${clean.subject}`,
    `Name: ${clean.name}\nEmail: ${clean.email}\nSubject: ${clean.subject}\n\nMessage:\n${clean.message}\n\nReceived: ${new Date().toISOString()}`
  );

  res.status(201).json({ ok: true, id });
});

// ---- Customer helpdesk (authenticated org members) ----

// Org-scoped ticket lookup: ticket belongs to the caller's org, or was filed by the caller.
function findCustomerTicket(id, user) {
  return db.prepare(
    `SELECT ${TICKET_PUBLIC_COLS} FROM support_tickets
     WHERE id = ? AND (org_id = ? OR user_id = ?)`
  ).get(id, user.org_id, user.id);
}

// GET /api/support/mine — this org's tickets with reply/unread counts
router.get('/mine', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT ${TICKET_PUBLIC_COLS},
      (SELECT COUNT(*) FROM support_replies r WHERE r.ticket_id = t.id) AS reply_count,
      (SELECT COUNT(*) FROM support_replies r
        WHERE r.ticket_id = t.id AND r.author_type = 'staff'
          AND (t.customer_last_seen_at IS NULL OR r.created_at > t.customer_last_seen_at)) AS unread_staff_replies
    FROM support_tickets t
    WHERE t.org_id = ?
    ORDER BY t.last_activity_at DESC, t.id DESC
  `).all(req.orgId);
  res.json(rows);
});

// GET /api/support/:id — ticket + ordered thread (marks thread as seen by customer)
router.get('/:id', authRequired, (req, res) => {
  const t = findCustomerTicket(req.params.id, req.user);
  if (!t) return res.status(404).json({ error: 'Ticket not found' });
  const replies = db.prepare(
    `SELECT id, author_type, body, created_at FROM support_replies
     WHERE ticket_id = ? ORDER BY created_at ASC, id ASC`
  ).all(t.id);
  db.prepare(`UPDATE support_tickets SET customer_last_seen_at = datetime('now') WHERE id = ?`).run(t.id);
  res.json({ ticket: t, replies });
});

// POST /api/support/:id/reply — customer reply; reopens pending tickets
router.post('/:id/reply', authRequired, (req, res) => {
  const t = findCustomerTicket(req.params.id, req.user);
  if (!t) return res.status(404).json({ error: 'Ticket not found' });
  if (t.status === 'closed') return res.status(400).json({ error: 'This ticket is closed — please open a new one.' });
  const body = typeof (req.body || {}).body === 'string' ? req.body.body.trim().slice(0, 4000) : '';
  if (!body) return res.status(400).json({ error: 'Reply cannot be empty.' });

  db.prepare(
    `INSERT INTO support_replies (ticket_id, author_type, author_user_id, body)
     VALUES (?, 'customer', ?, ?)`
  ).run(t.id, req.user.id, body);
  db.prepare(
    `UPDATE support_tickets
     SET last_activity_at = datetime('now'), updated_at = datetime('now'),
         customer_last_seen_at = datetime('now'),
         status = CASE WHEN status = 'pending' THEN 'open' ELSE status END
     WHERE id = ?`
  ).run(t.id);

  notifyOwner(
    t.org_id,
    `ClaimPaid support ticket #${t.id} — customer replied`,
    `${req.user.name || req.user.email} replied to ticket #${t.id} (${t.subject}):\n\n${body}`
  );

  res.status(201).json({ ok: true });
});

module.exports = router;
