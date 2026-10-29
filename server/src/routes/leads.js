const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired } = require('../auth');
const { sendEmail } = require('../email');

const router = express.Router();

// ---- Timely-filing checklist sent to public-audit leads ----
// Standard practice-level steps; deliberately generic so every line is
// true for any payer mix. The lead's own aggregate numbers are echoed
// back at the top so the email is personal without containing any
// claim-level data (none is ever sent to the server — the audit tool
// computes everything in the visitor's browser).
function checklistText(lead) {
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const lines = [
    `Hi ${lead.name},`,
    '',
    `Your ClaimPaid deadline audit found ${lead.claims_count} open claim${lead.claims_count === 1 ? '' : 's'} with ${money(lead.dollars_at_risk)} inside the filing window (expired or due within 60 days)${lead.nearest_deadline_days !== null && lead.nearest_deadline_days !== undefined ? `, and your nearest deadline is ${lead.nearest_deadline_days} day${Math.abs(lead.nearest_deadline_days) === 1 ? '' : 's'} ${lead.nearest_deadline_days < 0 ? 'overdue' : 'away'}` : ''}.`,
    '',
    'THE TIMELY-FILING CHECKLIST',
    '',
    '1. Sort by deadline, not by balance. Work every claim oldest-deadline-first; a small claim inside its window beats a large one with months left.',
    '2. Know each payer\'s window cold. Standard published limits: Aetna 120 days, Cigna 180, UnitedHealthcare 90, Anthem 180, Medicare 365, NY Medicaid 90, Humana 180 — but your signed payer contract controls, so verify any claim you act on against the contract.',
    '3. Prove submission before you argue. For anything a payer calls late, pull the clearinghouse acceptance report and the 277CA acknowledgment first — proof of timely submission wins these appeals; memory does not.',
    '4. Separate expired from expiring. Already-expired claims need proof of timely filing or a contract exception. Claims still inside the window need to move today, while a corrected claim is still possible.',
    '5. Decide corrected claim vs. appeal per denial. Coding and demographic errors take a corrected claim; judgment calls (medical necessity, authorization) take an appeal with documentation attached.',
    '6. Attach the evidence the first time. Notes, authorizations, eligibility snapshots, and proof of other coverage belong in the first submission — most second-level appeals exist because the first one was thin.',
    '7. Calendar the follow-up when you file, not after. Set the tickler for the payer\'s response window and work no-response claims before the appeal deadline compounds the filing deadline.',
    '8. Re-run the audit weekly. Deadlines do not send reminders. A standing weekly pass over open A/R is what turns a one-time cleanup into a system.',
    '',
    'ClaimPaid runs this audit continuously inside your workspace — every open claim ranked by days left to file, with the agent drafting the appeals for your approval. Start a free trial at https://claimpaid.io/app/ if you want the standing version.',
    '',
    '— The ClaimPaid team',
    'Deadlines shown by the audit tool are the standard published timely-filing limits. Your contract with each payer controls; verify before acting.',
  ];
  return lines.join('\n');
}

// ---- POST /api/leads/audit — public deadline-audit lead (no auth) ----
// AGGREGATES ONLY. The audit tool at /audit/ computes everything in the
// browser; claim-level rows are never transmitted and this endpoint
// whitelists aggregate fields so they could not be stored if sent.
router.post('/audit', async (req, res) => {
  const body = req.body || {};
  // Honeypot: bots fill this hidden field; silently "succeed"
  if (body.website) return res.json({ ok: true });

  const clean = {
    name: typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '',
    email: typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 120) : '',
    company: typeof body.company === 'string' ? body.company.trim().slice(0, 120) : '',
  };
  if (!clean.name) return res.status(400).json({ error: 'Please enter your name.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) {
    return res.status(400).json({ error: 'Please enter a valid work email.' });
  }
  if (!clean.company) return res.status(400).json({ error: 'Please enter your company.' });

  // Aggregate whitelist — integers/money only, clamped to sane ranges.
  const aggInt = (v, max) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0;
  };
  const aggMoney = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, 1e12) : 0;
  };
  const nearestRaw = Number(body.nearest_deadline_days);
  const agg = {
    claims_count: aggInt(body.claims_count, 1000000),
    dollars_at_risk: aggMoney(body.dollars_at_risk),
    expired_count: aggInt(body.expired_count, 1000000),
    expired_dollars: aggMoney(body.expired_dollars),
    nearest_deadline_days: Number.isFinite(nearestRaw) ? Math.max(-36500, Math.min(36500, Math.floor(nearestRaw))) : null,
  };

  // Basic rate limit: max 3 leads per email per day (same style as demo requests)
  const recent = db.prepare(
    `SELECT COUNT(*) AS n FROM audit_leads WHERE email = ? AND created_at > datetime('now', '-1 day')`
  ).get(clean.email).n;
  if (recent >= 3) return res.status(429).json({ error: 'Too many requests — please try again tomorrow.' });

  const id = Number(db.prepare(
    `INSERT INTO audit_leads (name, email, company, source, claims_count, dollars_at_risk, nearest_deadline_days, expired_count, expired_dollars)
     VALUES (?, ?, ?, 'public_audit', ?, ?, ?, ?, ?)`
  ).run(clean.name, clean.email, clean.company, agg.claims_count, agg.dollars_at_risk, agg.nearest_deadline_days, agg.expired_count, agg.expired_dollars).lastInsertRowid);

  // The page promises the checklist by email — so actually send it
  // (fire-and-forget, same as the demo notify; failures are logged,
  // never surfaced as a false failure to the visitor).
  const lead = { name: clean.name, ...agg };
  sendEmail({
    to: clean.email,
    subject: 'Your ClaimPaid timely-filing checklist',
    text: checklistText(lead),
  }).catch((e) => console.error('Audit checklist email failed:', e.message));

  // Staff notify, same pattern as demo requests.
  const notifyTo = process.env.DEMO_NOTIFY_EMAIL || process.env.SMTP_FROM || 'hello@claimpaid.io';
  sendEmail({
    to: notifyTo,
    subject: `New ClaimPaid audit lead — ${clean.company}`,
    text: `Name: ${clean.name}\nEmail: ${clean.email}\nCompany: ${clean.company}\nSource: public_audit\nClaims counted: ${agg.claims_count}\nDollars at risk: $${agg.dollars_at_risk}\nExpired: ${agg.expired_count} claim(s), $${agg.expired_dollars}\nNearest deadline (days): ${agg.nearest_deadline_days === null ? '—' : agg.nearest_deadline_days}\n\nReceived: ${new Date().toISOString()}`,
  }).catch((e) => console.error('Audit lead notify email failed:', e.message));

  res.status(201).json({ ok: true, id });
});

// ---- GET /api/leads/audit — owner-only list (for follow-up) ----
router.get('/audit', authRequired, roleRequired('owner'), (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM audit_leads ORDER BY contacted ASC, created_at DESC LIMIT 200`
  ).all();
  res.json(rows);
});

// ---- PUT /api/leads/audit/:id — mark contacted (owner only) ----
router.put('/audit/:id', authRequired, roleRequired('owner'), (req, res) => {
  const { contacted } = req.body || {};
  db.prepare('UPDATE audit_leads SET contacted = ? WHERE id = ?')
    .run(contacted ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

module.exports = router;
