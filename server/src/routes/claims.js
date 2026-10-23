const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { db } = require('../db');
const { authRequired, roleRequired, requireProduct } = require('../auth');
const { FILING_SELECT, FILING_JOIN } = require('./filing');
const { logActivity } = require('../activity');
const { auditLog } = require('../audit');
const { generate837P } = require('../edi837');

const router = express.Router();
router.use(authRequired, requireProduct('rcm'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const VALID_STATUSES = ['pending', 'in_ar', 'denied', 'paid'];
const canWrite = roleRequired('owner', 'biller');

// --- List claims ---
router.get('/', (req, res) => {
  const { search = '', status = '', payer = '', page = 1, limit = 25 } = req.query;
  const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);

  const where = ['c.org_id = ?'];
  const params = [req.orgId];

  if (search) { where.push('(c.claim_number LIKE ? OR c.patient_name LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  if (status) { where.push('c.status = ?'); params.push(status); }
  if (payer) { where.push('p.name = ?'); params.push(payer); }

  const whereClause = `WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM claims c JOIN payers p ON p.id = c.payer_id ${whereClause}`).get(...params).n;
  const rows = db.prepare(`
    SELECT c.id, c.claim_number, c.patient_name, p.name AS payer,
           c.service_date, c.billed_amount, c.paid_amount, c.status,
           c.denial_reason, c.days_in_ar, c.readiness_score,
           ${FILING_SELECT}
    FROM claims c JOIN payers p ON p.id = c.payer_id
    ${FILING_JOIN}
    ${whereClause} ORDER BY c.service_date DESC LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);

  res.json({ total, page: parseInt(page), limit: parseInt(limit), claims: rows });
});

router.get('/meta/payers', (req, res) => {
  res.json(db.prepare('SELECT id, name, type FROM payers WHERE org_id = ? ORDER BY name').all(req.orgId));
});

const PAYER_TYPES = ['Commercial', 'Government', 'Patient'];

// --- Create payer (owner only) + its filing rule in one shot ---
router.post('/meta/payers', roleRequired('owner'), (req, res) => {
  const { name, type, filing_days } = req.body || {};
  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (!cleanName || cleanName.length > 80) {
    return res.status(400).json({ error: 'Payer name is required (max 80 characters)' });
  }
  if (!PAYER_TYPES.includes(type)) {
    return res.status(400).json({ error: `Type must be one of: ${PAYER_TYPES.join(', ')}` });
  }
  const days = filing_days == null || filing_days === '' ? 365 : filing_days;
  if (!Number.isInteger(days) || days < 1 || days > 730) {
    return res.status(400).json({ error: 'Filing deadline must be 1–730 days' });
  }
  const dup = db.prepare('SELECT id FROM payers WHERE org_id = ? AND LOWER(name) = LOWER(?)')
    .get(req.orgId, cleanName);
  if (dup) return res.status(409).json({ error: 'That payer already exists' });

  // node:sqlite has no db.transaction() — explicit BEGIN/COMMIT
  db.exec('BEGIN');
  try {
    const payerId = Number(db.prepare(
      'INSERT INTO payers (org_id, name, type) VALUES (?, ?, ?)'
    ).run(req.orgId, cleanName, type).lastInsertRowid);
    db.prepare(
      'INSERT INTO payer_filing_rules (org_id, payer_id, filing_days) VALUES (?, ?, ?)'
    ).run(req.orgId, payerId, days);
    db.exec('COMMIT');
    auditLog(req, 'create', 'payer', payerId, `${cleanName} (${type}, ${days}d filing)`);
    res.status(201).json({ id: payerId, name: cleanName, type, filing_days: days });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

router.get('/template/csv', (req, res) => {
  const header = 'claim_number,patient_name,payer,service_date,billed_amount,paid_amount,status,denial_reason';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="claims_template.csv"');
  res.send(`${header}\nCLM-900001,Jane Doe,Aetna,2026-10-15,2500.00,0,pending,\n`);
});

router.get('/:id', (req, res) => {
  const row = db.prepare(`
    SELECT c.*, p.name AS payer, p.type AS payer_type
    FROM claims c JOIN payers p ON p.id = c.payer_id
    WHERE c.id = ? AND c.org_id = ?
  `).get(req.params.id, req.orgId);
  if (!row) return res.status(404).json({ error: 'Claim not found' });
  row.activity = db.prepare(`
    SELECT ca.*, u.name AS user_name
    FROM claim_activity ca LEFT JOIN users u ON u.id = ca.user_id
    WHERE ca.claim_id = ? AND ca.org_id = ?
    ORDER BY ca.created_at DESC LIMIT 30
  `).all(req.params.id, req.orgId);
  auditLog(req, 'view', 'claim', req.params.id, row.claim_number);
  res.json(row);
});

function resolvePayerId(orgId, payerName) {
  if (!payerName) return null;
  const row = db.prepare('SELECT id FROM payers WHERE org_id = ? AND LOWER(name) = LOWER(?)').get(orgId, payerName.trim());
  return row ? row.id : null;
}

function validateClaimInput(orgId, body, isUpdate = false) {
  const errors = [];
  if (!isUpdate || body.claim_number !== undefined) {
    if (!body.claim_number || typeof body.claim_number !== 'string') errors.push('claim_number is required');
  }
  if (!isUpdate || body.patient_name !== undefined) {
    if (!body.patient_name || typeof body.patient_name !== 'string') errors.push('patient_name is required');
  }
  if (!isUpdate || body.payer !== undefined) {
    if (!body.payer || !resolvePayerId(orgId, body.payer)) errors.push('payer must be a known payer for your organization');
  }
  if (!isUpdate || body.service_date !== undefined) {
    if (!body.service_date || !/^\d{4}-\d{2}-\d{2}$/.test(body.service_date)) errors.push('service_date must be YYYY-MM-DD');
  }
  if (!isUpdate || body.billed_amount !== undefined) {
    if (body.billed_amount === undefined || isNaN(Number(body.billed_amount)) || Number(body.billed_amount) < 0)
      errors.push('billed_amount must be a non-negative number');
  }
  if (body.status !== undefined && !VALID_STATUSES.includes(body.status)) errors.push(`status must be one of: ${VALID_STATUSES.join(', ')}`);
  if (body.paid_amount !== undefined && (isNaN(Number(body.paid_amount)) || Number(body.paid_amount) < 0))
    errors.push('paid_amount must be a non-negative number');
  return errors;
}

const daysBetween = (d) => Math.max(0, Math.floor((new Date() - new Date(d)) / 86400000));

router.post('/', canWrite, (req, res) => {
  const errors = validateClaimInput(req.orgId, req.body);
  if (errors.length) return res.status(400).json({ errors });

  try {
    const result = db.prepare(`
      INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date, billed_amount, paid_amount, status, denial_reason, days_in_ar, cpt_codes, icd_codes, rendering_npi, rendering_provider)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.orgId, req.body.claim_number.trim(), req.body.patient_name.trim(),
      resolvePayerId(req.orgId, req.body.payer), req.body.service_date,
      Number(req.body.billed_amount), Number(req.body.paid_amount || 0),
      req.body.status || 'pending', req.body.denial_reason || null,
      daysBetween(req.body.service_date),
      req.body.cpt_codes?.trim() || null, req.body.icd_codes?.trim() || null,
      req.body.rendering_npi?.trim() || null, req.body.rendering_provider?.trim() || null);
    const newId = Number(result.lastInsertRowid);
    logActivity(req.orgId, newId, req.user.id, 'created', `Claim ${req.body.claim_number.trim()} created`);
    res.status(201).json(db.prepare('SELECT c.*, p.name AS payer FROM claims c JOIN payers p ON p.id = c.payer_id WHERE c.id = ?').get(newId));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Claim number already exists in your organization' });
    throw e;
  }
});

