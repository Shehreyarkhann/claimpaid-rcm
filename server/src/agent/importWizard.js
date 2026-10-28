'use strict';
// CSV import wizard (agent Phase 5, WS4). Three honest steps:
//   preview  — parse the file, guess the column mapping from header
//              synonyms, and validate EVERY row (required fields, payer
//              match/create preview, amount/date parsing, duplicates
//              against the org's claims and within the file itself).
//   mapping  — the reviewer adjusts the mapping; validation recomputes.
//   commit   — the ONLY step that writes, and it writes through the
//              existing createClaimDraft path (same validation, same
//              activity log) with status forced to 'pending'.
// Preview state is a server-side, org-scoped row; nothing about a
// preview can touch another workspace, and nothing commits early.
const { parse } = require('csv-parse/sync');
const { db } = require('../db');

const FIELDS = [
  { key: 'claim_number', label: 'Claim number', required: true, synonyms: ['claim_number', 'claim number', 'claim #', 'claim no', 'claim id', 'clm', 'control number', 'claim'] },
  { key: 'patient_name', label: 'Patient name', required: true, synonyms: ['patient_name', 'patient name', 'patient', 'member name', 'subscriber', 'patient full name'] },
  { key: 'payer', label: 'Payer', required: true, synonyms: ['payer', 'payer name', 'insurance', 'insurance company', 'carrier', 'plan', 'payer_name'] },
  { key: 'service_date', label: 'Service date', required: true, synonyms: ['service_date', 'service date', 'dos', 'date of service', 'svc date', 'service dt', 'from date'] },
  { key: 'billed_amount', label: 'Billed amount', required: true, synonyms: ['billed_amount', 'billed amount', 'billed', 'charges', 'charge amount', 'total charges', 'amount billed', 'billed amt'] },
  { key: 'paid_amount', label: 'Paid amount', required: false, synonyms: ['paid_amount', 'paid amount', 'paid', 'amount paid', 'payment', 'paid amt'] },
  { key: 'status', label: 'Status', required: false, synonyms: ['status', 'claim status', 'state'] },
  { key: 'denial_reason', label: 'Denial reason', required: false, synonyms: ['denial_reason', 'denial reason', 'denial', 'reason', 'remark', 'denial code'] },
  { key: 'patient_dob', label: 'Patient DOB', required: false, synonyms: ['patient_dob', 'patient dob', 'dob', 'date of birth', 'birth date', 'birthdate'] },
  { key: 'member_id', label: 'Member ID', required: false, synonyms: ['member_id', 'member id', 'member #', 'subscriber id', 'policy number', 'insurance id', 'member no'] },
  { key: 'cpt_codes', label: 'CPT codes', required: false, synonyms: ['cpt_codes', 'cpt codes', 'cpt', 'procedure codes', 'procedures', 'cpt code'] },
  { key: 'icd_codes', label: 'ICD codes', required: false, synonyms: ['icd_codes', 'icd codes', 'icd', 'diagnosis codes', 'diagnoses', 'dx', 'icd code', 'diagnosis'] },
];
const VALID_STATUSES = ['pending', 'in_ar', 'denied', 'paid'];
const MAX_ROWS = 5000;

const TEMPLATE_CSV = [
  'claim_number,patient_name,payer,service_date,billed_amount,paid_amount,status,denial_reason,patient_dob,member_id,cpt_codes,icd_codes',
  'CLM-DEMO-001,Jane Example,Example Health Plan,2026-09-15,250.00,0.00,denied,EXAMPLE ROW — fictional — replace with your data,1990-04-12,MBR-0001,99213,M54.5',
  'CLM-DEMO-002,John Sample,Sample Mutual Insurance,2026-09-20,480.00,0.00,pending,,1985-11-30,MBR-0002,99214,J06.9',
  '',
].join('\n');

function normHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function guessMapping(headers) {
  const mapping = {};
  const usedIdx = new Set();
  for (const field of FIELDS) {
    const syns = field.synonyms.map(normHeader);
    let best = -1;
    headers.forEach((h, i) => {
      if (usedIdx.has(i)) return;
      const nh = normHeader(h);
      if (syns.includes(nh) && best === -1) best = i;
    });
    if (best === -1) {
      headers.forEach((h, i) => {
        if (usedIdx.has(i) || best !== -1) return;
        const nh = normHeader(h);
        if (syns.some((s) => nh.includes(s) || s.includes(nh))) best = i;
      });
    }
    if (best !== -1) { mapping[field.key] = headers[best]; usedIdx.add(best); }
  }
  return mapping;
}

function parseCsv(text) {
  const records = parse(text, {
    columns: false, trim: true, skip_empty_lines: true, bom: true, relax_column_count: true,
  });
  if (!records.length) { const e = new Error('The file has no rows.'); e.status = 400; throw e; }
  const headers = records[0].map((h) => String(h || '').trim());
  const rows = records.slice(1);
  if (rows.length > MAX_ROWS) {
    const e = new Error(`Too many rows (${rows.length}). Split the file — the limit is ${MAX_ROWS} rows per import.`);
    e.status = 400; throw e;
  }
  return { headers, rows };
}

