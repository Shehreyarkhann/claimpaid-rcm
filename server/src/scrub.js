// Claim scrubber — pre-bill validation rules engine.
// Each rule returns null (pass) or { severity: 'error'|'warning', code, message }.

const { db } = require('./db');

const CPT_RE = /^\d{5}$/;
const ICD_RE = /^[A-TV-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/i;
const NPI_RE = /^\d{10}$/;

function splitCodes(s) {
  return String(s || '').split(/[,\s;]+/).map((c) => c.trim()).filter(Boolean);
}

const RULES = [
  {
    id: 'REQ-001', severity: 'error', name: 'Missing patient name',
    check: (c) => (!c.patient_name?.trim() ? 'Patient name is required on every claim.' : null),
  },
  {
    id: 'REQ-002', severity: 'error', name: 'Missing payer',
    check: (c) => (!c.payer_id ? 'No payer assigned — claim cannot be routed.' : null),
  },
  {
    id: 'COD-001', severity: 'error', name: 'Missing diagnosis code',
    check: (c) => {
      const codes = splitCodes(c.icd_codes);
      return codes.length === 0 ? 'At least one ICD-10 diagnosis code is required.' : null;
    },
  },
  {
    id: 'COD-002', severity: 'error', name: 'Invalid ICD-10 format',
    check: (c) => {
      const bad = splitCodes(c.icd_codes).filter((x) => !ICD_RE.test(x));
      return bad.length ? `Invalid ICD-10 format: ${bad.join(', ')}. Expected e.g. M54.5.` : null;
    },
  },
  {
    id: 'COD-003', severity: 'warning', name: 'Missing procedure code',
    check: (c) => {
      const codes = splitCodes(c.cpt_codes);
      return codes.length === 0 ? 'No CPT procedure codes — payer will deny as unprocessable.' : null;
    },
  },
  {
    id: 'COD-004', severity: 'error', name: 'Invalid CPT format',
    check: (c) => {
      const bad = splitCodes(c.cpt_codes).filter((x) => !CPT_RE.test(x));
      return bad.length ? `Invalid CPT format: ${bad.join(', ')}. Expected 5 digits, e.g. 99213.` : null;
    },
  },
  {
    id: 'NPI-001', severity: 'warning', name: 'Missing rendering NPI',
    check: (c) => (!c.rendering_npi?.trim() ? 'Rendering NPI missing — many payers reject without it.' : null),
  },
  {
    id: 'NPI-002', severity: 'error', name: 'Invalid NPI format',
    check: (c) => (c.rendering_npi?.trim() && !NPI_RE.test(c.rendering_npi.trim())
      ? 'NPI must be exactly 10 digits.' : null),
  },
  {
    id: 'AMT-001', severity: 'error', name: 'Invalid billed amount',
    check: (c) => (Number(c.billed_amount) <= 0 ? 'Billed amount must be greater than zero.' : null),
  },
  {
    id: 'DAT-001', severity: 'error', name: 'Future service date',
    check: (c) => {
      if (!c.service_date) return 'Service date is required.';
      return c.service_date > new Date().toISOString().slice(0, 10)
        ? 'Service date is in the future.' : null;
    },
  },
  {
    id: 'DAT-002', severity: 'warning', name: 'Stale service date',
    check: (c) => {
      if (!c.service_date) return null;
      const days = Math.floor((Date.now() - new Date(c.service_date).getTime()) / 86400000);
      return days > 365 ? `Service was ${days} days ago — verify timely filing before submitting.` : null;
    },
  },
  {
    id: 'FIL-001', severity: 'error', name: 'Timely filing already blown',
    check: (c) => {
      if (!c.service_date) return null;
      const rule = c.payer_id ? db.prepare(
        'SELECT filing_days FROM payer_filing_rules WHERE org_id = ? AND payer_id = ?'
      ).get(c.org_id, c.payer_id) : null;
      const days = rule?.filing_days || 365;
      const deadline = new Date(c.service_date);
      deadline.setDate(deadline.getDate() + days);
      return deadline < new Date()
        ? `Timely filing deadline passed (${deadline.toISOString().slice(0, 10)}). This claim will deny — write off or bill patient.` : null;
    },
  },
  {
    id: 'DUP-001', severity: 'warning', name: 'Possible duplicate',
    check: (c) => {
      if (!c.patient_name || !c.service_date || !c.id) return null;
      const dup = db.prepare(`
        SELECT claim_number FROM claims
        WHERE org_id = ? AND id != ? AND patient_name = ? AND service_date = ?
          AND status != 'cancelled' LIMIT 1
      `).get(c.org_id, c.id, c.patient_name, c.service_date);
      return dup ? `Possible duplicate of ${dup.claim_number} (same patient + service date).` : null;
    },
  },
];

function scrubClaim(claim) {
  const issues = [];
  for (const rule of RULES) {
    try {
      const message = rule.check(claim);
      if (message) issues.push({ rule: rule.id, severity: rule.severity, name: rule.name, message });
    } catch (e) {
      console.error(`Scrub rule ${rule.id} failed:`, e.message);
    }
  }
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  return {
    claim_id: claim.id,
    claim_number: claim.claim_number,
    status: errors > 0 ? 'failed' : warnings > 0 ? 'warnings' : 'clean',
    errors, warnings, issues,
  };
}

function scrubClaims(claims) {
  return claims.map(scrubClaim);
}

module.exports = { RULES, scrubClaim, scrubClaims };