router.put('/:id', canWrite, (req, res) => {
  const existing = db.prepare('SELECT * FROM claims WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Claim not found' });

  const errors = validateClaimInput(req.orgId, req.body, true);
  if (errors.length) return res.status(400).json({ errors });

  const updates = [], params = [];
  if (req.body.patient_name !== undefined) { updates.push('patient_name = ?'); params.push(req.body.patient_name.trim()); }
  if (req.body.payer !== undefined) { updates.push('payer_id = ?'); params.push(resolvePayerId(req.orgId, req.body.payer)); }
  if (req.body.service_date !== undefined) { updates.push('service_date = ?', 'days_in_ar = ?'); params.push(req.body.service_date, daysBetween(req.body.service_date)); }
  if (req.body.billed_amount !== undefined) { updates.push('billed_amount = ?'); params.push(Number(req.body.billed_amount)); }
  if (req.body.paid_amount !== undefined) { updates.push('paid_amount = ?'); params.push(Number(req.body.paid_amount)); }
  if (req.body.status !== undefined) { updates.push('status = ?'); params.push(req.body.status); }
  if (req.body.denial_reason !== undefined) { updates.push('denial_reason = ?'); params.push(req.body.denial_reason || null); }
  for (const f of ['cpt_codes', 'icd_codes', 'rendering_npi', 'rendering_provider']) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]?.trim() || null); }
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  params.push(req.params.id, req.orgId);
  db.prepare(`UPDATE claims SET ${updates.join(', ')} WHERE id = ? AND org_id = ?`).run(...params);
  const changedFields = Object.keys(req.body).filter((k) => k !== 'denial_reason' || req.body[k]).join(', ');
  logActivity(req.orgId, req.params.id, req.user.id, 'updated', `Updated: ${changedFields}`);
  res.json(db.prepare('SELECT c.*, p.name AS payer FROM claims c JOIN payers p ON p.id = c.payer_id WHERE c.id = ?').get(req.params.id));
});

