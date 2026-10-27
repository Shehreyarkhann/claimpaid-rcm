const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired, requireProduct } = require('../auth');
const core = require('../statements-core');

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

router.get('/:id', (req, res) => {
  const stmt = core.getStatement(db, orgId(req), Number(req.params.id));
  if (!stmt) return res.status(404).json({ error: 'Statement not found' });
  res.json(stmt);
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
  const stmt = core.getStatement(db, orgId(req), Number(req.params.id));
  if (!stmt) return res.status(404).json({ error: 'Statement not found' });
  if (stmt.status === 'paid' || stmt.status === 'void') return res.status(409).json({ error: `Statement is ${stmt.status}` });
  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ error: 'Online payments are not configured yet (Stripe key missing). You can still record cash/check payments manually.' });
  try {
    const org = db.prepare('SELECT name FROM orgs WHERE id = ?').get(orgId(req));
    const link = await core.createStripePaymentLink(stripe, stmt, org?.name || 'Practice');
    db.prepare(`UPDATE patient_statements SET payment_link_id = ?, payment_link_url = ?,
                status = CASE WHEN status = 'draft' THEN 'open' ELSE status END,
                sent_at = COALESCE(sent_at, datetime('now')) WHERE id = ?`)
      .run(link.id, link.url, stmt.id);
    res.json(core.getStatement(db, orgId(req), stmt.id));
  } catch (e) {
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
