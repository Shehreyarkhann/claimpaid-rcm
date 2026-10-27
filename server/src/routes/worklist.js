const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired, requireProduct } = require('../auth');
const { FILING_SELECT, FILING_JOIN } = require('./filing');
const { logActivity } = require('../activity');

const router = express.Router();
router.use(authRequired, requireProduct('rcm'));
const canWrite = roleRequired('owner', 'biller');

// Priority-scored unified work queue for billers.
// Higher score = work it first.
router.get('/', (req, res) => {
  const { scope = 'all' } = req.query; // all | mine
  const today = new Date().toISOString().slice(0, 10);
  const items = [];
  const org = req.orgId;

  // 1. Overdue appeal follow-ups — score 1000+
  const overdue = db.prepare(`
    SELECT a.id AS appeal_id, c.id AS claim_id, c.claim_number, c.patient_name, p.name AS payer,
           (c.billed_amount - c.paid_amount) AS at_stake, a.follow_up_date, a.priority,
           u.name AS assignee_name, a.assigned_to,
           CAST(julianday('now') - julianday(a.follow_up_date) AS INTEGER) AS days_overdue
    FROM appeals a
    JOIN claims c ON c.id = a.claim_id
    JOIN payers p ON p.id = c.payer_id
    LEFT JOIN users u ON u.id = a.assigned_to
    WHERE a.org_id = ? AND a.status NOT IN ('won', 'lost')
      AND a.follow_up_date IS NOT NULL AND a.follow_up_date < ?
      ${scope === 'mine' ? 'AND a.assigned_to = ?' : ''}
    ORDER BY a.follow_up_date ASC
  `).all(...(scope === 'mine' ? [org, today, req.user.id] : [org, today]));

  for (const r of overdue) {
    items.push({
      key: `followup-${r.appeal_id}`,
      type: 'followup',
      score: 1000 + r.days_overdue,
      title: `Follow up: ${r.claim_number}`,
      subtitle: `${r.patient_name} · ${r.payer}`,
      reason: `Follow-up overdue by ${r.days_overdue} day${r.days_overdue === 1 ? '' : 's'}`,
      amount: Math.round(r.at_stake * 100) / 100,
      due: r.follow_up_date,
      claim_id: r.claim_id, appeal_id: r.appeal_id,
      assignee: r.assignee_name,
      action: { label: 'Open appeal', kind: 'appeal', id: r.appeal_id },
    });
  }

  // "Assigned to me" for claim-derived items: assignment lives on appeals
  // (claims carry no assignee), so an item is mine only when an OPEN appeal
  // on that claim is assigned to me. Unassigned claims stay in Team queue.
  const mineClaim = scope === 'mine'
    ? `AND EXISTS (SELECT 1 FROM appeals am WHERE am.claim_id = c.id AND am.org_id = ?
        AND am.status NOT IN ('won', 'lost') AND am.assigned_to = ?)`
    : '';
  const assigneeSelect = `
           (SELECT u.name FROM appeals ao LEFT JOIN users u ON u.id = ao.assigned_to
            WHERE ao.claim_id = c.id AND ao.org_id = c.org_id AND ao.status NOT IN ('won', 'lost')
            ORDER BY ao.id DESC LIMIT 1) AS assignee_name,`;

  // 2. Filing deadlines at risk — score 900 (expired) / 850 (≤14d) / 800 (≤30d)
  const atRisk = db.prepare(`
    SELECT c.id AS claim_id, c.claim_number, c.patient_name, p.name AS payer, c.status,
           (c.billed_amount - c.paid_amount) AS at_stake,${assigneeSelect}
           ${FILING_SELECT}
    FROM claims c
    JOIN payers p ON p.id = c.payer_id
    ${FILING_JOIN}
    WHERE c.org_id = ? AND c.status IN ('pending', 'in_ar', 'denied')
      AND CAST(julianday(date(c.service_date, '+' || COALESCE(fr.filing_days, 365) || ' days')) - julianday('now') AS INTEGER) <= 30
      ${mineClaim}
    ORDER BY days_until_filing ASC
    LIMIT 50
  `).all(...(scope === 'mine' ? [org, org, req.user.id] : [org]));

  for (const r of atRisk) {
    // Skip if already covered by an overdue follow-up on the same claim
    if (items.some((i) => i.claim_id === r.claim_id)) continue;
    const d = r.days_until_filing;
    const score = d < 0 ? 950 : d <= 14 ? 850 : 800;
    items.push({
      key: `filing-${r.claim_id}`,
      type: 'filing',
      score,
      title: `${d < 0 ? 'EXPIRED' : `${d}d left`}: ${r.claim_number}`,
      subtitle: `${r.patient_name} · ${r.payer} · ${r.filing_days}-day limit`,
      reason: d < 0
        ? `Timely filing EXPIRED ${-d} days ago — appeal immediately or write off`
        : `Timely filing deadline in ${d} days (${r.filing_deadline})`,
      amount: Math.round(r.at_stake * 100) / 100,
      due: r.filing_deadline,
      claim_id: r.claim_id,
      assignee: r.assignee_name || null,
      urgent: d <= 14,
      action: { label: 'Open claim', kind: 'claim', id: r.claim_id },
    });
  }

  // 3. Unworked high-dollar denials — score 700+
  // Under scope=mine these never appear: an unworked denial has no appeal,
  // so nothing assigns it to anyone — it is unassigned Team queue work.
  const unworked = scope === 'mine' ? [] : db.prepare(`
    SELECT c.id AS claim_id, c.claim_number, c.patient_name, p.name AS payer,
           c.denial_reason, (c.billed_amount - c.paid_amount) AS at_stake
    FROM claims c
    JOIN payers p ON p.id = c.payer_id
    LEFT JOIN appeals a ON a.claim_id = c.id AND a.org_id = ?
    WHERE c.org_id = ? AND c.status = 'denied' AND a.id IS NULL
    ORDER BY (c.billed_amount - c.paid_amount) DESC
    LIMIT 30
  `).all(org, org);

  for (const r of unworked) {
    if (items.some((i) => i.claim_id === r.claim_id)) continue;
    items.push({
      key: `denial-${r.claim_id}`,
      type: 'denial',
      score: 700 + Math.min(99, Math.floor(r.at_stake / 100)),
      title: `Denied: ${r.claim_number}`,
      subtitle: `${r.patient_name} · ${r.payer}`,
      reason: r.denial_reason || 'No denial reason recorded',
      amount: Math.round(r.at_stake * 100) / 100,
      claim_id: r.claim_id,
      action: { label: 'Start appeal', kind: 'start-appeal', id: r.claim_id },
    });
  }

  // 4. Stale A/R — untouched 45+ days, still open — score 500+
  const stale = db.prepare(`
    SELECT c.id AS claim_id, c.claim_number, c.patient_name, p.name AS payer, c.status,
           (c.billed_amount - c.paid_amount) AS at_stake, c.days_in_ar,${assigneeSelect}
           CAST(julianday('now') - julianday(COALESCE(c.last_touched_at, c.created_at)) AS INTEGER) AS days_untouched
    FROM claims c
    JOIN payers p ON p.id = c.payer_id
    WHERE c.org_id = ? AND c.status IN ('pending', 'in_ar')
      AND CAST(julianday('now') - julianday(COALESCE(c.last_touched_at, c.created_at)) AS INTEGER) >= 45
      ${mineClaim}
    ORDER BY days_untouched DESC
    LIMIT 30
  `).all(...(scope === 'mine' ? [org, org, req.user.id] : [org]));

  for (const r of stale) {
    if (items.some((i) => i.claim_id === r.claim_id)) continue;
    items.push({
      key: `stale-${r.claim_id}`,
      type: 'stale',
      score: 500 + Math.min(99, r.days_untouched),
      title: `Stale A/R: ${r.claim_number}`,
      subtitle: `${r.patient_name} · ${r.payer} · ${r.days_in_ar} days in A/R`,
      reason: `Untouched for ${r.days_untouched} days — needs a touch`,
      amount: Math.round(r.at_stake * 100) / 100,
      claim_id: r.claim_id,
      assignee: r.assignee_name || null,
      action: { label: 'Open claim', kind: 'claim', id: r.claim_id },
    });
  }

  items.sort((a, b) => b.score - a.score);

  const summary = {
    total: items.length,
    followups: items.filter((i) => i.type === 'followup').length,
    filingAtRisk: items.filter((i) => i.type === 'filing').length,
    unworkedDenials: items.filter((i) => i.type === 'denial').length,
    staleAR: items.filter((i) => i.type === 'stale').length,
    totalAtStake: Math.round(items.reduce((s, i) => s + (i.amount || 0), 0) * 100) / 100,
  };

  res.json({ items: items.slice(0, 100), summary });
});

