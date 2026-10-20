const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired } = require('../auth');
const { logActivity } = require('../activity');
const { auditLog } = require('../audit');

const router = express.Router();
router.use(authRequired);
const canWrite = roleRequired('owner', 'biller');

const STATUSES = ['draft', 'submitted', 'pending_info', 'approved', 'denied', 'expired', 'cancelled'];
const STATUS_LABELS = {
  draft: 'Draft', submitted: 'Submitted', pending_info: 'Info Needed',
  approved: 'Approved', denied: 'Denied', expired: 'Expired', cancelled: 'Cancelled',
};

// Allowed transitions (expired is computed, but allow manual set for edge cases)
const TRANSITIONS = {
  draft: ['submitted', 'cancelled'],
  submitted: ['pending_info', 'approved', 'denied', 'cancelled'],
  pending_info: ['submitted', 'approved', 'denied', 'cancelled'],
  approved: ['expired', 'cancelled'],
  denied: ['submitted', 'cancelled'], // re-submit after fixing
  expired: ['submitted', 'cancelled'], // re-request
  cancelled: ['draft'],
};

const AUTH_SELECT = `
  ar.*,
  p.name AS payer_name,
  u.name AS assignee_name,
  c.claim_number AS linked_claim_number,
  CASE
    WHEN ar.status = 'approved' AND ar.valid_to IS NOT NULL
    THEN CAST(julianday(ar.valid_to) - julianday('now') AS INTEGER)
    ELSE NULL
  END AS days_to_expiry,
  CASE
    WHEN ar.status = 'submitted' OR ar.status = 'pending_info'
    THEN CAST(julianday('now') - julianday(ar.requested_date) AS INTEGER)
    ELSE NULL
  END AS days_waiting
`;

