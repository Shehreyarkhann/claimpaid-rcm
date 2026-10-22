const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired, requireProduct } = require('../auth');

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
           fr.filing_days, fr.notes
    FROM payers p
    LEFT JOIN payer_filing_rules fr ON fr.payer_id = p.id AND fr.org_id = ?
    WHERE p.org_id = ?
    ORDER BY p.name
  `).all(req.orgId, req.orgId);
  // Default 365 for payers without a rule
  res.json(rows.map((r) => ({ ...r, filing_days: r.filing_days ?? 365, is_default: r.filing_days == null })));
});

// --- Set/update a payer's filing rule ---
router.put('/rules/:payerId', canWrite, (req, res) => {
  const { filing_days, notes } = req.body || {};
  if (!Number.isInteger(filing_days) || filing_days < 1 || filing_days > 730) {
    return res.status(400).json({ error: 'filing_days must be an integer between 1 and 730' });
  }
  const payer = db.prepare('SELECT id FROM payers WHERE id = ? AND org_id = ?').get(req.params.payerId, req.orgId);
  if (!payer) return res.status(404).json({ error: 'Payer not found' });

  db.prepare(`
    INSERT INTO payer_filing_rules (org_id, payer_id, filing_days, notes)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(org_id, payer_id) DO UPDATE SET filing_days = excluded.filing_days, notes = excluded.notes
  `).run(req.orgId, payer.id, filing_days, notes || null);
  res.json({ ok: true, filing_days });
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
