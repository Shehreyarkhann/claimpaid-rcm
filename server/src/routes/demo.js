const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired } = require('../auth');
const { sendEmail } = require('../email');

const router = express.Router();

// ---- POST /api/demo/requests — public demo-request form (no auth) ----
router.post('/requests', async (req, res) => {
  const { name, email, company, phone, team_size, message, website } = req.body || {};
  // Honeypot: bots fill this hidden field; silently "succeed"
  if (website) return res.json({ ok: true });

  const clean = {
    name: typeof name === 'string' ? name.trim().slice(0, 80) : '',
    email: typeof email === 'string' ? email.trim().toLowerCase().slice(0, 120) : '',
    company: typeof company === 'string' ? company.trim().slice(0, 120) : '',
    phone: typeof phone === 'string' ? phone.trim().slice(0, 30) : null,
    team_size: typeof team_size === 'string' ? team_size.trim().slice(0, 40) : null,
    message: typeof message === 'string' ? message.trim().slice(0, 2000) : null,
  };
  if (!clean.name) return res.status(400).json({ error: 'Please enter your name.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) {
    return res.status(400).json({ error: 'Please enter a valid work email.' });
  }
  if (!clean.company) return res.status(400).json({ error: 'Please enter your company.' });

  // Basic rate limit: max 3 requests per email per day
  const recent = db.prepare(
    `SELECT COUNT(*) AS n FROM demo_requests WHERE email = ? AND created_at > datetime('now', '-1 day')`
  ).get(clean.email).n;
  if (recent >= 3) return res.status(429).json({ error: 'Too many requests — please try again tomorrow.' });

  const id = Number(db.prepare(
    `INSERT INTO demo_requests (name, email, company, phone, team_size, message)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(clean.name, clean.email, clean.company, clean.phone, clean.team_size, clean.message).lastInsertRowid);

  // Optional org attribution (e.g. demo form embedded in an org-branded page).
  // Lets the org's "demo request alerts" preference gate the staff notify.
  let orgId = null;
  const oid = Number((req.body || {}).org_id);
  if (Number.isInteger(oid) && oid > 0) {
    const hit = db.prepare('SELECT id FROM orgs WHERE id = ?').get(oid);
    if (hit) orgId = hit.id;
  }

  // Notify (logs to console when email isn't configured).
  // Gated by the org's demo-request preference when an org is attached.
  let sendNotify = true;
  if (orgId) {
    try {
      const pref = db.prepare('SELECT notify_demo_requests FROM orgs WHERE id = ?').get(orgId);
      if (pref && pref.notify_demo_requests === 0) sendNotify = false;
    } catch { /* column missing — send as before */ }
  }
  if (sendNotify) {
    const notifyTo = process.env.DEMO_NOTIFY_EMAIL || process.env.SMTP_FROM || 'hello@claimpaid.io';
    sendEmail({
      to: notifyTo,
      subject: `New ClaimPaid demo request — ${clean.company}`,
      text: `Name: ${clean.name}\nEmail: ${clean.email}\nCompany: ${clean.company}\nPhone: ${clean.phone || '—'}\nTeam size: ${clean.team_size || '—'}\n\nMessage:\n${clean.message || '—'}\n\nReceived: ${new Date().toISOString()}`,
    }).catch((e) => console.error('Demo notify email failed:', e.message));
  }

  res.status(201).json({ ok: true, id });
});

// ---- GET /api/demo/requests — owner-only list (for follow-up) ----
router.get('/requests', authRequired, roleRequired('owner'), (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM demo_requests ORDER BY contacted ASC, created_at DESC LIMIT 200`
  ).all();
  res.json(rows);
});

// ---- PUT /api/demo/requests/:id — mark contacted (owner only) ----
router.put('/requests/:id', authRequired, roleRequired('owner'), (req, res) => {
  const { contacted } = req.body || {};
  db.prepare('UPDATE demo_requests SET contacted = ? WHERE id = ?')
    .run(contacted ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

module.exports = router;
