'use strict';
// ERA feedback loop (deploy #101) — payer responses close the loop.
//
// postLine (eraPosting.js) calls applyEraFeedback after every posted ERA
// line. When the line settles a claim that carries an open, SUBMITTED
// appeal, the payer has effectively answered that appeal, and the answer
// is recorded deterministically from the remittance itself — never from
// a model:
//   * denial line (zero pay, denial CAS)      -> outcome RE-DENIED: the
//     appeal returns to 'open' work state with an immediate follow-up;
//     the claim already re-entered 'denied' with the new reason inside
//     postLine. The agent alert + brief item surface from the outcome
//     (watchdog / brief read the same columns) with a deep link into the
//     draft flow — no draft is auto-created.
//   * payment that fully settles the claim    -> outcome WON: appeal
//     status 'won' (the same state a person records manually), so
//     outcomes.js reconciliation learns it identically.
//   * payment that settles only part          -> outcome PARTIAL: the
//     appeal stays 'submitted' (the rest is still owed an answer) and
//     the partial lands in reconciliation as a half-overturn (0.5).
// Reversals (money moving backwards) are not payer answers and are
// skipped. Every transition writes claim_activity rows as SYSTEM rows
// (user_id NULL) labeled agent/ERA-originated; staff can still edit the
// appeal afterwards — nothing here is a lock.
const { db } = require('../db');
const { logActivity } = require('../activity');
// Same balance tolerance eraPosting uses to call a claim fully settled
// (kept local: eraPosting requires THIS module lazily, so a top-level
// require back would be a cycle).
const VARIANCE_TOLERANCE = 0.02;
const { reconcileOutcomes } = require('./outcomes');

function parseJson(s, fallback) {
  if (s == null) return fallback;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return fallback; }
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// The claim's live submitted appeal, if any (newest first).
function submittedAppealFor(orgId, claimId) {
  return db.prepare(`
    SELECT * FROM appeals WHERE org_id = ? AND claim_id = ? AND status = 'submitted'
    ORDER BY submitted_at DESC, id DESC LIMIT 1
  `).get(orgId, claimId) || null;
}

function applyEraFeedback({ orgId, line, result }) {
  try {
    if (!line || !result || !result.claimId) return null;
    if (line.status_code === '21' || line.status_code === '22') return null; // reversal
    const appeal = submittedAppealFor(orgId, result.claimId);
    if (!appeal) return null;
    const claim = db.prepare('SELECT * FROM claims WHERE id = ? AND org_id = ?').get(result.claimId, orgId);
    if (!claim) return null;

    const flags = parseJson(line.flags, []);
    const adj = parseJson(line.adjustments, []);
    const denialCas = adj.filter((a) => ['CO', 'OA'].includes(a.group)).map((a) => `${a.group}-${a.code}`);
    const isDenial = flags.includes('denial') && (Number(line.paid) || 0) === 0;
    const paid = Number(line.paid) || 0;
    const balance = round2(claim.billed_amount - (claim.paid_amount || 0) - (claim.adjustment_amount || 0) - (claim.patient_resp_amount || 0));
    const now = "datetime('now')";

    if (isDenial) {
      // A re-denial supersedes any earlier partial outcome.
      const today = new Date().toISOString().slice(0, 10);
      db.prepare(`
        UPDATE appeals SET status = 'open', outcome = 're_denied', outcome_at = ${now},
          outcome_source = 'era', follow_up_date = ?, updated_at = ${now}
        WHERE id = ?
      `).run(today, appeal.id);
      logActivity(orgId, claim.id, null, 'appeal_re_denied',
        `Payer re-denied claim ${claim.claim_number} on the remittance after the submitted appeal (auto, from ERA${denialCas.length ? ` · ${denialCas.join(', ')}` : ''}${line.denial_reason ? ` · ${line.denial_reason}` : ''}) — appeal reopened for a response draft`);
      try { reconcileOutcomes(orgId); } catch { /* daily-guarded; never sink posting */ }
      return { appeal_id: appeal.id, outcome: 're_denied' };
    }

    if (paid > 0 && balance <= VARIANCE_TOLERANCE && result.newStatus === 'paid') {
      db.prepare(`
        UPDATE appeals SET status = 'won', outcome = 'won', outcome_at = ${now},
          outcome_source = 'era', follow_up_date = NULL, updated_at = ${now}
        WHERE id = ?
      `).run(appeal.id);
      logActivity(orgId, claim.id, null, 'appeal_won',
        `Payer paid claim ${claim.claim_number} in full after the submitted appeal (auto, from ERA) — appeal closed as won`);
      try { reconcileOutcomes(orgId); } catch { /* see above */ }
      return { appeal_id: appeal.id, outcome: 'won' };
    }

    if (paid > 0 && appeal.outcome !== 'won') {
      db.prepare(`
        UPDATE appeals SET outcome = 'partial', outcome_at = ${now},
          outcome_source = 'era', updated_at = ${now}
        WHERE id = ?
      `).run(appeal.id);
      logActivity(orgId, claim.id, null, 'appeal_partial',
        `Payer paid $${paid.toFixed(2)} toward claim ${claim.claim_number} after the submitted appeal (auto, from ERA) — partial payment recorded; $${balance.toFixed(2)} still open`);
      try { reconcileOutcomes(orgId); } catch { /* see above */ }
      return { appeal_id: appeal.id, outcome: 'partial' };
    }
    return null;
  } catch (e) {
    // The feedback loop must never break ERA posting.
    console.error('[era-feedback] failed:', e.message);
    return null;
  }
}

module.exports = { applyEraFeedback, submittedAppealFor };
