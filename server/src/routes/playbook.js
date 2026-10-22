const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired, requireProduct } = require('../auth');

const router = express.Router();
router.use(authRequired, requireProduct('rcm'));
const canWrite = roleRequired('owner', 'biller');

const CATEGORIES = ['billing', 'appeals', 'auth', 'contact', 'general'];
const CAT_LABELS = { billing: 'Billing Tips', appeals: 'Appeals', auth: 'Prior Auth', contact: 'Contacts', general: 'General' };

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