router.delete('/:id', canWrite, (req, res) => {
  db.prepare('DELETE FROM appeal_notes WHERE appeal_id IN (SELECT id FROM appeals WHERE claim_id = ?)').run(req.params.id);
  db.prepare('DELETE FROM appeals WHERE claim_id = ? AND org_id = ?').run(req.params.id, req.orgId);
  const result = db.prepare('DELETE FROM claims WHERE id = ? AND org_id = ?').run(req.params.id, req.orgId);
  if (result.changes === 0) return res.status(404).json({ error: 'Claim not found' });
  res.json({ deleted: true });
});

// --- Export 837P EDI file for selected claims ---
router.post('/export-837', canWrite, (req, res) => {
  const { claim_ids } = req.body || {};
  if (!Array.isArray(claim_ids) || !claim_ids.length) {
    return res.status(400).json({ error: 'claim_ids array is required' });
  }
  const placeholders = claim_ids.map(() => '?').join(',');
  const claims = db.prepare(`
    SELECT c.*, p.name AS payer_name FROM claims c
    LEFT JOIN payers p ON p.id = c.payer_id
    WHERE c.id IN (${placeholders}) AND c.org_id = ?
  `).all(...claim_ids, req.orgId);
  if (!claims.length) return res.status(404).json({ error: 'No matching claims found' });

  const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(req.orgId);
  if (!org.billing_npi) {
    return res.status(400).json({ error: 'Set your billing NPI in Team → EDI Settings before exporting.' });
  }

  const edi = generate837P(claims, org, { name: claims[0].payer_name });
  auditLog(req, 'export', 'claim_837', null, `${claims.length} claims → 837P`);
  const filename = `claims-837P-${new Date().toISOString().slice(0, 10)}-${claims.length}claims.txt`;
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(edi);
});

router.post('/upload/csv', canWrite, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: file)' });

  let records;
  try {
    records = parse(req.file.buffer.toString('utf-8'), { columns: true, skip_empty_lines: true, trim: true });
  } catch (e) {
    return res.status(400).json({ error: 'Could not parse CSV: ' + e.message });
  }

  const insert = db.prepare(`
    INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date, billed_amount, paid_amount, status, denial_reason, days_in_ar)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  const skipped = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i], rowNum = i + 2;
    const errors = validateClaimInput(req.orgId, {
      claim_number: r.claim_number, patient_name: r.patient_name, payer: r.payer,
      service_date: r.service_date, billed_amount: r.billed_amount,
      status: r.status || 'pending', paid_amount: r.paid_amount || 0,
    });
    if (errors.length) { skipped.push({ row: rowNum, claim_number: r.claim_number || '(missing)', errors }); continue; }
    try {
      insert.run(req.orgId, r.claim_number.trim(), r.patient_name.trim(),
        resolvePayerId(req.orgId, r.payer), r.service_date,
        Number(r.billed_amount), Number(r.paid_amount || 0),
        r.status || 'pending', r.denial_reason || null, daysBetween(r.service_date));
      inserted++;
    } catch (e) {
      skipped.push({ row: rowNum, claim_number: r.claim_number, errors: [e.message.includes('UNIQUE') ? 'Duplicate claim number' : e.message] });
    }
  }
  res.json({ inserted, skipped, total: records.length });
});

module.exports = router;
