const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired, requireProduct } = require('../auth');

const router = express.Router();
router.use(authRequired, requireProduct('rcm'));
const canWrite = roleRequired('owner', 'biller');

const STATUSES = ['active', 'inactive', 'unknown'];
const STATUS_LABELS = { active: 'Active', inactive: 'Inactive', unknown: 'Not verified' };

// --- List ---
router.get('/', (req, res) => {
  const { status = '', payer = '', search = '' } = req.query;
  const where = ['e.org_id = ?'];
  const params = [req.orgId];
  if (status) { where.push('e.coverage_status = ?'); params.push(status); }
  if (payer) { where.push('p.name = ?'); params.push(payer); }
  if (search) { where.push('e.patient_name LIKE ?'); params.push(`%${search}%`); }

  const rows = db.prepare(`
    SELECT e.*, p.name AS payer_name, u.name AS checked_by_name
    FROM eligibility_checks e
    LEFT JOIN payers p ON p.id = e.payer_id
    LEFT JOIN users u ON u.id = e.checked_by
    WHERE ${where.join(' AND ')}
    ORDER BY e.service_date ASC
  `).all(...params);
  res.json({ checks: rows, statuses: STATUS_LABELS });
});

// --- Stats ---
router.get('/stats', (req, res) => {
  const byStatus = db.prepare(`
    SELECT coverage_status, COUNT(*) AS n FROM eligibility_checks
    WHERE org_id = ? GROUP BY coverage_status
  `).all(req.orgId);

  const upcoming = db.prepare(`
    SELECT COUNT(*) AS n FROM eligibility_checks
    WHERE org_id = ? AND coverage_status = 'unknown'
      AND service_date IS NOT NULL AND service_date >= date('now')
      AND service_date <= date('now', '+7 days')
  `).get(req.orgId).n;

  res.json({
    byStatus: Object.fromEntries(byStatus.map((r) => [r.coverage_status, r.n])),
    upcomingUnverified: upcoming,
    total: byStatus.reduce((a, r) => a + r.n, 0),
  });
});

// --- Create ---
router.post('/', canWrite, (req, res) => {
  const b = req.body || {};
  if (!b.patient_name?.trim()) return res.status(400).json({ error: 'Patient name is required' });
  if (b.coverage_status && !STATUSES.includes(b.coverage_status)) {
    return res.status(400).json({ error: 'Invalid coverage status' });
  }
  if (b.payer_id) {
    const p = db.prepare('SELECT id FROM payers WHERE id = ? AND org_id = ?').get(b.payer_id, req.orgId);
    if (!p) return res.status(400).json({ error: 'Payer not found' });
  }

  const id = Number(db.prepare(`
    INSERT INTO eligibility_checks
      (org_id, patient_name, payer_id, service_date, coverage_status, verified_via,
       effective_date, term_date, copay, deductible_remaining, notes, checked_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.orgId, b.patient_name.trim(), b.payer_id || null, b.service_date || null,
    b.coverage_status || 'unknown', b.verified_via || null, b.effective_date || null,
    b.term_date || null, b.copay ?? null, b.deductible_remaining ?? null,
    b.notes?.trim() || null, req.user.id,
  ).lastInsertRowid);
  res.status(201).json(db.prepare('SELECT * FROM eligibility_checks WHERE id = ?').get(id));
});

// --- Update ---
router.put('/:id', canWrite, (req, res) => {
  const existing = db.prepare('SELECT * FROM eligibility_checks WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Record not found' });

  const b = req.body || {};
  const updates = [], params = [];
  const fields = ['patient_name', 'service_date', 'verified_via', 'effective_date', 'term_date', 'copay', 'deductible_remaining', 'notes'];
  for (const f of fields) {
    if (b[f] !== undefined) { updates.push(`${f} = ?`); params.push(b[f] === '' ? null : b[f]); }
  }
  if (b.coverage_status !== undefined) {
    if (!STATUSES.includes(b.coverage_status)) return res.status(400).json({ error: 'Invalid coverage status' });
    updates.push('coverage_status = ?'); params.push(b.coverage_status);
    updates.push('checked_by = ?'); params.push(req.user.id);
  }
  if (b.payer_id !== undefined) {
    if (b.payer_id !== null) {
      const p = db.prepare('SELECT id FROM payers WHERE id = ? AND org_id = ?').get(b.payer_id, req.orgId);
      if (!p) return res.status(400).json({ error: 'Payer not found' });
    }
    updates.push('payer_id = ?'); params.push(b.payer_id);
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id, req.orgId);
  db.prepare(`UPDATE eligibility_checks SET ${updates.join(', ')} WHERE id = ? AND org_id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM eligibility_checks WHERE id = ?').get(req.params.id));
});

// --- Delete ---
router.delete('/:id', canWrite, (req, res) => {
  const r = db.prepare('DELETE FROM eligibility_checks WHERE id = ? AND org_id = ?').run(req.params.id, req.orgId);
  if (!r.changes) return res.status(404).json({ error: 'Record not found' });
  res.json({ deleted: true });
});

module.exports = router;
