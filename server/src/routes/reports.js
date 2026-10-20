const express = require('express');
const { db } = require('../db');
const { authRequired } = require('../auth');

const router = express.Router();
router.use(authRequired);

const round2 = (n) => Math.round((n || 0) * 100) / 100;

function toCSV(rows, columns) {
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => esc(c.label)).join(',');
  const lines = rows.map((r) => columns.map((c) => esc(c.get(r))).join(','));
  return [header, ...lines].join('\n');
}

function sendCSV(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

const maybeCSV = (req, res, filename, rows, columns) => {
  if (req.query.format === 'csv') return sendCSV(res, filename, toCSV(rows, columns));
  res.json(rows);
};

// --- 1. A/R Aging Report: outstanding by payer x bucket ---
router.get('/ar-aging', (req, res) => {
  const rows = db.prepare(`
    SELECT p.name AS payer,
      SUM(CASE WHEN c.days_in_ar <= 30 THEN c.billed_amount - c.paid_amount ELSE 0 END) AS b0_30,
      SUM(CASE WHEN c.days_in_ar BETWEEN 31 AND 60 THEN c.billed_amount - c.paid_amount ELSE 0 END) AS b31_60,
      SUM(CASE WHEN c.days_in_ar BETWEEN 61 AND 90 THEN c.billed_amount - c.paid_amount ELSE 0 END) AS b61_90,
      SUM(CASE WHEN c.days_in_ar BETWEEN 91 AND 120 THEN c.billed_amount - c.paid_amount ELSE 0 END) AS b91_120,
      SUM(CASE WHEN c.days_in_ar > 120 THEN c.billed_amount - c.paid_amount ELSE 0 END) AS b120p,
      SUM(c.billed_amount - c.paid_amount) AS total,
      COUNT(*) AS claims
    FROM claims c JOIN payers p ON p.id = c.payer_id
    WHERE c.org_id = ? AND c.status IN ('pending', 'in_ar', 'denied')
    GROUP BY p.id ORDER BY total DESC
  `).all(req.orgId);

  const data = rows.map((r) => ({
    payer: r.payer,
    b0_30: round2(r.b0_30), b31_60: round2(r.b31_60), b61_90: round2(r.b61_90),
    b91_120: round2(r.b91_120), b120p: round2(r.b120p),
    total: round2(r.total), claims: r.claims,
  }));
  maybeCSV(req, res, 'ar-aging-report.csv', data, [
    { label: 'Payer', get: (r) => r.payer },
    { label: '0-30', get: (r) => r.b0_30 }, { label: '31-60', get: (r) => r.b31_60 },
    { label: '61-90', get: (r) => r.b61_90 }, { label: '91-120', get: (r) => r.b91_120 },
    { label: '120+', get: (r) => r.b120p }, { label: 'Total A/R', get: (r) => r.total },
    { label: 'Claims', get: (r) => r.claims },
  ]);
});

// --- 2. Denial Analysis: rate trend + by reason + by payer ---
router.get('/denial-analysis', (req, res) => {
  const trend = db.prepare(`
    SELECT substr(service_date, 1, 7) AS month,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END) AS denied
    FROM claims WHERE org_id = ?
    GROUP BY month ORDER BY month ASC LIMIT 12
  `).all(req.orgId).map((r) => ({
    month: r.month, total: r.total, denied: r.denied,
    rate: r.total ? round2((r.denied / r.total) * 100) : 0,
  }));

  const byReason = db.prepare(`
    SELECT denial_reason AS reason, COUNT(*) AS count,
      COALESCE(SUM(billed_amount), 0) AS billed,
      (SELECT COUNT(*) FROM appeals a JOIN claims c2 ON c2.id = a.claim_id
       WHERE c2.denial_reason = claims.denial_reason AND a.org_id = ? AND a.status = 'won') AS won
    FROM claims WHERE org_id = ? AND status = 'denied'
    GROUP BY denial_reason ORDER BY count DESC
  `).all(req.orgId, req.orgId).map((r) => ({
    reason: r.reason, count: r.count, billed: round2(r.billed), appealsWon: r.won || 0,
  }));

  const byPayer = db.prepare(`
    SELECT p.name AS payer, COUNT(*) AS total,
      SUM(CASE WHEN c.status = 'denied' THEN 1 ELSE 0 END) AS denied
    FROM claims c JOIN payers p ON p.id = c.payer_id
    WHERE c.org_id = ? GROUP BY p.id ORDER BY denied DESC
  `).all(req.orgId).map((r) => ({
    payer: r.payer, total: r.total, denied: r.denied,
    rate: r.total ? round2((r.denied / r.total) * 100) : 0,
  }));

  if (req.query.format === 'csv') {
    return sendCSV(res, 'denial-analysis.csv', toCSV(byReason, [
      { label: 'Denial Reason', get: (r) => r.reason },
      { label: 'Count', get: (r) => r.count },
      { label: 'Billed $', get: (r) => r.billed },
      { label: 'Appeals Won', get: (r) => r.appealsWon },
    ]));
  }
  res.json({ trend, byReason, byPayer });
});

// --- 3. Team Productivity ---
router.get('/productivity', (req, res) => {
  const { days = 30 } = req.query;
  const since = new Date();
  since.setDate(since.getDate() - parseInt(days));

  // Touches per user from activity log
  const touches = db.prepare(`
    SELECT u.id, u.name, u.role, COUNT(*) AS touches
    FROM claim_activity ca JOIN users u ON u.id = ca.user_id
    WHERE ca.org_id = ? AND ca.created_at >= ?
    GROUP BY u.id ORDER BY touches DESC
  `).all(req.orgId, since.toISOString().slice(0, 10)).map((r) => ({
    id: r.id, name: r.name, role: r.role, touches: r.touches,
  }));

  // Appeals per assignee
  const appeals = db.prepare(`
    SELECT u.id, u.name,
      COUNT(*) AS total,
      SUM(CASE WHEN a.status = 'won' THEN 1 ELSE 0 END) AS won,
      SUM(CASE WHEN a.status = 'lost' THEN 1 ELSE 0 END) AS lost,
      SUM(CASE WHEN a.status NOT IN ('won','lost') THEN 1 ELSE 0 END) AS open,
      COALESCE(SUM(CASE WHEN a.status = 'won' THEN c.billed_amount ELSE 0 END), 0) AS recovered
    FROM appeals a
    LEFT JOIN users u ON u.id = a.assigned_to
    JOIN claims c ON c.id = a.claim_id
    WHERE a.org_id = ?
    GROUP BY u.id ORDER BY recovered DESC
  `).all(req.orgId).map((r) => ({
    name: r.name || 'Unassigned', total: r.total, won: r.won, lost: r.lost, open: r.open,
    recovered: round2(r.recovered),
    winRate: (r.won + r.lost) > 0 ? round2((r.won / (r.won + r.lost)) * 100) : 0,
  }));

  if (req.query.format === 'csv') {
    return sendCSV(res, 'team-productivity.csv', toCSV(appeals, [
      { label: 'Team Member', get: (r) => r.name },
      { label: 'Appeals', get: (r) => r.total },
      { label: 'Won', get: (r) => r.won }, { label: 'Lost', get: (r) => r.lost },
      { label: 'Open', get: (r) => r.open }, { label: 'Win Rate %', get: (r) => r.winRate },
      { label: '$ Recovered', get: (r) => r.recovered },
    ]));
  }
  res.json({ touches, appeals, periodDays: parseInt(days) });
});

// --- 4. Collections Summary ---
router.get('/collections', (req, res) => {
  const monthly = db.prepare(`
    SELECT substr(service_date, 1, 7) AS month,
      COALESCE(SUM(billed_amount), 0) AS billed,
      COALESCE(SUM(paid_amount), 0) AS collected,
      COUNT(*) AS claims
    FROM claims WHERE org_id = ?
    GROUP BY month ORDER BY month ASC LIMIT 12
  `).all(req.orgId).map((r) => ({
    month: r.month, billed: round2(r.billed), collected: round2(r.collected), claims: r.claims,
    rate: r.billed ? round2((r.collected / r.billed) * 100) : 0,
  }));

  const byPayer = db.prepare(`
    SELECT p.name AS payer,
      COALESCE(SUM(c.billed_amount), 0) AS billed,
      COALESCE(SUM(c.paid_amount), 0) AS collected,
      COUNT(*) AS claims
    FROM claims c JOIN payers p ON p.id = c.payer_id
    WHERE c.org_id = ? GROUP BY p.id ORDER BY collected DESC
  `).all(req.orgId).map((r) => ({
    payer: r.payer, billed: round2(r.billed), collected: round2(r.collected), claims: r.claims,
    rate: r.billed ? round2((r.collected / r.billed) * 100) : 0,
  }));

  if (req.query.format === 'csv') {
    return sendCSV(res, 'collections-summary.csv', toCSV(byPayer, [
      { label: 'Payer', get: (r) => r.payer },
      { label: 'Billed $', get: (r) => r.billed },
      { label: 'Collected $', get: (r) => r.collected },
      { label: 'Collection Rate %', get: (r) => r.rate },
      { label: 'Claims', get: (r) => r.claims },
    ]));
  }
  res.json({ monthly, byPayer });
});

// --- 5. Filing Compliance ---
router.get('/filing-compliance', (req, res) => {
  const { FILING_SELECT, FILING_JOIN } = require('./filing');
  const rows = db.prepare(`
    SELECT p.name AS payer,
      COUNT(*) AS total,
      SUM(CASE WHEN CAST(julianday(date(c.service_date, '+' || COALESCE(fr.filing_days, 365) || ' days')) - julianday('now') AS INTEGER) < 0 THEN 1 ELSE 0 END) AS expired,
      SUM(CASE WHEN CAST(julianday(date(c.service_date, '+' || COALESCE(fr.filing_days, 365) || ' days')) - julianday('now') AS INTEGER) BETWEEN 0 AND 30 THEN 1 ELSE 0 END) AS at_risk
    FROM claims c
    JOIN payers p ON p.id = c.payer_id
    ${FILING_JOIN}
    WHERE c.org_id = ? AND c.status IN ('pending', 'in_ar', 'denied')
    GROUP BY p.id ORDER BY expired DESC
  `).all(req.orgId).map((r) => ({
    payer: r.payer, total: r.total, expired: r.expired || 0, atRisk: r.at_risk || 0,
    onTime: r.total ? round2(((r.total - (r.expired || 0)) / r.total) * 100) : 100,
  }));

  if (req.query.format === 'csv') {
    // Full at-risk claim list for the morning huddle
    const atRisk = db.prepare(`
      SELECT c.claim_number, c.patient_name, p.name AS payer, c.service_date,
             c.billed_amount, c.paid_amount, c.status,
             date(c.service_date, '+' || COALESCE(fr.filing_days, 365) || ' days') AS filing_deadline,
             CAST(julianday(date(c.service_date, '+' || COALESCE(fr.filing_days, 365) || ' days')) - julianday('now') AS INTEGER) AS days_left
      FROM claims c JOIN payers p ON p.id = c.payer_id ${FILING_JOIN}
      WHERE c.org_id = ? AND c.status IN ('pending','in_ar','denied')
        AND CAST(julianday(date(c.service_date, '+' || COALESCE(fr.filing_days, 365) || ' days')) - julianday('now') AS INTEGER) <= 30
      ORDER BY days_left ASC
    `).all(req.orgId);
    return sendCSV(res, 'filing-at-risk.csv', toCSV(atRisk, [
      { label: 'Claim #', get: (r) => r.claim_number },
      { label: 'Patient', get: (r) => r.patient_name },
      { label: 'Payer', get: (r) => r.payer },
      { label: 'Service Date', get: (r) => r.service_date },
      { label: 'Filing Deadline', get: (r) => r.filing_deadline },
      { label: 'Days Left', get: (r) => r.days_left },
      { label: 'Billed $', get: (r) => r.billed_amount },
      { label: 'Status', get: (r) => r.status },
    ]));
  }
  res.json(rows);
});

module.exports = router;
