const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired, requireProduct } = require('../auth');

const router = express.Router();
router.use(authRequired, requireProduct('rcm'));
const canWrite = roleRequired('owner', 'biller');

const CATEGORIES = ['billing', 'appeals', 'auth', 'contact', 'general'];
const CAT_LABELS = { billing: 'Billing Tips', appeals: 'Appeals', auth: 'Prior Auth', contact: 'Contacts', general: 'General' };

// --- Empirical payer profiles, computed from the org's own claims ---
router.get('/payer-stats', (req, res) => {
  const org = req.orgId;
  const payers = db.prepare(`
    SELECT p.id, p.name,
      COUNT(c.id) AS total_claims,
      COALESCE(SUM(CASE WHEN c.status = 'paid' THEN 1 ELSE 0 END), 0) AS paid_count,
      COALESCE(SUM(CASE WHEN c.status = 'denied' THEN 1 ELSE 0 END), 0) AS denied_count,
      ROUND(AVG(c.days_in_ar), 1) AS avg_ar_days
    FROM payers p
    LEFT JOIN claims c ON c.payer_id = p.id AND c.org_id = ?
    WHERE p.org_id = ?
    GROUP BY p.id, p.name
    HAVING total_claims > 0
    ORDER BY total_claims DESC
  `).all(org, org);

  const reasonsStmt = db.prepare(`
    SELECT denial_reason, COUNT(*) AS n FROM claims
    WHERE org_id = ? AND payer_id = ? AND status = 'denied'
      AND denial_reason IS NOT NULL AND denial_reason != ''
    GROUP BY denial_reason ORDER BY n DESC LIMIT 3
  `);
  const firstPassStmt = db.prepare(`
    SELECT COUNT(*) AS n FROM claims c
    WHERE c.org_id = ? AND c.payer_id = ? AND c.status = 'paid'
      AND NOT EXISTS (SELECT 1 FROM appeals a WHERE a.claim_id = c.id AND a.org_id = ?)
  `);

  const out = payers.map((p) => {
    const topReasons = reasonsStmt.all(org, p.id);
    const firstPass = firstPassStmt.get(org, p.id, org).n;
    return {
      id: p.id,
      name: p.name,
      total_claims: p.total_claims,
      paid_count: p.paid_count,
      denied_count: p.denied_count,
      denial_rate: p.total_claims ? Math.round((p.denied_count / p.total_claims) * 1000) / 10 : 0,
      avg_ar_days: p.avg_ar_days,
      top_denial_reasons: topReasons,
      first_pass_rate: p.paid_count ? Math.round((firstPass / p.paid_count) * 1000) / 10 : null,
    };
  });
  res.json(out);
});

// --- List playbook entries ---
router.get('/', (req, res) => {
  const { category = '', payer = '', search = '' } = req.query;
  const where = ['pb.org_id = ?'];
  const params = [req.orgId];
  if (category) { where.push('pb.category = ?'); params.push(category); }
  if (payer) { where.push('p.name = ?'); params.push(payer); }
  if (search) { where.push('(pb.title LIKE ? OR pb.content LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }

  const rows = db.prepare(`
    SELECT pb.*, p.name AS payer_name, u.name AS author
    FROM payer_playbook pb
    LEFT JOIN payers p ON p.id = pb.payer_id
    LEFT JOIN users u ON u.id = pb.created_by
    WHERE ${where.join(' AND ')}
    ORDER BY pb.updated_at DESC
  `).all(...params);
  res.json({ entries: rows, categories: CAT_LABELS });
});

// --- Create entry ---
router.post('/', canWrite, (req, res) => {
  const { payer_id, title, content, category } = req.body || {};
  if (!title?.trim() || !content?.trim()) return res.status(400).json({ error: 'Title and content are required' });
  if (category && !CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });
  if (payer_id) {
    const p = db.prepare('SELECT id FROM payers WHERE id = ? AND org_id = ?').get(payer_id, req.orgId);
    if (!p) return res.status(400).json({ error: 'Payer not found' });
  }
  const id = Number(db.prepare(`
    INSERT INTO payer_playbook (org_id, payer_id, title, content, category, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.orgId, payer_id || null, title.trim(), content.trim(), category || 'general', req.user.id).lastInsertRowid);
  res.status(201).json(db.prepare('SELECT * FROM payer_playbook WHERE id = ?').get(id));
});

// --- Update entry ---
router.put('/:id', canWrite, (req, res) => {
  const existing = db.prepare('SELECT * FROM payer_playbook WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Entry not found' });
  const { title, content, category, payer_id } = req.body || {};
  const updates = [], params = [];
  if (title !== undefined) { updates.push('title = ?'); params.push(title.trim()); }
  if (content !== undefined) { updates.push('content = ?'); params.push(content.trim()); }
  if (category !== undefined) {
    if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });
    updates.push('category = ?'); params.push(category);
  }
  if (payer_id !== undefined) {
    if (payer_id !== null) {
      const p = db.prepare('SELECT id FROM payers WHERE id = ? AND org_id = ?').get(payer_id, req.orgId);
      if (!p) return res.status(400).json({ error: 'Payer not found' });
    }
    updates.push('payer_id = ?'); params.push(payer_id);
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id, req.orgId);
  db.prepare(`UPDATE payer_playbook SET ${updates.join(', ')} WHERE id = ? AND org_id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM payer_playbook WHERE id = ?').get(req.params.id));
});

// --- Delete entry ---
router.delete('/:id', canWrite, (req, res) => {
  const r = db.prepare('DELETE FROM payer_playbook WHERE id = ? AND org_id = ?').run(req.params.id, req.orgId);
  if (!r.changes) return res.status(404).json({ error: 'Entry not found' });
  res.json({ deleted: true });
});

module.exports = router;
