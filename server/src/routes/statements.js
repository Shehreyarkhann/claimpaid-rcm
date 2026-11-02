const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired, requireProduct } = require('../auth');
const core = require('../statements-core');
const automation = require('../statements-automation');
const { statementPaymentsHeld, FEATURE_HELD_BODY } = require('../featureFlags');

// Patient statements (deploy #50): balances from ERA patient
// responsibility, statement generation, PDF, Stripe payment links, and
// payment tracking (Stripe webhook settles links; manual entry covers
// cash/check). Statement status: draft -> open (link sent) ->
// partially_paid -> paid; void releases the claims back to balances.

const router = express.Router();
router.use(authRequired, requireProduct('rcm'));
const canWrite = roleRequired('owner', 'biller');

let _stripe = null;
function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  // STRIPE_API_BASE exists so tests can point the SDK at a fake Stripe
  // (mirrors billing.js; this SDK version takes host/port/protocol).
  let cfg;
  if (process.env.STRIPE_API_BASE) {
    try {
      const u = new URL(process.env.STRIPE_API_BASE);
      cfg = { protocol: u.protocol.replace(':', ''), host: u.hostname, port: u.port || undefined };
    } catch {}
  }
  _stripe = require('stripe')(key, cfg);
  return _stripe;
}

const orgId = (req) => req.user.org_id;

// Patients with outstanding responsibility not already on a statement.
router.get('/balances', (req, res) => {
  res.json({ patients: core.patientBalances(db, orgId(req)) });
});

router.get('/', (req, res) => {
  const rows = db.prepare(
    `SELECT ps.*, (ps.amount_due - ps.amount_paid) AS balance,
       (SELECT COUNT(*) FROM statement_lines sl WHERE sl.statement_id = ps.id) AS line_count
     FROM patient_statements ps WHERE ps.org_id = ? ORDER BY ps.id DESC LIMIT 200`
  ).all(orgId(req));
  res.json(rows);
});

// ---- Payment automation (deploy #106, Phase C) ---------------------------
// Declared BEFORE /:id so 'plans' and 'reminder-settings' are not read as
// statement ids.
router.get('/reminder-settings', (req, res) => {
  res.json({
    ...automation.getReminderSettings(db, orgId(req)),
    // Autodebit rides Stripe Connect — report the hold truthfully so the
    // UI can render its state from the server, not from a guess.
    autodebit: { available: !statementPaymentsHeld(), held: statementPaymentsHeld() },
  });
});

