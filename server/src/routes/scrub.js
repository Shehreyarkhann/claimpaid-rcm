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

  // Denial Copilot (Phase B): a real scrub run APPLIES the computed
  // auto-corrections (preview never does), logs each one to
  // rule_applications, and counts every custom-rule match as a hit.
  try {
    const bumpHit = db.prepare("UPDATE custom_scrub_rules SET hit_count = hit_count + 1, last_hit_at = datetime('now') WHERE id = ? AND org_id = ?");
    const logApp = db.prepare('INSERT INTO rule_applications (org_id, rule_id, claim_id, action_type, detail) VALUES (?, ?, ?, ?, ?)');
    const setCpts = db.prepare('UPDATE claims SET cpt_codes = ? WHERE id = ? AND org_id = ?');
    for (const r of results) {
      for (const rid of r.matched_rule_ids || []) bumpHit.run(rid, req.orgId);
      r.fixes_applied = [];
      for (const f of r.fixes || []) {
        setCpts.run(f.after, r.claim_id, req.orgId);
        logApp.run(req.orgId, f.rule_id, r.claim_id, f.action_type, f.message);
        r.fixes_applied.push(f);
      }
    }
  } catch (e) {
    console.error('Copilot fix application failed:', e.message);
  }

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