// --- Mark a claim as touched (biller worked it) ---
router.post('/touch/:claimId', canWrite, (req, res) => {
  const claim = db.prepare('SELECT id, claim_number FROM claims WHERE id = ? AND org_id = ?').get(req.params.claimId, req.orgId);
  if (!claim) return res.status(404).json({ error: 'Claim not found' });
  db.prepare("UPDATE claims SET last_touched_at = datetime('now') WHERE id = ?").run(claim.id);
  logActivity(req.orgId, claim.id, req.user.id, 'touched', `Worked claim ${claim.claim_number}`);
  res.json({ ok: true });
});

// --- Bulk actions on claims ---
router.post('/bulk', canWrite, (req, res) => {
  const { claim_ids, action, value } = req.body || {};
  if (!Array.isArray(claim_ids) || claim_ids.length === 0 || claim_ids.length > 200) {
    return res.status(400).json({ error: 'Provide 1–200 claim_ids' });
  }
  const ids = claim_ids.map(Number).filter(Boolean);
  const placeholders = ids.map(() => '?').join(',');

  // Verify all belong to org
  const owned = db.prepare(`SELECT COUNT(*) AS n FROM claims WHERE id IN (${placeholders}) AND org_id = ?`).get(...ids, req.orgId).n;
  if (owned !== ids.length) return res.status(400).json({ error: 'Some claims do not belong to your organization' });

  let result;
  if (action === 'set_status') {
    const valid = ['pending', 'in_ar', 'denied', 'paid'];
    if (!valid.includes(value)) return res.status(400).json({ error: 'Invalid status' });
    result = db.prepare(`UPDATE claims SET status = ?, last_touched_at = datetime('now') WHERE id IN (${placeholders}) AND org_id = ?`)
      .run(value, ...ids, req.orgId);
  } else if (action === 'touch') {
    result = db.prepare(`UPDATE claims SET last_touched_at = datetime('now') WHERE id IN (${placeholders}) AND org_id = ?`)
      .run(...ids, req.orgId);
  } else if (action === 'start_appeals') {
    // Create appeals for denied claims that don't have one
    const denied = db.prepare(`
      SELECT c.id FROM claims c
      LEFT JOIN appeals a ON a.claim_id = c.id AND a.org_id = ?
      WHERE c.id IN (${placeholders}) AND c.org_id = ? AND c.status = 'denied' AND a.id IS NULL
    `).all(req.orgId, ...ids, req.orgId);
    const ins = db.prepare(`INSERT INTO appeals (org_id, claim_id, status, priority) VALUES (?, ?, 'open', ?)`);
    let created = 0;
    for (const d of denied) {
      ins.run(req.orgId, d.id, value || 'medium');
      created++;
    }
    return res.json({ ok: true, appeals_created: created, skipped: ids.length - created });
  } else {
    return res.status(400).json({ error: 'Unknown bulk action. Use: set_status, touch, start_appeals' });
  }
  res.json({ ok: true, updated: result.changes });
});

module.exports = router;