router.put('/reminder-settings', canWrite, (req, res) => {
  try {
    const saved = automation.saveReminderSettings(db, orgId(req), {
      enabled: !!(req.body && req.body.enabled),
      cadenceDays: req.body && req.body.cadence_days,
    });
    res.json(saved);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Manual sweep for THIS workspace (the hourly scheduler covers all orgs).
router.post('/reminders/run', canWrite, async (req, res) => {
  try {
    const summary = await automation.runReminderSweep(db, { orgOnly: orgId(req) });
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: `Reminder sweep failed: ${e.message}` });
  }
});

router.get('/plans', (req, res) => {
  res.json({ plans: automation.listPlans(db, orgId(req)) });
});

router.post('/plans/:planId/cancel', canWrite, (req, res) => {
  try {
    res.json(automation.cancelPlan(db, orgId(req), Number(req.params.planId)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Autodebit enrollment for a whole plan — same FEATURE_HELD gate as every
// other Connect surface. While held, this refuses before any Stripe call;
// un-holding is the flag flip in featureFlags.js and nothing else.
router.post('/plans/:planId/autodebit', canWrite, (req, res) => {
  if (statementPaymentsHeld()) return res.status(403).json(FEATURE_HELD_BODY);
  const plan = automation.getPlan(db, orgId(req), Number(req.params.planId));
  if (!plan) return res.status(404).json({ error: 'Payment plan not found' });
  return res.status(409).json({
    code: 'AUTODEBIT_NOT_CONFIGURED',
    error: 'Saved-card autodebit needs the practice\'s Stripe Connect onboarding completed first (Settings → Payments).',
  });
});

router.get('/:id', (req, res) => {
  const stmt = core.getStatement(db, orgId(req), Number(req.params.id));
  if (!stmt) return res.status(404).json({ error: 'Statement not found' });
  res.json({
    ...stmt,
    payment_plans: automation.listPlans(db, orgId(req), stmt.id),
    reminders: automation.listReminders(db, orgId(req), stmt.id),
  });
});

router.post('/:id/patient-email', canWrite, (req, res) => {
  const stmt = core.getStatement(db, orgId(req), Number(req.params.id));
  if (!stmt) return res.status(404).json({ error: 'Statement not found' });
  const email = String((req.body && req.body.email) || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'That does not look like an email address' });
  }
  db.prepare('UPDATE patient_statements SET patient_email = ? WHERE id = ? AND org_id = ?')
    .run(email || null, stmt.id, orgId(req));
  res.json(core.getStatement(db, orgId(req), stmt.id));
});

router.get('/:id/reminders', (req, res) => {
  const stmt = core.getStatement(db, orgId(req), Number(req.params.id));
  if (!stmt) return res.status(404).json({ error: 'Statement not found' });
  res.json({ reminders: automation.listReminders(db, orgId(req), stmt.id) });
});

router.post('/:id/plans', canWrite, (req, res) => {
  try {
    const plan = automation.createPaymentPlan(db, {
      orgId: orgId(req), userId: req.user.id, statementId: Number(req.params.id),
      installments: req.body && req.body.installments,
      frequencyDays: req.body && req.body.frequency_days,
      startDate: req.body && req.body.start_date,
    });
    res.status(201).json(plan);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/:id/plans', (req, res) => {
  const stmt = core.getStatement(db, orgId(req), Number(req.params.id));
  if (!stmt) return res.status(404).json({ error: 'Statement not found' });
  res.json({ plans: automation.listPlans(db, orgId(req), stmt.id) });
});

// Autodebit enrollment for a statement balance (no plan) — same hold.
router.post('/:id/autodebit', canWrite, (req, res) => {
  if (statementPaymentsHeld()) return res.status(403).json(FEATURE_HELD_BODY);
  const stmt = core.getStatement(db, orgId(req), Number(req.params.id));
  if (!stmt) return res.status(404).json({ error: 'Statement not found' });
  return res.status(409).json({
    code: 'AUTODEBIT_NOT_CONFIGURED',
    error: 'Saved-card autodebit needs the practice\'s Stripe Connect onboarding completed first (Settings → Payments).',
  });
});

router.post('/generate', canWrite, (req, res) => {
  const { patient_name, member_id } = req.body || {};
  if (!patient_name) return res.status(400).json({ error: 'patient_name is required' });
  const stmt = core.createStatement(db, {
    orgId: orgId(req), userId: req.user.id, patient_name, member_id: member_id || null,
  });
  if (!stmt) return res.status(400).json({ error: 'No outstanding patient balance for that patient (nothing to bill, or already on an active statement)' });
  res.status(201).json(stmt);
});

router.post('/:id/payment-link', canWrite, async (req, res) => {
  // FEATURE HOLD (featureFlags.js): refused before ANY Stripe/account
  // logic — while held, no pay link can be minted by anyone.
  if (statementPaymentsHeld()) return res.status(403).json(FEATURE_HELD_BODY);
  const stmt = core.getStatement(db, orgId(req), Number(req.params.id));
  if (!stmt) return res.status(404).json({ error: 'Statement not found' });
  if (stmt.status === 'paid' || stmt.status === 'void') return res.status(409).json({ error: `Statement is ${stmt.status}` });
  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ error: 'Online payments are not configured yet (Stripe key missing). You can still record cash/check payments manually.' });
  try {
    const org = db.prepare('SELECT name, stripe_account_id FROM orgs WHERE id = ?').get(orgId(req));
    const link = await core.createStripePaymentLink(stripe, stmt, org?.name || 'Practice', org?.stripe_account_id || null);
    db.prepare(`UPDATE patient_statements SET payment_link_id = ?, payment_link_url = ?,
                status = CASE WHEN status = 'draft' THEN 'open' ELSE status END,
                sent_at = COALESCE(sent_at, datetime('now')) WHERE id = ?`)
      .run(link.id, link.url, stmt.id);
    res.json(core.getStatement(db, orgId(req), stmt.id));
  } catch (e) {
    // Connect gate: the workspace hasn't connected its own Stripe account.
    // The client turns this into a "connect Stripe" prompt — never a link
    // on the platform account (see statements-core).
    if (e.code === 'STRIPE_NOT_CONNECTED') {
      return res.status(409).json({ code: 'STRIPE_NOT_CONNECTED', error: 'Connect a Stripe account to collect patient payments.' });
    }
    console.error('Statement payment link failed:', e.message);
    res.status(502).json({ error: `Could not create the payment link: ${e.message}` });
  }
});

router.post('/:id/payments', canWrite, (req, res) => {
  const { amount, method } = req.body || {};
  const allowed = ['cash', 'check', 'card_offline', 'money_order', 'other', 'manual'];
  try {
    const { statement, duplicate } = core.recordPayment(db, {
      orgId: orgId(req), statementId: Number(req.params.id),
      amount: Number(amount), method: allowed.includes(method) ? method : 'manual',
    });
    res.status(duplicate ? 200 : 201).json(statement);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/void', canWrite, (req, res) => {
  const stmt = core.getStatement(db, orgId(req), Number(req.params.id));
  if (!stmt) return res.status(404).json({ error: 'Statement not found' });
  if (stmt.amount_paid > 0) return res.status(409).json({ error: 'Statement has payments recorded and cannot be voided' });
  if (stmt.status === 'paid' || stmt.status === 'void') return res.status(409).json({ error: `Statement is already ${stmt.status}` });
  db.prepare("UPDATE patient_statements SET status = 'void' WHERE id = ?").run(stmt.id);
  res.json(core.getStatement(db, orgId(req), stmt.id));
});

router.get('/:id/pdf', (req, res) => {
  const out = core.statementPdf(db, orgId(req), Number(req.params.id));
  if (!out) return res.status(404).json({ error: 'Statement not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.send(out.buffer);
});

module.exports = router;
