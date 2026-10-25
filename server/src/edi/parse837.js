'use strict';
// 837P (005010X222A1) claim-file parser — deploy #51.
//
// The universal inbound adapter: every EHR / practice-management system
// can export an 837. This turns that file into ClaimPaid claims so data
// never has to be re-keyed. Tolerant by design: segment order variations,
// subscriber-as-patient and dependent-patient hierarchies, claim-level or
// line-level service dates, dotted or undotted ICD-10 codes.
//
// Returns { claims: [...], errors: [...] } — a claim is only emitted once
// its CLM segment has been seen; incomplete claims land in errors with
// the reason instead of being silently dropped.

function splitSegments(text) {
  const clean = String(text || '').replace(/\r\n/g, '\n');
  // Segment terminator is '~' in practice (ISA doesn't declare it).
  return clean.split('~').map((s) => s.trim()).filter(Boolean)
    .map((s) => s.split('*').map((e) => e.trim()));
}

function ymd(raw) {
  const v = String(raw || '').trim();
  if (/^\d{8}$/.test(v)) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return null;
}

function personName(seg) {
  // NM1: [3]=last/org, [4]=first, [5]=MI
  const last = seg[3] || '';
  const first = seg[4] || '';
  if (seg[2] === '2' || !first) return last; // non-person entity
  return first ? `${last}, ${first}` : last;
}

function dotIcd(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c || c.includes('.')) return c;
  // ICD-10: category is letter + 2 digits; longer codes take a dot after it.
  if (/^[A-Z]\d{2}/.test(c) && c.length > 3) return `${c.slice(0, 3)}.${c.slice(3)}`;
  return c;
}

function parse837(text) {
  const segs = splitSegments(text);
  if (!segs.length || segs[0][0] !== 'ISA') {
    return { claims: [], errors: ['Not an X12 file (missing ISA header)'] };
  }
  const has837 = segs.some((s) => s[0] === 'ST' && s[1] === '837');
  if (!has837) return { claims: [], errors: ['No 837 transaction found in file'] };

  const claims = [];
  const errors = [];

  let subscriber = null;   // { name, member_id, dob }
  let patient = null;      // { name, dob } when dependent loop present
  let payerName = null;
  let lastPerson = null;   // 'subscriber' | 'patient' — DMG target
  let claim = null;        // claim under construction
  let lineOpen = false;

  function finishClaim() {
    if (!claim) return;
    const person = patient || subscriber || {};
    claim.patient_name = person.name || claim.patient_name || null;
    claim.patient_dob = person.dob || subscriber?.dob || null;
    claim.member_id = subscriber?.member_id || null;
    claim.payer_name = payerName;
    if (!claim.service_date) {
      claim.service_date = claim.lines.find((l) => l.service_date)?.service_date || null;
    }
    if (!claim.billed_amount && claim.lines.length) {
      claim.billed_amount = Math.round(claim.lines.reduce((s, l) => s + (l.charge || 0), 0) * 100) / 100;
    }
    claim.cpt_codes = claim.lines.map((l) => l.cpt).filter(Boolean);
    if (!claim.claim_number) claim.claim_number = `IMP-${claims.length + 1}`;
    if (!claim.patient_name) errors.push(`Claim ${claim.claim_number}: no patient name found — skipped`);
    else if (!claim.service_date) errors.push(`Claim ${claim.claim_number}: no service date found — skipped`);
    else if (!(claim.billed_amount > 0)) errors.push(`Claim ${claim.claim_number}: no billed amount — skipped`);
    else claims.push(claim);
    claim = null;
    lineOpen = false;
  }

  for (const seg of segs) {
    const id = seg[0];
    if (id === 'HL') {
      const level = seg[3];
      if (level === '22') { // new subscriber loop
        finishClaim();
        subscriber = null; patient = null; payerName = null; lastPerson = null;
      } else if (level === '23') { // new patient loop
        finishClaim();
        patient = null; lastPerson = null;
      }
      continue;
    }
    if (id === 'NM1') {
      const qual = seg[1];
      if (qual === 'IL') { subscriber = { ...(subscriber || {}), name: personName(seg), member_id: seg[9] || null }; lastPerson = 'subscriber'; }
      else if (qual === 'QC') { patient = { ...(patient || {}), name: personName(seg) }; lastPerson = 'patient'; }
      else if (qual === 'PR') { payerName = seg[3] || payerName; }
      else if (qual === '82') {
        const r = { rendering_provider: personName(seg), rendering_npi: seg[9] || null };
        if (claim) Object.assign(claim, r);
      }
      continue;
    }
    if (id === 'DMG') {
      const dob = ymd(seg[2]);
      if (lastPerson === 'patient' && patient) patient.dob = dob;
      else if (subscriber) subscriber.dob = dob;
      continue;
    }
    if (id === 'CLM') {
      finishClaim();
      claim = {
        claim_number: seg[1] || null,
        billed_amount: Number(seg[2]) || 0,
        service_date: null,
        icd_codes: [],
        lines: [],
        rendering_provider: null,
        rendering_npi: null,
      };
      lineOpen = false;
      continue;
    }
    if (!claim) continue;
    if (id === 'DTP' && seg[1] === '472') {
      const d = ymd(seg[3]);
      if (lineOpen && claim.lines.length) claim.lines[claim.lines.length - 1].service_date = d;
      else claim.service_date = d;
      continue;
    }
    if (id === 'HI') {
      for (let i = 1; i < seg.length; i++) {
        const code = String(seg[i] || '').split(':')[1];
        if (code) claim.icd_codes.push(dotIcd(code));
      }
      continue;
    }
    if (id === 'LX') { lineOpen = true; continue; }
    if (id === 'SV1') {
      const proc = String(seg[1] || '').split(':');
      const cpt = proc[1] || proc[0] || null;
      claim.lines.push({
        cpt,
        charge: Number(seg[2]) || 0,
        units: Number(seg[4]) || 1,
        service_date: null,
      });
      continue;
    }
  }
  finishClaim();
  return { claims, errors };
}

module.exports = { parse837 };
