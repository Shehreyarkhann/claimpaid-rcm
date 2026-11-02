'use strict';
// Prior-auth automation core (deploy #106, Phase F).
//
// REQUIREMENT CHECK — "does this payer + service need prior auth?" is
// answered ONLY from the workspace's own data, in this order:
//   1. a workspace requirement rule matching payer + CPT
//   2. a workspace rule matching the CPT for any payer
//   3. a workspace rule matching the payer for any service
//   4. the workspace's own auth history: an earlier auth for the same
//      payer + CPT that carries a payer-issued auth number (evidence
//      the payer runs auths for this pair), else any earlier approved
//      auth for the payer + CPT
//   5. otherwise UNKNOWN — stated as unknown. This module never invents
//      payer policy; a payer's real requirement lives in the handbook /
//      with the payer until the workspace records it as a rule.
// The first CPT on the auth record is the service the check prices;
// multi-CPT records check their primary service.
const { firstCpt } = require('./pa278');

function checkRequirement(db, orgId, auth) {
  const cpt = firstCpt(auth.cpt_codes);
  const payerId = auth.payer_id || null;
  const rule = (where, params) => db.prepare(
    `SELECT * FROM pa_requirement_rules WHERE org_id = ? AND ${where} ORDER BY id DESC LIMIT 1`
  ).get(orgId, ...params);

  let hit = null;
  if (payerId && cpt) hit = rule('payer_id = ? AND cpt_code = ?', [payerId, cpt]);
  if (!hit && cpt) hit = rule('payer_id IS NULL AND cpt_code = ?', [cpt]);
  if (!hit && payerId) hit = rule('payer_id = ? AND cpt_code IS NULL', [payerId]);
  if (hit) {
    return {
      required: hit.requires_auth ? 1 : 0,
      basis: `Workspace rule #${hit.id}: ${hit.requires_auth ? 'prior auth required' : 'no prior auth needed'}`
        + `${hit.cpt_code ? ` for CPT ${hit.cpt_code}` : ''}${hit.payer_id ? ' for this payer' : ' (any payer)'}`
        + `${hit.notes ? ` — ${hit.notes}` : ''}`,
      source: 'rule',
      rule_id: hit.id,
      cpt,
    };
  }

  if (payerId && cpt) {
    const prior = db.prepare(`
      SELECT id, auth_number, status FROM auth_requests
      WHERE org_id = ? AND payer_id = ? AND id != ? AND cpt_codes LIKE ?
      ORDER BY id DESC LIMIT 25
    `).all(orgId, payerId, auth.id, `${cpt}%`);
    const withNumber = prior.find((r) => r.auth_number);
    if (withNumber) {
      return {
        required: 1,
        basis: `Workspace history: auth #${withNumber.id} for this payer + CPT ${cpt} carries payer auth number ${withNumber.auth_number}`,
        source: 'history',
        rule_id: null,
        cpt,
      };
    }
    const approved = prior.find((r) => r.status === 'approved');
    if (approved) {
      return {
        required: 1,
        basis: `Workspace history: auth #${approved.id} for this payer + CPT ${cpt} was approved through the auth process`,
        source: 'history',
        rule_id: null,
        cpt,
      };
    }
  }

  return {
    required: null,
    basis: cpt
      ? `Unknown — no workspace rule and no auth history for this payer + CPT ${cpt}. Add a rule once the payer's requirement is confirmed.`
      : 'Unknown — this record has no CPT code to check. Add one, or a payer-wide rule.',
    source: 'unknown',
    rule_id: null,
    cpt,
  };
}

function recordRequirementCheck(db, orgId, auth) {
  const result = checkRequirement(db, orgId, auth);
  db.prepare(`
    UPDATE auth_requests SET pa_required = ?, pa_requirement_basis = ?,
      pa_requirement_checked_at = datetime('now') WHERE id = ? AND org_id = ?
  `).run(result.required, result.basis, auth.id, orgId);
  return result;
}

// Stale = submitted/pending_info and waiting more than STALE_DAYS since
// the request date — the follow-up list the module surfaces in stats.
const STALE_DAYS = 14;
function staleAuths(db, orgId) {
  return db.prepare(`
    SELECT ar.id, ar.patient_name, ar.requested_date, p.name AS payer_name,
      CAST(julianday('now') - julianday(ar.requested_date) AS INTEGER) AS days_waiting
    FROM auth_requests ar LEFT JOIN payers p ON p.id = ar.payer_id
    WHERE ar.org_id = ? AND ar.status IN ('submitted', 'pending_info')
      AND ar.requested_date IS NOT NULL
      AND CAST(julianday('now') - julianday(ar.requested_date) AS INTEGER) > ?
    ORDER BY days_waiting DESC
  `).all(orgId, STALE_DAYS);
}

module.exports = { checkRequirement, recordRequirementCheck, staleAuths, STALE_DAYS };
