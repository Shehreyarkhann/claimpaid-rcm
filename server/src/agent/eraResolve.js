'use strict';
// ERA exception resolution (agent Phase 3, WS2).
//
// The recommender is DETERMINISTIC: the disposition is computed from the
// remittance's own CAS adjustments + amounts, with the arithmetic shown.
// The model narrates the recommendation; it never computes it. Execution
// runs the EXISTING resolution paths — posting dispositions go through
// eraPosting.postLine (the same engine the ERA inbox Post button runs),
// write-off goes through the same 'ignored' transition as the inbox
// Ignore button. Nothing here posts or ignores on its own: execution only
// happens inside an approved agent action.
const { db } = require('../db');
const { postLine, recomputeRemittance, round2, VARIANCE_TOLERANCE } = require('../eraPosting');
const { createAction } = require('./actions');

const DISPOSITION_LABELS = {
  contractual_adjustment: 'Contractual adjustment — post as remitted',
  patient_responsibility: 'Patient responsibility — post and bill the patient',
  rebill_or_appeal: 'Denial — post so the claim can be appealed or rebilled',
  write_off: 'Write off — ignore this line',
  manual_match: 'Match to a claim first (cannot resolve yet)',
};

function parseJson(s, fallback) {
  if (s == null) return fallback;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return fallback; }
}

// Deterministic disposition from CAS groups + amounts.
// Returns { disposition, label, can_resolve, reason, arithmetic } where
// arithmetic shows paid + adjustments + patient resp vs billed + residual.
function recommendDisposition(line) {
  const adj = parseJson(line.adjustments, []);
  const flags = parseJson(line.flags, []);
  const sum = (gs) => round2(adj.filter((a) => gs.includes(a.group)).reduce((s, a) => s + (Number(a.amount) || 0), 0));
  const contractual = sum(['CO']);
  const otherAdj = sum(['OA', 'PI']);
  const patientResp = Math.max(Number(line.patient_resp) || 0, sum(['PR']));
  const paid = Number(line.paid) || 0;
  const billed = Number(line.billed) || 0;
  const residual = round2(billed - paid - contractual - otherAdj - patientResp);
  const arithmetic = { billed, paid, contractual, other_adjustments: otherAdj, patient_resp: patientResp, residual };
  const base = { label: null, arithmetic };

  if (!line.match_claim_id) {
    return {
      ...base, disposition: 'manual_match', label: DISPOSITION_LABELS.manual_match, can_resolve: false,
      reason: 'This line is not matched to a claim yet. Match it in the ERA inbox first — there is nothing honest to post until it belongs to a claim.',
    };
  }
  const denialCas = adj.filter((a) => a.group === 'CO' || a.group === 'OA').map((a) => `${a.group}-${a.code}`);
  const isDenial = flags.includes('denial') || line.status_code === '4'
    || (paid === 0 && !!line.denial_reason);
  if (isDenial) {
    return {
      ...base, disposition: 'rebill_or_appeal', label: DISPOSITION_LABELS.rebill_or_appeal, can_resolve: true,
      reason: `Zero payment with a denial on the remittance${denialCas.length ? ` (${denialCas.join(', ')})` : ''}${line.denial_reason ? `: ${line.denial_reason}` : ''}. Posting records the denial on the claim so it enters the appeal/rebill workflow instead of sitting in the inbox.`,
    };
  }
  if (patientResp > 0) {
    return {
      ...base, disposition: 'patient_responsibility', label: DISPOSITION_LABELS.patient_responsibility, can_resolve: true,
      reason: `The remittance assigns $${patientResp.toFixed(2)} to the patient (PR). Posting moves that balance to patient responsibility${residual <= VARIANCE_TOLERANCE ? '; the line balances as remitted' : `; $${residual.toFixed(2)} remains unexplained and stays in A/R`}.`,
    };
  }
  if (paid === 0 && residual <= VARIANCE_TOLERANCE) {
    return {
      ...base, disposition: 'write_off', label: DISPOSITION_LABELS.write_off, can_resolve: true,
      reason: `Nothing was paid and the full $${billed.toFixed(2)} was adjusted away by non-denial adjustments (OA/PI $${otherAdj.toFixed(2)}). There is nothing to collect on this line — ignore it like the ERA inbox write-off.`,
    };
  }
  return {
    ...base, disposition: 'contractual_adjustment', label: DISPOSITION_LABELS.contractual_adjustment, can_resolve: true,
    reason: contractual > 0
      ? `The remittance carries $${contractual.toFixed(2)} of contractual (CO) adjustments. Posting applies the payment and the contractual adjustment${residual <= VARIANCE_TOLERANCE ? '; the line balances as remitted' : `; $${residual.toFixed(2)} stays in A/R to work`}.`
      : `The line balances as remitted (paid $${paid.toFixed(2)} of $${billed.toFixed(2)}). Post it as-is.`,
  };
}

