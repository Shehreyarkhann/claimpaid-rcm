// Electronic claim transmission: 837P batch workflow.
//
// draft → generated → transmitted → acknowledged → accepted / rejected / partial
//
// Real submission needs a clearinghouse account (Change Healthcare, Availity,
// Waystar, Office Ally) plus per-payer enrollment. Until then:
//   - `manual` (default): the app generates a valid 837P file; the user uploads
//     it to their clearinghouse portal and EXPLICITLY confirms. The app never
//     marks a batch transmitted without that confirmation.
//   - `sftp`: drops the file into the clearinghouse's SFTP inbox.
//   - `rest`: POSTs the file to a configured HTTPS endpoint.
// 999 / 277CA ack files uploaded back drive batch + per-claim status.

const express = require('express');
const multer = require('multer');
const { db } = require('../db');
const { authRequired, roleRequired, requireProduct } = require('../auth');
const { auditLog } = require('../audit');
const { generate837P, validate837, validateClaimData } = require('../edi/generate837p');
const { parseAck } = require('../edi/parseAck');
const { transmit, orgXmitConfig, XMIT_VENDORS } = require('../edi/transmit');

const router = express.Router();
router.use(authRequired, requireProduct('rcm'));
const canWrite = roleRequired('owner', 'biller');
const ownerOnly = roleRequired('owner');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const BATCH_STATUSES = ['draft', 'generated', 'transmitted', 'acknowledged', 'accepted', 'rejected', 'partial'];
const SCRUB_OK = ['clean', 'warnings'];

function getBatch(id, orgId) {
  return db.prepare('SELECT * FROM claim_batches WHERE id = ? AND org_id = ?').get(id, orgId);
}

function batchClaims(batch) {
  const ids = JSON.parse(batch.claim_ids || '[]');
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  return db.prepare(`
    SELECT c.*, p.name AS payer_name
    FROM claims c LEFT JOIN payers p ON p.id = c.payer_id
    WHERE c.id IN (${ph}) AND c.org_id = ?
    ORDER BY c.id
  `).all(...ids, batch.org_id);
}

function nextBatchNumber(orgId) {
  // Globally unique (batch_number has a UNIQUE index) but human-readable and
  // org-scoped: B<yyyymmdd>-<orgId>-<daily seq for this org>
  const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const n = db.prepare(
    `SELECT COUNT(*) AS n FROM claim_batches WHERE org_id = ? AND batch_number LIKE ?`
  ).get(orgId, `B${yyyymmdd}-${orgId}-%`).n;
  return `B${yyyymmdd}-${orgId}-${String(n + 1).padStart(3, '0')}`;
}

function missingDataFlags(c) {
  const v = validateClaimData({ ...c, payer_name: c.payer_name });
  return v.issues;
}

