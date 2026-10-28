const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired, requireProduct } = require('../auth');
const { logActivity } = require('../activity');
const { computeWorklist } = require('../worklistCore');

const router = express.Router();
router.use(authRequired, requireProduct('rcm'));
const canWrite = roleRequired('owner', 'biller');

// Priority-scored unified work queue for billers.
// Higher score = work it first. (Computation lives in ../worklistCore.js,
// shared with the agent's get_worklist tool.)
router.get('/', (req, res) => {
  const { scope = 'all' } = req.query; // all | mine
  res.json(computeWorklist(req.orgId, req.user.id, scope));
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
