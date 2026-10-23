// Public support-ticket intake — POST /api/support (no auth).
// Mirrors the anti-spam pattern from routes/demo.js: honeypot + per-email rate limit.

const express = require('express');
const { db } = require('../db');
const { sendEmail } = require('../email');

const router = express.Router();

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
    `INSERT INTO support_tickets (org_id, user_id, name, email, subject, message)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(orgId, userId, clean.name, clean.email, clean.subject, clean.message).lastInsertRowid);

  const notifyTo = process.env.SUPPORT_NOTIFY_EMAIL || process.env.DEMO_NOTIFY_EMAIL || process.env.SMTP_FROM || 'hello@claimpaid.io';
  sendEmail({
    to: notifyTo,
    subject: `ClaimPaid support ticket #${id} — ${clean.subject}`,
    text: `Name: ${clean.name}\nEmail: ${clean.email}\nSubject: ${clean.subject}\n\nMessage:\n${clean.message}\n\nReceived: ${new Date().toISOString()}`,
  }).catch((e) => console.error('Support notify email failed:', e.message));

  res.status(201).json({ ok: true, id });
});

module.exports = router;
