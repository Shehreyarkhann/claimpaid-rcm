'use strict';
// ERA posting engine — extracted verbatim from routes/era.js (deploy #41
// logic, unchanged) so the ERA routes AND the agent's resolve_exception
// executor run the exact same posting code. postLine applies one
// era_claim_lines row to its matched claim (payment, CO/OA/PI adjustments,
// patient responsibility, denial status + reason, auth auto-link) and
// marks the line posted. recomputeRemittance rolls line states up to the
// parent remittance. Callers own the transaction.
const { db } = require('./db');
const { logActivity } = require('./activity');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const AUTH_REASON_CODES = ['197', '198', '39'];
const VARIANCE_TOLERANCE = 0.02;

function recomputeRemittance(eraId) {
  const era = db.prepare('SELECT * FROM era_remittances WHERE id = ?').get(eraId);
  if (!era) return;
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN post_status = 'posted' THEN 1 ELSE 0 END) AS posted,
      SUM(CASE WHEN post_status = 'pending' THEN 1 ELSE 0 END) AS pending
    FROM era_claim_lines WHERE era_id = ?
  `).get(eraId);
  const posted = counts.posted || 0;
  const pending = counts.pending || 0;
  const status = pending === 0 ? 'posted' : posted > 0 ? 'partially_posted' : 'received';
  db.prepare('UPDATE era_remittances SET posted_count = ?, status = ? WHERE id = ?').run(posted, status, eraId);
}

// Applies one ERA line to its matched claim. Caller owns the transaction.
function postLine(req, era, line) {
  const claim = db.prepare('SELECT * FROM claims WHERE id = ? AND org_id = ?').get(line.match_claim_id, req.orgId);
  if (!claim) throw Object.assign(new Error('Matched claim not found'), { status: 404 });

  const adj = JSON.parse(line.adjustments || '[]');
  const sumGroup = (...gs) => round2(adj.filter((a) => gs.includes(a.group)).reduce((s, a) => s + a.amount, 0));
  const writeOff = sumGroup('CO', 'OA', 'PI');
  const patientResp = Math.max(Number(line.patient_resp) || 0, sumGroup('PR'));
  const isReversal = line.status_code === '21' || line.status_code === '22';
  const sign = isReversal ? -1 : 1;

  const newPaid = Math.max(0, round2(claim.paid_amount + sign * line.paid));
  const newAdj = Math.max(0, round2((claim.adjustment_amount || 0) + sign * writeOff));
  const newPr = Math.max(0, round2((claim.patient_resp_amount || 0) + sign * patientResp));
  const balance = round2(claim.billed_amount - newPaid - newAdj - newPr);

  const flags = JSON.parse(line.flags || '[]');
  const isDenial = flags.includes('denial');
  let newStatus;
  if (isDenial && !isReversal) newStatus = 'denied';
  else if (balance <= VARIANCE_TOLERANCE) {
    // Fully accounted for. Still 'in_ar' when the payer paid nothing and the
    // balance moved entirely to the patient (deductible/copay) — that money
    // is still collectible, now from the patient.
    newStatus = newPaid === 0 && newPr > 0 ? 'in_ar' : 'paid';
  }
  else if (newPaid > 0 || newPr > 0) newStatus = 'in_ar';
  else newStatus = claim.status;

  db.prepare(`
    UPDATE claims SET paid_amount = ?, adjustment_amount = ?, patient_resp_amount = ?,
      allowed_amount = COALESCE(?, allowed_amount),
      payer_icn = COALESCE(payer_icn, ?),
      status = ?, last_touched_at = datetime('now')
    WHERE id = ?
  `).run(newPaid, newAdj, newPr, isReversal ? null : line.allowed, line.payer_icn, newStatus, claim.id);

  let authLinked = 0;
  if (newStatus === 'denied') {
    if (line.denial_reason) {
      db.prepare('UPDATE claims SET denial_reason = ? WHERE id = ?').run(line.denial_reason, claim.id);
    }
    const codes = adj.map((a) => a.code);
    if (codes.some((c) => AUTH_REASON_CODES.includes(c))) {
      const match = db.prepare(`
        SELECT id FROM auth_requests
        WHERE org_id = ? AND patient_name = ? AND payer_id = ?
          AND linked_claim_id IS NULL
        ORDER BY created_at DESC LIMIT 1
      `).get(req.orgId, claim.patient_name, claim.payer_id);
      if (match) {
        db.prepare('UPDATE auth_requests SET linked_claim_id = ? WHERE id = ?').run(claim.id, match.id);
        logActivity(req.orgId, claim.id, req.user.id, 'auth_linked',
          `Auto-linked to authorization #${match.id} (835 denial reason: authorization)`);
        authLinked = 1;
      }
    }
  }

  const verb = isReversal ? 'reversed' : isDenial ? 'denied' : 'posted';
  logActivity(req.orgId, claim.id, req.user.id, 'payment_posted',
    `ERA ${era.check_number || era.id}: ${verb} $${line.paid.toFixed(2)} paid of $${line.billed.toFixed(2)} billed`
    + (writeOff ? `, $${writeOff.toFixed(2)} adjustments` : '')
    + (patientResp ? `, $${patientResp.toFixed(2)} patient responsibility` : '')
    + (line.denial_reason && isDenial ? ` — ${line.denial_reason}` : ''));

  db.prepare(`UPDATE era_claim_lines SET post_status = 'posted', posted_at = datetime('now'), posted_by = ? WHERE id = ?`)
    .run(req.user.id, line.id);

  // Deploy #101: the ERA feedback loop — a posted line that settles a
  // claim with an open, submitted appeal records the payer's answer
  // (won / partial / re-denied) deterministically. Lazy require:
  // eraFeedback requires this module's tolerance constant. It never
  // throws (it guards itself), so posting cannot be sunk by it.
  const feedback = require('./agent/eraFeedback').applyEraFeedback({
    orgId: req.orgId, line, result: { claimId: claim.id, newStatus },
  });
  return { claimId: claim.id, newStatus, balance, authLinked, feedback };
}

module.exports = { recomputeRemittance, postLine, round2, VARIANCE_TOLERANCE };