// --- Transmittable claims: scrub-clean (or warnings only), not in a batch ---
router.get('/transmittable', (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.claim_number, c.patient_name, c.patient_dob, c.member_id,
           c.service_date, c.billed_amount, c.cpt_codes, c.icd_codes,
           c.scrub_status, c.readiness_score, c.x12_status, p.name AS payer_name
    FROM claims c LEFT JOIN payers p ON p.id = c.payer_id
    WHERE c.org_id = ? AND c.scrub_status IN ('clean','warnings') AND c.x12_status = 'not_sent'
    ORDER BY c.service_date DESC LIMIT 200
  `).all(req.orgId);
  res.json({
    claims: rows.map((r) => ({ ...r, missing: missingDataFlags(r) })),
  });
});

// --- Vendor config (owner only) ---
router.get('/config', ownerOnly, (req, res) => {
  res.json({ ...orgXmitConfig(req.orgId), vendors: XMIT_VENDORS });
});

router.put('/config', ownerOnly, (req, res) => {
  const b = req.body || {};
  const vendor = (b.vendor || 'manual').trim();
  if (!XMIT_VENDORS.includes(vendor)) return res.status(400).json({ error: 'Invalid vendor' });

  const updates = ['xmit_vendor = ?'];
  const params = [vendor];
  const set = (col, val) => { updates.push(`${col} = ?`); params.push(val); };

  if (b.sftp_host !== undefined) set('xmit_sftp_host', b.sftp_host?.trim() || null);
  if (b.sftp_port !== undefined) {
    const port = Number(b.sftp_port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'SFTP port must be 1–65535' });
    set('xmit_sftp_port', port);
  }
  if (b.sftp_user !== undefined) set('xmit_sftp_user', b.sftp_user?.trim() || null);
  if (b.sftp_auth !== undefined) {
    if (!['password', 'key'].includes(b.sftp_auth)) return res.status(400).json({ error: 'SFTP auth must be password or key' });
    set('xmit_sftp_auth', b.sftp_auth);
  }
  if (b.sftp_secret !== undefined && b.sftp_secret !== '') set('xmit_sftp_secret', b.sftp_secret);
  if (b.sftp_dir !== undefined) set('xmit_sftp_dir', b.sftp_dir?.trim() || '/');
  if (b.rest_endpoint !== undefined) {
    const ep = b.rest_endpoint?.trim() || '';
    if (ep && !/^https?:\/\//i.test(ep)) return res.status(400).json({ error: 'Endpoint must be an http(s) URL' });
    set('xmit_rest_endpoint', ep || null);
  }
  if (b.rest_api_key !== undefined && b.rest_api_key !== '') set('xmit_rest_api_key', b.rest_api_key);
  if (b.rest_auth_scheme !== undefined) set('xmit_rest_auth_scheme', (b.rest_auth_scheme?.trim() || 'Bearer'));

  if (vendor === 'rest' && !db.prepare('SELECT xmit_rest_endpoint FROM orgs WHERE id = ?').get(req.orgId).xmit_rest_endpoint && !b.rest_endpoint?.trim()) {
    return res.status(400).json({ error: 'Endpoint URL is required for the REST vendor' });
  }

  params.push(req.orgId);
  db.prepare(`UPDATE orgs SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ...orgXmitConfig(req.orgId), vendors: XMIT_VENDORS });
});

