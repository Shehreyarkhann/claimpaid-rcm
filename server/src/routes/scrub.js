const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired, requireProduct } = require('../auth');
const { RULES, scrubClaims } = require('../scrub');

const router = express.Router();
router.use(authRequired, requireProduct('rcm'));

// --- List rules ---
router.get('/rules', (req, res) => {
  res.json(RULES.map((r) => ({ id: r.id, severity: r.severity, name: r.name })));
});

// --- Run scrub on claims ---
router.post('/run', roleRequired('owner', 'biller'), (req, res) => {
  const { claim_ids } = req.body || {};
  if (!Array.isArray(claim_ids) || !claim_ids.length) {
    return res.status(400).json({ error: 'claim_ids array is required' });
  }

  const placeholders = claim_ids.map(() => '?').join(',');
  const claims = db.prepare(`
    SELECT c.*, c.org_id FROM claims c WHERE c.id IN (${placeholders}) AND c.org_id = ?
  `).all(...claim_ids, req.orgId);

  if (!claims.length) return res.status(404).json({ error: 'No matching claims found' });

  const results = scrubClaims(claims);
  const stamp = db.prepare("UPDATE claims SET scrub_status = ?, scrubbed_at = datetime('now'), readiness_score = ? WHERE id = ?");
  for (const r of results) stamp.run(r.status, r.score, r.claim_id);

  const summary = {
    total: results.length,
    clean: results.filter((r) => r.status === 'clean').length,
    warnings: results.filter((r) => r.status === 'warnings').length,
    failed: results.filter((r) => r.status === 'failed').length,
  };
  res.json({ summary, results });
});

// --- Scrub a single claim (preview, doesn't save) ---
router.post('/preview', (req, res) => {
  const { scrubClaim } = require('../scrub');
  const claim = { ...(req.body || {}), org_id: req.orgId, id: req.body.id || -1 };
  res.json(scrubClaim(claim));
});

module.exports = router;
