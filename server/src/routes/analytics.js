const express = require('express');
const { db } = require('../db');
const { authRequired, requireProduct } = require('../auth');

const router = express.Router();
const round2 = (n) => Math.round((n || 0) * 100) / 100;

router.use(authRequired, requireProduct('rcm'));

// --- KPI summary cards ---
router.get('/kpis', (req, res) => {
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total_claims,
      COALESCE(SUM(billed_amount), 0) AS total_billed,
      COALESCE(SUM(paid_amount), 0) AS total_paid,
      COALESCE(SUM(CASE WHEN status IN ('pending','in_ar','denied') THEN billed_amount - paid_amount ELSE 0 END), 0) AS total_ar,
      COALESCE(SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END), 0) AS denied_count,
      COALESCE(SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END), 0) AS paid_count
    FROM claims WHERE org_id = ?
  `).get(req.orgId);

  const avgDays = db.prepare(`
    SELECT COALESCE(AVG(days_in_ar), 0) AS avg_days FROM claims
    WHERE org_id = ? AND status IN ('pending', 'in_ar', 'denied')
  `).get(req.orgId);

  const openAppeals = db.prepare(`
    SELECT COUNT(*) AS n FROM appeals WHERE org_id = ? AND status NOT IN ('won', 'lost')
  `).get(req.orgId).n;

  const cleanClaimRate = totals.total_claims ? round2((totals.paid_count / totals.total_claims) * 100) : 0;
  const denialRate = totals.total_claims ? round2((totals.denied_count / totals.total_claims) * 100) : 0;

  res.json({
    totalBilled: round2(totals.total_billed),
    totalCollected: round2(totals.total_paid),
    totalAR: round2(totals.total_ar),
    avgDaysInAR: Math.round(avgDays.avg_days),
    cleanClaimRate,
    denialRate,
    totalClaims: totals.total_claims,
    openAppeals,
  });
});

// --- A/R aging buckets ---
router.get('/ar-aging', (req, res) => {
  const rows = db.prepare(`
    SELECT
      CASE
        WHEN days_in_ar <= 30 THEN '0–30'
        WHEN days_in_ar <= 60 THEN '31–60'
        WHEN days_in_ar <= 90 THEN '61–90'
        WHEN days_in_ar <= 120 THEN '91–120'
        ELSE '120+'
      END AS bucket,
      COALESCE(SUM(billed_amount - paid_amount), 0) AS amount,
      COUNT(*) AS count
    FROM claims
    WHERE org_id = ? AND status IN ('pending', 'in_ar', 'denied')
    GROUP BY bucket
  `).all(req.orgId);

  const order = ['0–30', '31–60', '61–90', '91–120', '120+'];
  res.json(order.map((bucket) => {
    const found = rows.find((r) => r.bucket === bucket);
    return { bucket, amount: round2(found ? found.amount : 0), count: found ? found.count : 0 };
  }));
});

// --- Monthly revenue trend (last 12 months) ---
router.get('/revenue-trend', (req, res) => {
  const rows = db.prepare(`
    SELECT substr(service_date, 1, 7) AS month,
           COALESCE(SUM(billed_amount), 0) AS billed,
           COALESCE(SUM(paid_amount), 0) AS collected
    FROM claims WHERE org_id = ?
    GROUP BY month ORDER BY month ASC LIMIT 12
  `).all(req.orgId);
  res.json(rows.map((r) => ({ month: r.month, billed: round2(r.billed), collected: round2(r.collected) })));
});

// --- Denials by reason ---
router.get('/denials-by-reason', (req, res) => {
  const rows = db.prepare(`
    SELECT denial_reason AS reason, COUNT(*) AS count, COALESCE(SUM(billed_amount), 0) AS amount
    FROM claims WHERE org_id = ? AND status = 'denied'
    GROUP BY denial_reason ORDER BY count DESC
  `).all(req.orgId);
  res.json(rows.map((r) => ({ reason: r.reason, count: r.count, amount: round2(r.amount) })));
});

// --- Payer mix ---
router.get('/payer-mix', (req, res) => {
  const rows = db.prepare(`
    SELECT p.name AS payer, p.type AS type,
           COALESCE(SUM(c.billed_amount), 0) AS billed,
           COALESCE(SUM(c.paid_amount), 0) AS collected,
           COUNT(*) AS claims
    FROM claims c JOIN payers p ON p.id = c.payer_id
    WHERE c.org_id = ?
    GROUP BY p.id ORDER BY billed DESC
  `).all(req.orgId);
  res.json(rows.map((r) => ({
    payer: r.payer, type: r.type,
    billed: round2(r.billed), collected: round2(r.collected), claims: r.claims,
  })));
});

// --- Appeal funnel stats ---
router.get('/appeal-stats', (req, res) => {
  const rows = db.prepare(`
    SELECT a.status AS status, COUNT(*) AS n, COALESCE(SUM(c.billed_amount - c.paid_amount), 0) AS at_stake
    FROM appeals a JOIN claims c ON c.id = a.claim_id
    WHERE a.org_id = ?
    GROUP BY a.status
  `).all(req.orgId);
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = { count: r.n, atStake: round2(r.at_stake) };
  const won = byStatus.won?.count || 0;
  const lost = byStatus.lost?.count || 0;
  const winRate = won + lost > 0 ? round2((won / (won + lost)) * 100) : 0;
  res.json({ byStatus, winRate });
});

// --- Denial pattern detection: payer x reason clusters ---
// Flags systemic issues: same payer denying the same way repeatedly.
router.get('/denial-patterns', (req, res) => {
  const { days = 90, minCount = 4 } = req.query;
  const since = new Date();
  since.setDate(since.getDate() - parseInt(days));

  const clusters = db.prepare(`
    SELECT p.name AS payer, c.denial_reason,
      COUNT(*) AS n, SUM(c.billed_amount - c.paid_amount) AS at_stake,
      MIN(c.service_date) AS first_seen, MAX(c.service_date) AS last_seen
    FROM claims c
    LEFT JOIN payers p ON p.id = c.payer_id
    WHERE c.org_id = ? AND c.status = 'denied'
      AND c.created_at >= ?
      AND c.denial_reason IS NOT NULL AND c.denial_reason != ''
    GROUP BY p.id, c.denial_reason
    HAVING COUNT(*) >= ?
    ORDER BY at_stake DESC
  `).all(req.orgId, since.toISOString().slice(0, 10), parseInt(minCount));

  const withTrend = clusters.map((cl) => {
    const recent = db.prepare(`
      SELECT COUNT(*) AS n FROM claims c LEFT JOIN payers p ON p.id = c.payer_id
      WHERE c.org_id = ? AND c.status = 'denied' AND p.name = ?
        AND c.denial_reason = ? AND c.created_at >= date('now', '-30 days')
    `).get(req.orgId, cl.payer, cl.denial_reason).n;
    return {
      ...cl,
      at_stake: round2(cl.at_stake),
      recent_30d: recent,
      trend: recent > cl.n / 2 ? 'worsening' : recent < cl.n / 4 ? 'improving' : 'steady',
    };
  });

  res.json({ patterns: withTrend, periodDays: parseInt(days), minCount: parseInt(minCount) });
});

// --- Auto-escalation ---
// Stale appeals (no update in 21+ days) get priority bumped; unappealed aging denials flagged.
router.post('/escalate', (req, res) => {
  const stale = db.prepare(`
    SELECT id, priority, claim_id FROM appeals
    WHERE org_id = ? AND status IN ('submitted', 'in_progress')
      AND updated_at < date('now', '-21 days')
      AND priority IN ('low', 'medium')
  `).all(req.orgId);

  const bumped = [];
  for (const a of stale) {
    db.prepare("UPDATE appeals SET priority = 'high' WHERE id = ?").run(a.id);
    db.prepare(`INSERT INTO appeal_notes (appeal_id, user_id, note) VALUES (?, ?, ?)`)
      .run(a.id, req.user.id, '⚠️ Auto-escalated to high priority — no update in 21+ days.');
    db.prepare(`
      INSERT INTO claim_activity (org_id, claim_id, user_id, action, detail)
      VALUES (?, ?, ?, 'escalated', 'Appeal auto-escalated to high priority after 21 days without update')
    `).run(req.orgId, a.claim_id, req.user.id);
    bumped.push(a.id);
  }

  const unappealed = db.prepare(`
    SELECT c.id, c.claim_number, c.patient_name, c.billed_amount - c.paid_amount AS at_stake
    FROM claims c LEFT JOIN appeals a ON a.claim_id = c.id
    WHERE c.org_id = ? AND c.status = 'denied' AND a.id IS NULL
      AND c.created_at < date('now', '-14 days')
    ORDER BY at_stake DESC LIMIT 10
  `).all(req.orgId);

  res.json({ escalated: bumped.length, escalated_ids: bumped, unappealed_denials: unappealed });
});

module.exports = router;