// --- List with filters ---
router.get('/', (req, res) => {
  const { status = '', payer = '', search = '', assignee = '', expiring = '' } = req.query;
  const where = ['ar.org_id = ?'];
  const params = [req.orgId];
  if (status) { where.push('ar.status = ?'); params.push(status); }
  if (payer) { where.push('p.name = ?'); params.push(payer); }
  if (assignee === 'me') { where.push('ar.assigned_to = ?'); params.push(req.user.id); }
  else if (assignee === 'unassigned') { where.push('ar.assigned_to IS NULL'); }
  if (search) {
    where.push('(ar.patient_name LIKE ? OR ar.auth_number LIKE ? OR ar.cpt_codes LIKE ? OR ar.provider LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }
  if (expiring) {
    where.push(`ar.status = 'approved' AND ar.valid_to IS NOT NULL AND CAST(julianday(ar.valid_to) - julianday('now') AS INTEGER) <= ?`);
    params.push(parseInt(expiring));
  }

  const rows = db.prepare(`
    SELECT ${AUTH_SELECT}
    FROM auth_requests ar
    LEFT JOIN payers p ON p.id = ar.payer_id
    LEFT JOIN users u ON u.id = ar.assigned_to
    LEFT JOIN claims c ON c.id = ar.linked_claim_id
    WHERE ${where.join(' AND ')}
    ORDER BY
      CASE ar.status WHEN 'pending_info' THEN 0 WHEN 'submitted' THEN 1 WHEN 'draft' THEN 2 WHEN 'approved' THEN 3 ELSE 4 END,
      ar.needed_by_date ASC
  `).all(...params);

  // Derive effective status: approved + past valid_to = expired
  const data = rows.map((r) => ({
    ...r,
    effective_status: r.status === 'approved' && r.days_to_expiry !== null && r.days_to_expiry < 0 ? 'expired' : r.status,
  }));
  res.json({ auths: data, statuses: STATUS_LABELS });
});

// --- Stats ---
router.get('/stats', (req, res) => {
  const byStatus = db.prepare(`
    SELECT status, COUNT(*) AS n FROM auth_requests WHERE org_id = ? GROUP BY status
  `).all(req.orgId);

  const expiring = db.prepare(`
    SELECT COUNT(*) AS n FROM auth_requests
    WHERE org_id = ? AND status = 'approved' AND valid_to IS NOT NULL
      AND CAST(julianday(valid_to) - julianday('now') AS INTEGER) BETWEEN 0 AND 14
  `).get(req.orgId).n;

  const expired = db.prepare(`
    SELECT COUNT(*) AS n FROM auth_requests
    WHERE org_id = ? AND status = 'approved' AND valid_to IS NOT NULL
      AND CAST(julianday(valid_to) - julianday('now') AS INTEGER) < 0
  `).get(req.orgId).n;

  const turnaround = db.prepare(`
    SELECT p.name AS payer,
      COUNT(*) AS decided,
      ROUND(AVG(CAST(julianday(ar.updated_at) - julianday(ar.requested_date) AS REAL)), 1) AS avg_days,
      SUM(CASE WHEN ar.status = 'approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN ar.status = 'denied' THEN 1 ELSE 0 END) AS denied
    FROM auth_requests ar LEFT JOIN payers p ON p.id = ar.payer_id
    WHERE ar.org_id = ? AND ar.status IN ('approved', 'denied') AND ar.requested_date IS NOT NULL
    GROUP BY p.id ORDER BY decided DESC
  `).all(req.orgId).map((r) => ({
    ...r,
    approval_rate: r.decided ? Math.round((r.approved / r.decided) * 100) : 0,
  }));

  const totals = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status IN ('approved','denied') THEN 1 ELSE 0 END) AS decided,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved
    FROM auth_requests WHERE org_id = ?
  `).get(req.orgId);

  res.json({
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    expiringSoon: expiring,
    expiredUnhandled: expired,
    turnaround,
    approvalRate: totals.decided ? Math.round((totals.approved / totals.decided) * 100) : 0,
    total: totals.total,
  });
});

// --- Suggest auths for a denied claim (the cross-linking feature) ---
router.get('/find-for-claim/:claimId', (req, res) => {
  const claim = db.prepare('SELECT * FROM claims WHERE id = ? AND org_id = ?').get(req.params.claimId, req.orgId);
  if (!claim) return res.status(404).json({ error: 'Claim not found' });

  const matches = db.prepare(`
    SELECT ${AUTH_SELECT}
    FROM auth_requests ar
    LEFT JOIN payers p ON p.id = ar.payer_id
    LEFT JOIN users u ON u.id = ar.assigned_to
    LEFT JOIN claims c ON c.id = ar.linked_claim_id
    WHERE ar.org_id = ?
      AND (ar.patient_name = ? OR ar.payer_id = ?)
    ORDER BY
      CASE WHEN ar.patient_name = ? AND ar.payer_id = ? THEN 0
           WHEN ar.patient_name = ? THEN 1 ELSE 2 END,
      ar.created_at DESC
    LIMIT 10
  `).all(req.orgId, claim.patient_name, claim.payer_id, claim.patient_name, claim.payer_id, claim.patient_name);

  res.json({
    claim: { id: claim.id, claim_number: claim.claim_number, patient_name: claim.patient_name, denial_reason: claim.denial_reason },
    matches: matches.map((r) => ({
      ...r,
      effective_status: r.status === 'approved' && r.days_to_expiry !== null && r.days_to_expiry < 0 ? 'expired' : r.status,
    })),
  });
});

// --- Detail ---
router.get('/:id', (req, res) => {
  const row = db.prepare(`
    SELECT ${AUTH_SELECT}
    FROM auth_requests ar
    LEFT JOIN payers p ON p.id = ar.payer_id
    LEFT JOIN users u ON u.id = ar.assigned_to
    LEFT JOIN claims c ON c.id = ar.linked_claim_id
    WHERE ar.id = ? AND ar.org_id = ?
  `).get(req.params.id, req.orgId);
  if (!row) return res.status(404).json({ error: 'Authorization not found' });
  row.effective_status = row.status === 'approved' && row.days_to_expiry !== null && row.days_to_expiry < 0 ? 'expired' : row.status;
  row.notes = db.prepare(`
    SELECT an.*, u.name AS user_name FROM auth_notes an
    LEFT JOIN users u ON u.id = an.user_id
    WHERE an.auth_id = ? AND an.org_id = ? ORDER BY an.created_at DESC
  `).all(req.params.id, req.orgId);
  auditLog(req, 'view', 'auth_request', req.params.id, row.patient_name);
  res.json(row);
});

// --- Create ---
router.post('/', canWrite, (req, res) => {
  const b = req.body || {};
  if (!b.patient_name?.trim()) return res.status(400).json({ error: 'Patient name is required' });
  if (b.payer_id) {
    const p = db.prepare('SELECT id FROM payers WHERE id = ? AND org_id = ?').get(b.payer_id, req.orgId);
    if (!p) return res.status(400).json({ error: 'Payer not found' });
  }
  if (b.assigned_to) {
    const u = db.prepare('SELECT id FROM users WHERE id = ? AND org_id = ?').get(b.assigned_to, req.orgId);
    if (!u) return res.status(400).json({ error: 'Assignee not found' });
  }
  if (b.status && !STATUSES.includes(b.status)) return res.status(400).json({ error: 'Invalid status' });

  const id = Number(db.prepare(`
    INSERT INTO auth_requests
      (org_id, patient_name, payer_id, provider, cpt_codes, icd_codes, units_requested,
       service_date, requested_date, needed_by_date, status, auth_number, approved_units,
       valid_from, valid_to, denial_reason, notes, assigned_to, linked_claim_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.orgId, b.patient_name.trim(), b.payer_id || null, b.provider?.trim() || null,
    b.cpt_codes?.trim() || null, b.icd_codes?.trim() || null, b.units_requested || 1,
    b.service_date || null, b.requested_date || new Date().toISOString().slice(0, 10),
    b.needed_by_date || null, b.status || 'draft', b.auth_number?.trim() || null,
    b.approved_units || null, b.valid_from || null, b.valid_to || null,
    b.denial_reason?.trim() || null, b.notes?.trim() || null,
    b.assigned_to || null, b.linked_claim_id || null, req.user.id,
  ).lastInsertRowid);

  if (b.linked_claim_id) {
    logActivity(req.orgId, b.linked_claim_id, req.user.id, 'auth_linked', `Linked to authorization #${id}`);
  }
  res.status(201).json(db.prepare('SELECT * FROM auth_requests WHERE id = ?').get(id));
});