const EXCEPTION_SELECT = `
  SELECT l.*, r.payer_name, r.check_number, c.claim_number AS matched_claim_number
  FROM era_claim_lines l
  JOIN era_remittances r ON r.id = l.era_id
  LEFT JOIN claims c ON c.id = l.match_claim_id
`;

function slimException(line) {
  const rec = recommendDisposition(line);
  return {
    era_line_id: line.id,
    era_id: line.era_id,
    clp_ref: line.clp_ref,
    payer: line.payer_name || null,
    check_number: line.check_number || null,
    patient_name: line.patient_name || null,
    claim_id: line.match_claim_id || null,
    claim_number: line.matched_claim_number || null,
    suggested_claim_id: line.suggested_claim_id || null,
    status_code: line.status_code || null,
    billed: round2(line.billed),
    paid: round2(line.paid),
    patient_resp: round2(line.patient_resp),
    flags: parseJson(line.flags, []),
    denial_reason: line.denial_reason || null,
    adjustments: parseJson(line.adjustments, []).map((a) => ({
      group: a.group, code: a.code, amount: round2(a.amount), text: a.text || null,
    })),
    recommendation: rec,
  };
}

// Current ERA exceptions: pending lines carrying flags (the brief's
// definition of an exception), newest first.
function listExceptions(orgId, limit = 25) {
  const rows = db.prepare(`
    ${EXCEPTION_SELECT}
    WHERE l.org_id = ? AND l.post_status = 'pending' AND l.flags IS NOT NULL AND l.flags != '[]'
    ORDER BY l.created_at DESC, l.id DESC LIMIT ?
  `).all(orgId, limit);
  return rows.map(slimException);
}

function exceptionsForClaim(orgId, claimId) {
  const rows = db.prepare(`
    ${EXCEPTION_SELECT}
    WHERE l.org_id = ? AND l.post_status = 'pending' AND l.match_claim_id = ?
    ORDER BY l.created_at DESC, l.id DESC
  `).all(orgId, claimId);
  return rows.map(slimException);
}

function getExceptionLine(orgId, lineId) {
  return db.prepare(`${EXCEPTION_SELECT} WHERE l.id = ? AND l.org_id = ?`).get(lineId, orgId) || null;
}