// --- List batches ---
router.get('/batches', (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, u.name AS created_by_name,
      (SELECT COUNT(*) FROM claims c WHERE c.last_batch_id = b.id) AS claim_count
    FROM claim_batches b LEFT JOIN users u ON u.id = b.created_by
    WHERE b.org_id = ? ORDER BY b.created_at DESC, b.id DESC LIMIT 100
  `).all(req.orgId);
  res.json({ batches: rows.map((r) => { const { edi_text, ...rest } = r; return rest; }) });
});

// --- Create draft batch ---
router.post('/batches', canWrite, (req, res) => {
  const { claim_ids } = req.body || {};
  if (!Array.isArray(claim_ids) || !claim_ids.length) {
    return res.status(400).json({ error: 'claim_ids array is required' });
  }
  if (claim_ids.length > 500) return res.status(400).json({ error: 'Max 500 claims per batch' });

  const ph = claim_ids.map(() => '?').join(',');
  const claims = db.prepare(`
    SELECT c.*, p.name AS payer_name FROM claims c
    LEFT JOIN payers p ON p.id = c.payer_id
    WHERE c.id IN (${ph}) AND c.org_id = ?
  `).all(...claim_ids, req.orgId);

  if (claims.length !== claim_ids.length) {
    return res.status(400).json({ error: 'Some claims were not found in your organization' });
  }
  const blocked = claims.filter((c) => !SCRUB_OK.includes(c.scrub_status));
  if (blocked.length) {
    return res.status(400).json({
      error: `${blocked.length} claim(s) did not pass the scrubber clean — run the scrubber and fix hard errors first`,
      blocked: blocked.map((c) => ({ id: c.id, claim_number: c.claim_number, scrub_status: c.scrub_status })),
    });
  }
  const inBatch = claims.filter((c) => c.x12_status !== 'not_sent');
  if (inBatch.length) {
    return res.status(400).json({
      error: `${inBatch.length} claim(s) are already in a transmission batch`,
      blocked: inBatch.map((c) => ({ id: c.id, claim_number: c.claim_number, x12_status: c.x12_status })),
    });
  }

  const batchNumber = nextBatchNumber(req.orgId);
  db.exec('BEGIN');
  try {
    const id = Number(db.prepare(`
      INSERT INTO claim_batches (org_id, batch_number, claim_ids, created_by)
      VALUES (?, ?, ?, ?)
    `).run(req.orgId, batchNumber, JSON.stringify(claims.map((c) => c.id)), req.user.id).lastInsertRowid);
    db.prepare(`UPDATE claims SET x12_status = 'in_batch', last_batch_id = ? WHERE id IN (${ph})`)
      .run(id, ...claims.map((c) => c.id));
    db.exec('COMMIT');
    auditLog(req, 'create', 'claim_batch', id, `${batchNumber} — ${claims.length} claims`);
    res.status(201).json(getBatch(id, req.orgId));
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// --- Batch detail (excludes edi_text bulk unless generated; includes per-claim) ---
router.get('/batches/:id', (req, res) => {
  const batch = getBatch(req.params.id, req.orgId);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  const claims = batchClaims(batch).map((c) => ({
    id: c.id, claim_number: c.claim_number, patient_name: c.patient_name,
    payer_name: c.payer_name, service_date: c.service_date, billed_amount: c.billed_amount,
    scrub_status: c.scrub_status, x12_status: c.x12_status,
    missing: missingDataFlags(c),
  }));
  res.json({ ...batch, claims });
});

// --- Generate the 837P file ---
router.post('/batches/:id/generate', canWrite, (req, res) => {
  const batch = getBatch(req.params.id, req.orgId);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  if (batch.status !== 'draft') {
    return res.status(400).json({ error: `Batch is already ${batch.status} — only draft batches can be generated` });
  }

  const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(req.orgId);
  if (!org.billing_npi || !/^\d{10}$/.test(org.billing_npi)) {
    return res.status(400).json({ error: 'Set a valid 10-digit billing NPI in EDI Settings before generating.' });
  }

  const claims = batchClaims(batch);
  if (!claims.length) return res.status(400).json({ error: 'Batch has no claims' });

  // Per-claim data validation — hard stop, listed per claim
  const dataIssues = [];
  for (const c of claims) {
    const { issues } = validateClaimData(c);
    if (issues.length) dataIssues.push({ id: c.id, claim_number: c.claim_number, issues });
  }
  if (dataIssues.length) {
    return res.status(400).json({
      error: `${dataIssues.length} claim(s) are missing data required for a valid 837P`,
      dataIssues,
    });
  }

  const { ediText, claimCount, controlNumber, batchReference } = generate837P(claims, org, { batchReference: batch.batch_number });
  const { errors } = validate837(ediText, claimCount);
  if (errors.length) {
    return res.status(500).json({ error: 'Generated 837P failed structural validation', validationErrors: errors });
  }

  db.prepare(`
    UPDATE claim_batches
    SET edi_text = ?, control_number = ?, status = 'generated', updated_at = datetime('now')
    WHERE id = ?
  `).run(ediText, controlNumber, batch.id);
  auditLog(req, 'generate', 'claim_batch', batch.id, `${batch.batch_number} — 837P generated (${claimCount} claims, ISA ${controlNumber})`);

  res.json({
    ...getBatch(batch.id, req.orgId),
    validation: {
      passed: true,
      claimCount,
      controlNumber,
      batchReference,
      segmentCount: ediText.replace(/\r?\n/g, '').split('~').filter((s) => s.trim()).length,
    },
  });
});

// --- Download the 837P file ---
router.get('/batches/:id/download', (req, res) => {
  const batch = getBatch(req.params.id, req.orgId);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  if (!batch.edi_text) return res.status(400).json({ error: 'Generate the 837P file first' });
  auditLog(req, 'export', 'claim_batch', batch.id, `${batch.batch_number} 837P downloaded`);
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="claimpaid-837P-${batch.batch_number}.txt"`);
  res.send(batch.edi_text);
});