function parseAmount(v) {
  if (v == null || String(v).trim() === '') return { value: null };
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return { value: null, error: `amount "${v}" is not a number` };
  if (n < 0) return { value: null, error: 'amounts cannot be negative' };
  return { value: Math.round(n * 100) / 100 };
}

function parseDateFlex(v) {
  if (v == null || String(v).trim() === '') return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return isoOrNull(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return isoOrNull(+m[3], +m[1], +m[2]);
  return null;
}

function isoOrNull(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function dupKey(claimNumber, patientName, serviceDate) {
  return `${String(claimNumber || '').trim().toLowerCase()}|${String(patientName || '').trim().toLowerCase()}|${serviceDate || ''}`;
}

// Validate every mapped row. `row` in the output is the FILE row number
// (header = row 1, first data row = row 2) so a reviewer can find the
// line in their spreadsheet.
function validateRows(orgId, headers, rawRows, mapping) {
  const { resolvePayerId } = require('../routes/claims');
  const idx = {};
  for (const field of FIELDS) {
    const header = mapping[field.key];
    idx[field.key] = header != null ? headers.indexOf(header) : -1;
  }
  const existing = new Set(db.prepare('SELECT claim_number, patient_name, service_date FROM claims WHERE org_id = ?')
    .all(orgId).map((c) => dupKey(c.claim_number, c.patient_name, c.service_date)));
  const seenInFile = new Map();

  const rows = rawRows.map((cells, i) => {
    const rowNo = i + 2;
    const get = (key) => (idx[key] >= 0 ? String(cells[idx[key]] ?? '').trim() : '');
    const values = {
      claim_number: get('claim_number'),
      patient_name: get('patient_name'),
      payer: get('payer'),
      service_date_raw: get('service_date'),
      billed_raw: get('billed_amount'),
      paid_raw: get('paid_amount'),
      status: get('status').toLowerCase(),
      denial_reason: get('denial_reason'),
      patient_dob_raw: get('patient_dob'),
      member_id: get('member_id'),
      cpt_codes: get('cpt_codes'),
      icd_codes: get('icd_codes'),
    };
    const errors = [];
    const warnings = [];

    if (!values.claim_number) errors.push('claim_number is required');
    if (!values.patient_name) errors.push('patient_name is required');
    if (!values.payer) errors.push('payer is required');
    const serviceDate = parseDateFlex(values.service_date_raw);
    if (!values.service_date_raw) errors.push('service_date is required');
    else if (!serviceDate) errors.push(`service_date "${values.service_date_raw}" is not a recognized date (use YYYY-MM-DD or MM/DD/YYYY)`);
    const billed = parseAmount(values.billed_raw);
    if (!values.billed_raw) errors.push('billed_amount is required');
    else if (billed.error) errors.push(`billed_amount: ${billed.error}`);
    const paid = parseAmount(values.paid_raw);
    if (paid.error) errors.push(`paid_amount: ${paid.error}`);
    let payerStatus = null;
    if (values.payer) {
      payerStatus = resolvePayerId(orgId, values.payer) ? 'existing' : 'new';
      if (payerStatus === 'new') warnings.push(`payer "${values.payer}" is not in this workspace yet — it will be created on import`);
    }
    if (values.status && !VALID_STATUSES.includes(values.status)) {
      warnings.push(`status "${values.status}" is not a ClaimPaid status — the claim imports as pending`);
      values.status = '';
    } else if (values.status && values.status !== 'pending') {
      warnings.push('imported claims start as pending — set the real status after import');
    }
    let dob = null;
    if (values.patient_dob_raw) {
      dob = parseDateFlex(values.patient_dob_raw);
      if (!dob) warnings.push(`patient_dob "${values.patient_dob_raw}" was not recognized — left blank`);
    }

    const key = dupKey(values.claim_number, values.patient_name, serviceDate);
    let duplicate = false;
    let duplicateOf = null;
    if (values.claim_number && serviceDate) {
      if (existing.has(key)) { duplicate = true; duplicateOf = 'an existing claim in this workspace'; }
      else if (seenInFile.has(key)) { duplicate = true; duplicateOf = `row ${seenInFile.get(key)} in this file`; }
      else seenInFile.set(key, rowNo);
    }
    if (duplicate) errors.push(`duplicate of ${duplicateOf} (same claim number, patient, and service date)`);

    return {
      row: rowNo,
      values: {
        claim_number: values.claim_number || null,
        patient_name: values.patient_name || null,
        payer: values.payer || null,
        service_date: serviceDate,
        billed_amount: billed.value,
        paid_amount: paid.value || 0,
        denial_reason: values.denial_reason || null,
        patient_dob: dob,
        member_id: values.member_id || null,
        cpt_codes: values.cpt_codes || null,
        icd_codes: values.icd_codes || null,
      },
      payer_status: payerStatus,
      duplicate,
      errors,
      warnings,
      valid: errors.length === 0,
    };
  });

  const summary = {
    total: rows.length,
    valid: rows.filter((r) => r.valid).length,
    with_warnings: rows.filter((r) => r.valid && r.warnings.length).length,
    with_errors: rows.filter((r) => !r.valid).length,
    duplicates: rows.filter((r) => r.duplicate).length,
    new_payers: [...new Set(rows.filter((r) => r.payer_status === 'new' && r.values.payer).map((r) => r.values.payer))],
  };
  return { rows, summary };
}

function serializePreview(preview) {
  let mapping = {};
  let validation = null;
  try { mapping = JSON.parse(preview.mapping || '{}'); } catch { mapping = {}; }
  try { validation = preview.validation ? JSON.parse(preview.validation) : null; } catch { validation = null; }
  let headers = [];
  try { headers = JSON.parse(preview.headers || '[]'); } catch { headers = []; }
  return {
    id: preview.id,
    filename: preview.filename || null,
    headers,
    mapping,
    fields: FIELDS.map((f) => ({ key: f.key, label: f.label, required: f.required })),
    row_count: validation ? validation.rows.length : 0,
    validation,
    created_at: preview.created_at,
  };
}

function getPreview(id, orgId) {
  // Cleanup-on-read: previews older than 7 days are swept for this org.
  db.prepare("DELETE FROM agent_import_previews WHERE org_id = ? AND created_at < datetime('now', '-7 days')").run(orgId);
  return db.prepare('SELECT * FROM agent_import_previews WHERE id = ? AND org_id = ?').get(id, orgId) || null;
}

function createPreview({ orgId, userId, filename, text }) {
  const { headers, rows } = parseCsv(text);
  const mapping = guessMapping(headers);
  const validation = validateRows(orgId, headers, rows, mapping);
  const info = db.prepare(`
    INSERT INTO agent_import_previews (org_id, user_id, filename, headers, rows, mapping, validation)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(orgId, userId, filename || null, JSON.stringify(headers), JSON.stringify(rows),
    JSON.stringify(mapping), JSON.stringify(validation));
  return getPreview(Number(info.lastInsertRowid), orgId);
}

function remapPreview(orgId, preview, mapping) {
  const headers = JSON.parse(preview.headers || '[]');
  const rawRows = JSON.parse(preview.rows || '[]');
  const clean = {};
  for (const field of FIELDS) {
    const header = mapping && mapping[field.key];
    if (header != null && headers.includes(header)) clean[field.key] = header;
  }
  const validation = validateRows(orgId, headers, rawRows, clean);
  db.prepare('UPDATE agent_import_previews SET mapping = ?, validation = ? WHERE id = ?')
    .run(JSON.stringify(clean), JSON.stringify(validation), preview.id);
  return getPreview(preview.id, orgId);
}

// Commit: the only writing step. Claims go through createClaimDraft —
// the same path the New Claim form and the 837 import use — with the
// status forced to 'pending' per the wizard contract. Payers flagged
// 'new' at preview are created first (mirrors the 837 import's
// create-missing-payers behavior). Per-row failures are counted, never
// fatal to the batch.
function commitPreview({ orgId, userId, preview }) {
  const validation = JSON.parse(preview.validation || '{"rows":[]}');
  const { createClaimDraft, resolvePayerId } = require('../routes/claims');
  let created = 0;
  let skipped = 0;
  const errors = [];
  const createdIds = [];
  const payersCreated = [];
  for (const row of validation.rows) {
    if (!row.valid) { skipped += 1; continue; }
    const v = row.values;
    try {
      if (!resolvePayerId(orgId, v.payer)) {
        db.prepare('INSERT INTO payers (org_id, name, type) VALUES (?, ?, ?)')
          .run(orgId, v.payer, 'Commercial');
        payersCreated.push(v.payer);
      }
      const claim = createClaimDraft(orgId, userId, {
        claim_number: v.claim_number,
        patient_name: v.patient_name,
        payer: v.payer,
        service_date: v.service_date,
        billed_amount: v.billed_amount,
        paid_amount: v.paid_amount || 0,
        status: 'pending',
        denial_reason: v.denial_reason,
        patient_dob: v.patient_dob,
        member_id: v.member_id,
        cpt_codes: v.cpt_codes,
        icd_codes: v.icd_codes,
      });
      created += 1;
      createdIds.push(claim.id);
    } catch (e) {
      skipped += 1;
      errors.push({ row: row.row, error: e.message });
    }
  }
  return { created, skipped, errors, created_claim_ids: createdIds, payers_created: payersCreated };
}

module.exports = {
  FIELDS, TEMPLATE_CSV, guessMapping, parseCsv, parseDateFlex, parseAmount,
  validateRows, createPreview, getPreview, remapPreview, serializePreview, commitPreview,
};