function previewForException(slim) {
  const a = slim.recommendation.arithmetic;
  const cas = slim.adjustments.length
    ? slim.adjustments.map((x) => `${x.group}-${x.code} $${Number(x.amount).toFixed(2)}`).join(', ')
    : 'none';
  return [
    `ERA exception — ${slim.claim_number ? `claim ${slim.claim_number}` : `unmatched line ${slim.clp_ref}`}${slim.payer ? ` · ${slim.payer}` : ''}${slim.check_number ? ` · check ${slim.check_number}` : ''}`,
    `Patient: ${slim.patient_name || '—'} · Billed $${a.billed.toFixed(2)} · Paid $${a.paid.toFixed(2)}`,
    `Flags: ${slim.flags.join(', ') || 'none'} · CAS adjustments: ${cas}`,
    '',
    `Recommended: ${slim.recommendation.label}`,
    slim.recommendation.reason,
    `Math: $${a.paid.toFixed(2)} paid + $${a.contractual.toFixed(2)} contractual + $${a.other_adjustments.toFixed(2)} other adjustments + $${a.patient_resp.toFixed(2)} patient resp = $${round2(a.paid + a.contractual + a.other_adjustments + a.patient_resp).toFixed(2)} of $${a.billed.toFixed(2)} billed (residual $${a.residual.toFixed(2)}).`,
    '',
    'Approving applies this disposition through the standard ERA posting path. Rejecting leaves the line untouched in the ERA inbox.',
  ].join('\n');
}

// Create the pending resolve_exception action for one line. Throws (with
// .status where sensible) when the line is missing or cannot be resolved.
function buildResolveAction({ orgId, userId, convoId, lineId }) {
  const line = getExceptionLine(orgId, lineId);
  if (!line) { const e = new Error('ERA exception line not found in this workspace.'); e.status = 404; throw e; }
  if (line.post_status !== 'pending') { const e = new Error('This ERA line was already resolved.'); e.status = 409; throw e; }
  const slim = slimException(line);
  if (!slim.recommendation.can_resolve) {
    const e = new Error('This line is not matched to a claim yet — match it in the ERA inbox before it can be resolved.');
    e.status = 400; throw e;
  }
  const existing = db.prepare(`
    SELECT id FROM agent_actions WHERE org_id = ? AND kind = 'resolve_exception' AND status = 'pending'
      AND CAST(json_extract(payload, '$.era_line_id') AS INTEGER) = ?
  `).get(orgId, line.id);
  if (existing) { const e = new Error('A resolution for this ERA line is already awaiting a decision.'); e.status = 409; throw e; }
  return createAction({
    orgId, userId, convoId: convoId || null,
    kind: 'resolve_exception',
    payload: {
      era_line_id: line.id,
      era_id: line.era_id,
      claim_id: line.match_claim_id || null,
      claim_number: slim.claim_number,
      payer: slim.payer,
      disposition: slim.recommendation.disposition,
      disposition_label: slim.recommendation.label,
      arithmetic: slim.recommendation.arithmetic,
      adjustments: slim.adjustments,
    },
    preview: previewForException(slim),
  });
}

// Execute an approved disposition through the existing resolution paths.
// req is the { orgId, user } shape postLine consumes. Throws on failure —
// approveAction records 'failed' honestly.
function applyResolution(req, line, disposition) {
  const era = db.prepare('SELECT * FROM era_remittances WHERE id = ?').get(line.era_id);
  if (!era) throw new Error('The parent remittance no longer exists.');
  if (line.post_status !== 'pending') throw new Error('This ERA line was already resolved.');
  db.exec('BEGIN');
  try {
    let result;
    if (disposition === 'write_off') {
      // The existing Ignore path (routes/era.js POST /lines/:id/ignore).
      db.prepare("UPDATE era_claim_lines SET post_status = 'ignored' WHERE id = ?").run(line.id);
      result = { disposition, ignored: true, claim_id: line.match_claim_id || null };
    } else {
      if (!line.match_claim_id) throw new Error('This line is not matched to a claim — match it in the ERA inbox first.');
      const r = postLine(req, era, line);
      result = { disposition, posted: true, claim_id: r.claimId, new_status: r.newStatus, balance: r.balance, auth_linked: r.authLinked };
    }
    recomputeRemittance(line.era_id);
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = {
  DISPOSITION_LABELS, recommendDisposition, listExceptions, exceptionsForClaim,
  getExceptionLine, slimException, previewForException, buildResolveAction, applyResolution,
};