// --- Update (with transition validation) ---
router.put('/:id', canWrite, (req, res) => {
  const existing = db.prepare('SELECT * FROM auth_requests WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Authorization not found' });

  const b = req.body || {};
  const updates = [], params = [];

  if (b.status && b.status !== existing.status) {
    if (!STATUSES.includes(b.status)) return res.status(400).json({ error: 'Invalid status' });
    const allowed = TRANSITIONS[existing.status] || [];
    // Allow marking approved->expired automatically; block other illegal jumps
    if (!allowed.includes(b.status)) {
      return res.status(400).json({ error: `Cannot move from ${STATUS_LABELS[existing.status]} to ${STATUS_LABELS[b.status]}` });
    }
    updates.push('status = ?'); params.push(b.status);
    // Auto-stamp requested_date when first submitted
    if (b.status === 'submitted' && !existing.requested_date) {
      updates.push('requested_date = ?'); params.push(new Date().toISOString().slice(0, 10));
    }
  }

  const fields = ['patient_name', 'provider', 'cpt_codes', 'icd_codes', 'units_requested', 'service_date',
    'needed_by_date', 'auth_number', 'approved_units', 'valid_from', 'valid_to', 'denial_reason', 'notes'];
  for (const f of fields) {
    if (b[f] !== undefined) { updates.push(`${f} = ?`); params.push(b[f] === '' ? null : b[f]); }
  }
  if (b.payer_id !== undefined) {
    if (b.payer_id !== null) {
      const p = db.prepare('SELECT id FROM payers WHERE id = ? AND org_id = ?').get(b.payer_id, req.orgId);
      if (!p) return res.status(400).json({ error: 'Payer not found' });
    }
    updates.push('payer_id = ?'); params.push(b.payer_id);
  }
  if (b.assigned_to !== undefined) {
    if (b.assigned_to !== null) {
      const u = db.prepare('SELECT id FROM users WHERE id = ? AND org_id = ?').get(b.assigned_to, req.orgId);
      if (!u) return res.status(400).json({ error: 'Assignee not found' });
    }
    updates.push('assigned_to = ?'); params.push(b.assigned_to);
  }
  if (b.linked_claim_id !== undefined) {
    if (b.linked_claim_id !== null) {
      const c = db.prepare('SELECT id FROM claims WHERE id = ? AND org_id = ?').get(b.linked_claim_id, req.orgId);
      if (!c) return res.status(400).json({ error: 'Claim not found' });
    }
    updates.push('linked_claim_id = ?'); params.push(b.linked_claim_id);
  }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id, req.orgId);
  db.prepare(`UPDATE auth_requests SET ${updates.join(', ')} WHERE id = ? AND org_id = ?`).run(...params);

  if (b.linked_claim_id && b.linked_claim_id !== existing.linked_claim_id) {
    logActivity(req.orgId, b.linked_claim_id, req.user.id, 'auth_linked', `Linked to authorization #${req.params.id}`);
  }
  res.json(db.prepare('SELECT * FROM auth_requests WHERE id = ?').get(req.params.id));
});

// --- Delete ---
router.delete('/:id', canWrite, (req, res) => {
  const r = db.prepare('DELETE FROM auth_requests WHERE id = ? AND org_id = ?').run(req.params.id, req.orgId);
  if (!r.changes) return res.status(404).json({ error: 'Authorization not found' });
  db.prepare('DELETE FROM auth_notes WHERE auth_id = ?').run(req.params.id);
  res.json({ deleted: true });
});

// --- Notes ---
router.post('/:id/notes', canWrite, (req, res) => {
  const auth = db.prepare('SELECT id FROM auth_requests WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!auth) return res.status(404).json({ error: 'Authorization not found' });
  if (!req.body.note?.trim()) return res.status(400).json({ error: 'Note is required' });
  const id = Number(db.prepare(`
    INSERT INTO auth_notes (org_id, auth_id, user_id, note) VALUES (?, ?, ?, ?)
  `).run(req.orgId, req.params.id, req.user.id, req.body.note.trim()).lastInsertRowid);
  res.status(201).json(db.prepare('SELECT an.*, u.name AS user_name FROM auth_notes an LEFT JOIN users u ON u.id = an.user_id WHERE an.id = ?').get(id));
});

module.exports = router;
