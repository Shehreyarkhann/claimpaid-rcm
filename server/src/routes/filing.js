const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired, requireProduct } = require('../auth');
const { DEFAULT_RESPONSE_DAYS } = require('../agent/responseWindows');

const router = express.Router();
router.use(authRequired, requireProduct('rcm'));
const canWrite = roleRequired('owner', 'biller');

// Filing deadline = service_date + filing_days (SQLite date arithmetic)
const FILING_SELECT = `
  date(c.service_date, '+' || COALESCE(fr.filing_days, 365) || ' days') AS filing_deadline,
  CAST(julianday(date(c.service_date, '+' || COALESCE(fr.filing_days, 365) || ' days')) - julianday('now') AS INTEGER) AS days_until_filing,
  COALESCE(fr.filing_days, 365) AS filing_days
`;
const FILING_JOIN = `LEFT JOIN payer_filing_rules fr ON fr.payer_id = c.payer_id AND fr.org_id = c.org_id`;

// --- List filing rules with payer info ---
router.get('/rules', (req, res) => {
  const rows = db.prepare(`
    SELECT p.id AS payer_id, p.name AS payer, p.type,
           fr.filing_days, fr.notes, fr.response_days
    FROM payers p
    LEFT JOIN payer_filing_rules fr ON fr.payer_id = p.id AND fr.org_id = ?
    WHERE p.org_id = ?
    ORDER BY p.name
  `).all(req.orgId, req.orgId);
  // Default 365 for payers without a rule. Deploy #101: each rule also
  // carries the payer's TYPICAL response window (days to answer an
  // appeal) — default 30, overridable per payer per workspace, always
  // labeled "typical" in the UI (it is an expectation, not a promise).
  res.json(rows.map((r) => ({
    ...r,
    filing_days: r.filing_days ?? 365,
    is_default: r.filing_days == null,
    response_days: r.response_days ?? DEFAULT_RESPONSE_DAYS,
    response_is_default: r.response_days == null,
  })));
});

// --- Set/update a payer's filing rule ---
router.put('/rules/:payerId', canWrite, (req, res) => {
  const { filing_days, notes, response_days } = req.body || {};
  if (!Number.isInteger(filing_days) || filing_days < 1 || filing_days > 730) {
    return res.status(400).json({ error: 'filing_days must be an integer between 1 and 730' });
  }
  if (response_days !== undefined && response_days !== null
    && (!Number.isInteger(response_days) || response_days < 1 || response_days > 365)) {
    return res.status(400).json({ error: 'response_days must be an integer between 1 and 365, or null to reset to the default' });
  }
  const payer = db.prepare('SELECT id FROM payers WHERE id = ? AND org_id = ?').get(req.params.payerId, req.orgId);
  if (!payer) return res.status(404).json({ error: 'Payer not found' });

  // An omitted response_days leaves the stored override untouched;
  // an explicit null resets it to the product default.
  const existing = db.prepare(
    'SELECT response_days FROM payer_filing_rules WHERE org_id = ? AND payer_id = ?'
  ).get(req.orgId, payer.id);
  const effectiveResponseDays = response_days === undefined
    ? (existing ? existing.response_days : null)
    : response_days;
  db.prepare(`
    INSERT INTO payer_filing_rules (org_id, payer_id, filing_days, notes, response_days)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(org_id, payer_id) DO UPDATE SET filing_days = excluded.filing_days, notes = excluded.notes, response_days = excluded.response_days
  `).run(req.orgId, payer.id, filing_days, notes || null, effectiveResponseDays);
  res.json({ ok: true, filing_days, response_days: effectiveResponseDays });
});

// --- Filing deadline risk summary ---
router.get('/risk', (req, res) => {
  const rows = db.prepare(`
    SELECT
      SUM(CASE WHEN days_until_filing < 0 THEN 1 ELSE 0 END) AS expired,
      SUM(CASE WHEN days_until_filing BETWEEN 0 AND 14 THEN 1 ELSE 0 END) AS critical,
      SUM(CASE WHEN days_until_filing BETWEEN 15 AND 30 THEN 1 ELSE 0 END) AS warning,
      COALESCE(SUM(CASE WHEN days_until_filing < 0 THEN billed_amount - paid_amount ELSE 0 END), 0) AS expired_amount,
      COALESCE(SUM(CASE WHEN days_until_filing BETWEEN 0 AND 14 THEN billed_amount - paid_amount ELSE 0 END), 0) AS critical_amount
    FROM (
      SELECT c.billed_amount AS billed_amount, c.paid_amount AS paid_amount, ${FILING_SELECT}
      FROM claims c ${FILING_JOIN}
      WHERE c.org_id = ? AND c.status IN ('pending', 'in_ar', 'denied')
    )
  `).get(req.orgId);
  res.json({
    expired: rows.expired || 0,
    critical: rows.critical || 0,
    warning: rows.warning || 0,
    expiredAmount: Math.round((rows.expired_amount || 0) * 100) / 100,
    criticalAmount: Math.round((rows.critical_amount || 0) * 100) / 100,
  });
});

// --- Claims approaching/exceeded filing deadline ---
router.get('/at-risk', (req, res) => {
  const { days = 30 } = req.query;
  const rows = db.prepare(`
    SELECT c.id, c.claim_number, c.patient_name, p.name AS payer,
           c.service_date, c.billed_amount, c.paid_amount, c.status,
           (c.billed_amount - c.paid_amount) AS at_stake,
           ${FILING_SELECT}
    FROM claims c
    JOIN payers p ON p.id = c.payer_id
    ${FILING_JOIN}
    WHERE c.org_id = ? AND c.status IN ('pending', 'in_ar', 'denied')
      AND CAST(julianday(date(c.service_date, '+' || COALESCE(fr.filing_days, 365) || ' days')) - julianday('now') AS INTEGER) <= ?
    ORDER BY days_until_filing ASC
    LIMIT 100
  `).all(req.orgId, parseInt(days));
  res.json(rows);
});

module.exports = router;
module.exports.FILING_SELECT = FILING_SELECT;
module.exports.FILING_JOIN = FILING_JOIN;