// --- Transmit the batch ---
router.post('/batches/:id/transmit', canWrite, async (req, res) => {
  const batch = getBatch(req.params.id, req.orgId);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  if (batch.status !== 'generated') {
    return res.status(400).json({ error: `Batch is ${batch.status} — only generated batches can be transmitted` });
  }

  const cfg = orgXmitConfig(req.orgId);
  const vendor = (req.body?.vendor || cfg.vendor || 'manual').trim();
  if (!XMIT_VENDORS.includes(vendor)) return res.status(400).json({ error: 'Invalid vendor' });

  // Manual transmission is a user-confirmed handoff — never auto-claimed.
  if (vendor === 'manual' && req.body?.confirmed !== true) {
    return res.status(400).json({
      error: 'Manual transmission requires explicit confirmation that you uploaded the file to your clearinghouse portal (confirmed: true)',
    });
  }

  let result;
  try {
    result = await transmit(vendor, cfg, {
      ediText: batch.edi_text,
      batchNumber: batch.batch_number,
      controlNumber: batch.control_number,
    });
  } catch (e) {
    // Adapter failed — batch stays 'generated', nothing is marked transmitted.
    return res.status(502).json({ error: e.message });
  }

  const ids = JSON.parse(batch.claim_ids || '[]');
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE claim_batches
      SET status = 'transmitted', vendor = ?, transmitted_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(vendor, batch.id);
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      db.prepare(`UPDATE claims SET x12_status = 'transmitted' WHERE id IN (${ph})`).run(...ids);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  auditLog(req, 'transmit', 'claim_batch', batch.id, `${batch.batch_number} transmitted via ${vendor}`);
  res.json({ ...getBatch(batch.id, req.orgId), transmit: result });
});

// --- Upload a 999 / 277CA acknowledgement ---
router.post('/batches/:id/ack', canWrite, upload.single('file'), (req, res) => {
  const batch = getBatch(req.params.id, req.orgId);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  if (!['transmitted', 'acknowledged', 'partial'].includes(batch.status)) {
    return res.status(400).json({ error: `Cannot accept an ack for a ${batch.status} batch — transmit it first` });
  }
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: file)' });
  const type = (req.body?.type || '').trim();
  if (!['999', '277ca'].includes(type)) {
    return res.status(400).json({ error: "type must be '999' or '277ca'" });
  }

  const text = req.file.buffer.toString('utf-8');
  let parsed;
  try {
    parsed = parseAck(text);
  } catch (e) {
    return res.status(400).json({ error: 'Could not parse acknowledgement: ' + e.message });
  }
  if (parsed.type !== type) {
    return res.status(400).json({ error: `File parsed as ${parsed.type.toUpperCase()}, but you labeled it ${type.toUpperCase()}` });
  }

  const batchIds = new Set(JSON.parse(batch.claim_ids || '[]').map(String));
  db.exec('BEGIN');
  try {
    if (type === '999') {
      db.prepare(`UPDATE claim_batches SET ack_raw_999 = ?, status = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(text.slice(0, 200000), parsed.batchStatus, batch.id);
      if (parsed.batchStatus === 'rejected') {
        const ids = [...batchIds];
        if (ids.length) {
          const ph = ids.map(() => '?').join(',');
          db.prepare(`UPDATE claims SET x12_status = 'rejected' WHERE id IN (${ph})`).run(...ids);
        }
      }
    } else {
      db.prepare(`UPDATE claim_batches SET ack_raw_277ca = ?, status = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(text.slice(0, 200000), parsed.batchStatus, batch.id);
      for (const c of parsed.claims) {
        if (!batchIds.has(String(c.claimId))) continue; // ignore claims not in this batch
        const newStatus = c.status === 'accepted' ? 'accepted' : 'rejected';
        db.prepare('UPDATE claims SET x12_status = ? WHERE id = ?').run(newStatus, Number(c.claimId));
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  auditLog(req, 'ack', 'claim_batch', batch.id, `${batch.batch_number} ${type.toUpperCase()} processed → ${parsed.batchStatus}`);
  res.json({ ...getBatch(batch.id, req.orgId), ack: parsed });
});

// --- Delete a draft batch (releases claims back to not_sent) ---
router.delete('/batches/:id', canWrite, (req, res) => {
  const batch = getBatch(req.params.id, req.orgId);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  if (batch.status !== 'draft') {
    return res.status(400).json({ error: `Only draft batches can be deleted (this one is ${batch.status})` });
  }
  const ids = JSON.parse(batch.claim_ids || '[]');
  db.exec('BEGIN');
  try {
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      db.prepare(`UPDATE claims SET x12_status = 'not_sent', last_batch_id = NULL WHERE id IN (${ph})`).run(...ids);
    }
    db.prepare('DELETE FROM claim_batches WHERE id = ?').run(batch.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ deleted: true });
});

module.exports = router;
