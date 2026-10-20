const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired } = require('../auth');

const router = express.Router();
router.use(authRequired);

const FIELDS = ['billing_npi', 'billing_tax_id', 'billing_address', 'billing_city', 'billing_state', 'billing_zip', 'billing_phone', 'billing_email'];

// --- Get org EDI settings ---
router.get('/edi-settings', (req, res) => {
  const org = db.prepare(`SELECT id, name, ${FIELDS.join(', ')} FROM orgs WHERE id = ?`).get(req.orgId);
  res.json(org);
});

// --- Update org EDI settings (owner only) ---
router.put('/edi-settings', roleRequired('owner'), (req, res) => {
  const updates = [], params = [];
  for (const f of FIELDS) {
    if (req.body[f] !== undefined) {
      if (f === 'billing_npi' && req.body[f] && !/^\d{10}$/.test(req.body[f].trim())) {
        return res.status(400).json({ error: 'Billing NPI must be exactly 10 digits' });
      }
      updates.push(`${f} = ?`);
      params.push(req.body[f]?.trim() || null);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.orgId);
  db.prepare(`UPDATE orgs SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare(`SELECT id, name, ${FIELDS.join(', ')} FROM orgs WHERE id = ?`).get(req.orgId));
});

module.exports = router;
