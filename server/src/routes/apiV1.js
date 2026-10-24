// Public developer API surface (key-only auth). Proof endpoint for apiKeyAuth.
const express = require('express');
const { db } = require('../db');
const { apiKeyAuth } = require('../middleware/apiKeyAuth');
const { requireProduct } = require('../auth');

const router = express.Router();

// GET /api/v1/org/summary — workspace snapshot for the key's org.
router.get('/v1/org/summary', apiKeyAuth, requireProduct('rcm'), (req, res) => {
  const org = db.prepare('SELECT id, name, plan, plan_status, created_at FROM orgs WHERE id = ?').get(req.orgId);
  if (!org) return res.status(404).json({ error: 'Workspace not found' });
  const counts = {
    users: db.prepare('SELECT COUNT(*) c FROM user_orgs WHERE org_id = ?').get(req.orgId).c,
    claims: db.prepare('SELECT COUNT(*) c FROM claims WHERE org_id = ?').get(req.orgId).c,
    appeals: db.prepare('SELECT COUNT(*) c FROM appeals WHERE org_id = ?').get(req.orgId).c,
  };
  res.json({ ...org, ...counts });
});

module.exports = router;
