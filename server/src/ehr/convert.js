'use strict';
// convert.js — shared encounter → claim-draft conversion.
//
// Used by the manual Convert button, the sync auto-pull (deploy #42), and
// the background scheduler, so every path produces identical drafts and
// identical failure reasons. A failure NEVER throws for business reasons:
// it returns { ok:false, error } and (for auto attempts) records the reason
// on the encounter as convert_note so the inbox explains the hold and the
// next sync retries once the blocker (usually a missing payer) is fixed.

const { db } = require('../db');
const { createClaimDraft, resolvePayerId } = require('../routes/claims');

function safeJsonArr(s) {
  try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

// EHRs send payer strings like "Anthem" or "AETNA" that rarely match the
// org's payer list verbatim ("Anthem BCBS"). Resolution order: exact match
// (shared resolver), then a UNIQUE prefix relationship either way. Ambiguous
// or absent → no match, and the caller reports it instead of guessing.
function resolveEhrPayer(orgId, payerName) {
  const exact = resolvePayerId(orgId, payerName);
  if (exact) return exact;
  const q = String(payerName || '').trim().toLowerCase();
  if (!q) return null;
  const payers = db.prepare('SELECT id, name FROM payers WHERE org_id = ?').all(orgId);
  const candidates = payers.filter((p) => {
    const n = p.name.trim().toLowerCase();
    return n.startsWith(q) || q.startsWith(n);
  });
  return candidates.length === 1 ? candidates[0].id : null;
}

function findPayerName(orgId, payerId) {
  const row = db.prepare('SELECT name FROM payers WHERE id = ? AND org_id = ?').get(payerId, orgId);
  return row ? row.name : null;
}

// enc: an ehr_encounters row. opts.auto marks scheduler/sync-driven attempts.
// Returns { ok:true, claim } | { ok:false, error, status? }
function convertEncounter(orgId, userId, enc, { auto = false } = {}) {
  const fail = (error, status) => {
    if (auto) {
      db.prepare('UPDATE ehr_encounters SET convert_note = ? WHERE id = ?')
        .run(String(error).slice(0, 300), enc.id);
    }
    return { ok: false, error, status };
  };

  if (enc.status === 'converted') return fail('Encounter already converted to a claim', 400);
  if (enc.status === 'ignored') return fail('Encounter was ignored — un-ignore it first', 400);

  const payerName = (enc.payer_name || '').trim();
  if (!payerName) return fail('This encounter has no payer recorded — add payer info before converting.', 400);
  const payerId = resolveEhrPayer(orgId, payerName);
  if (!payerId) {
    return fail(`Payer "${payerName}" is not in your organization's payer list — add it in Filing Rules first, then convert.`, 400);
  }
  const canonicalPayer = findPayerName(orgId, payerId) || payerName;

  const cpts = safeJsonArr(enc.cpt_codes);
  const icds = safeJsonArr(enc.icd_codes);
  const dos = (enc.date_of_service || '').slice(0, 10);
  const claimNumber = `EHR-${dos.replace(/-/g, '')}-${enc.id}`;
  try {
    const claim = createClaimDraft(orgId, userId, {
      claim_number: claimNumber,
      patient_name: `${enc.patient_first || ''} ${enc.patient_last || ''}`.trim() || 'Unknown',
      payer: canonicalPayer,
      service_date: /^\d{4}-\d{2}-\d{2}$/.test(dos) ? dos : new Date().toISOString().slice(0, 10),
      billed_amount: 0, // draft — the biller completes amounts in the claim editor
      cpt_codes: cpts.join(', '),
      icd_codes: icds.join(', '),
      rendering_provider: enc.rendering_provider || undefined,
      patient_dob: enc.patient_dob || undefined,
    });
    db.prepare(`UPDATE ehr_encounters SET status='converted', converted_claim_id=?,
        auto_created=?, convert_note=NULL WHERE id = ?`)
      .run(claim.id, auto ? 1 : 0, enc.id);
    return { ok: true, claim };
  } catch (e) {
    if (e.status === 409) return fail(e.message, 409);
    if (e.status === 400) {
      const r = fail((e.validationErrors || [e.message]).join('; '), 400);
      r.errors = e.validationErrors || null;
      return r;
    }
    throw e;
  }
}

module.exports = { convertEncounter, resolveEhrPayer };
