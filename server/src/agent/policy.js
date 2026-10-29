'use strict';
// Approval policy tiers (deploy #101) — the owner's opt-in risk dial for
// draft_appeal proposals. DEFAULT OFF. When ON, a newly created
// draft_appeal action executes immediately through the SAME executor a
// human approve runs — but only when ALL of the owner's conditions hold:
//   * the claim's billed amount is at or under the owner's max amount;
//   * the org's own win history for this payer + denial reason (+ the
//     drafted angle) has at least the owner's minimum decided sample;
//   * that history's win rate is at least the owner's minimum rate.
// The prediction comes from predict.js — the org's OWN decided appeals,
// the same numbers the brief and claim panels show. No history (or thin
// history) can never qualify: auto-approval is earned by evidence, never
// assumed. The policy + prediction used are snapshotted onto the action
// row so any auto-approval can be audited after the fact.
const { db } = require('../db');
const predict = require('./predict');

function parseJson(s, fallback) {
  if (s == null) return fallback;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return fallback; }
}

// The org's policy (orgs columns, deploy #101). enabled defaults OFF —
// a missing row or a pre-#101 org reads as off with the product defaults.
function getPolicy(orgId) {
  const org = db.prepare(`
    SELECT agent_auto_approve, agent_auto_max_amount, agent_auto_min_sample, agent_auto_min_rate
    FROM orgs WHERE id = ?
  `).get(orgId);
  if (!org) return { enabled: false, max_amount: null, min_sample: 5, min_rate: 0.7 };
  return {
    enabled: org.agent_auto_approve === 1,
    max_amount: org.agent_auto_max_amount != null ? Number(org.agent_auto_max_amount) : null,
    min_sample: Number.isInteger(org.agent_auto_min_sample) ? org.agent_auto_min_sample : 5,
    min_rate: org.agent_auto_min_rate != null ? Number(org.agent_auto_min_rate) : 0.7,
  };
}

// Evaluate a freshly created draft_appeal action against the policy.
// Returns { qualifies, policy, prediction, claim_amount, reason } — the
// reason is always stated so a near-miss is explainable in tests/logs.
function evaluateDraftAction(orgId, action) {
  const policy = getPolicy(orgId);
  if (!policy.enabled) return { qualifies: false, policy, prediction: null, claim_amount: null, reason: 'policy_off' };
  if (policy.max_amount == null) return { qualifies: false, policy, prediction: null, claim_amount: null, reason: 'no_max_amount' };
  const payload = parseJson(action.payload, {});
  const claim = payload.claim_id
    ? db.prepare('SELECT id, billed_amount, payer_id, denial_reason FROM claims WHERE id = ? AND org_id = ?')
      .get(payload.claim_id, orgId)
    : null;
  if (!claim) return { qualifies: false, policy, prediction: null, claim_amount: null, reason: 'claim_missing' };
  const claimAmount = Number(claim.billed_amount) || 0;
  if (claimAmount > policy.max_amount) {
    return { qualifies: false, policy, prediction: null, claim_amount: claimAmount, reason: 'amount_over_max' };
  }
  const prediction = predict.appealOverturn(orgId, claim.payer_id, claim.denial_reason || null, payload.category || null);
  if (prediction.value == null || !prediction.sampleSize) {
    return { qualifies: false, policy, prediction, claim_amount: claimAmount, reason: 'no_history' };
  }
  // The win history must be FOR THIS denial reason. predict.js falls
  // back to payer-overall / org-overall rates when a reason has no
  // history of its own — fine for a displayed estimate, far too loose
  // for unattended approval: a different reason's record never
  // qualifies a draft.
  if (!String(prediction.basis || '').startsWith('payer + denial reason')) {
    return { qualifies: false, policy, prediction, claim_amount: claimAmount, reason: 'no_reason_history' };
  }
  if (prediction.sampleSize < policy.min_sample) {
    return { qualifies: false, policy, prediction, claim_amount: claimAmount, reason: 'sample_below_min' };
  }
  if (prediction.value < policy.min_rate) {
    return { qualifies: false, policy, prediction, claim_amount: claimAmount, reason: 'rate_below_min' };
  }
  return { qualifies: true, policy, prediction, claim_amount: claimAmount, reason: 'qualifies' };
}

module.exports = { getPolicy, evaluateDraftAction };
