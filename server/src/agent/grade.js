'use strict';
// Appeal grading (deploy #106, Phase E) — every agent appeal draft
// carries a grade computed from THIS workspace's own data:
//
//   win_history        0–60  the org's decided-appeal overturn rate for
//                            payer + denial reason, from predict.js (the
//                            same numbers predictions use). No decided
//                            history -> this component is null and the
//                            grade is capped at C — a draft with no track
//                            record behind it never earns an A or B.
//   citation_strength  0–25  deterministic signals in the drafted letter:
//                            names payer policy, cites the denial code,
//                            cites procedure/diagnosis codes, argues from
//                            documentation / medical necessity, and is
//                            substantive in length. Null until a letter
//                            exists (cohort preview grades are partial).
//   documentation      0–15  the claim itself: a linked authorization on
//                            file, CPT + ICD codes present, member id
//                            present.
//
// The grade rides with the SAME honesty labels as predictions: the
// win-history component reports its sample size and labelFor() label
// ('no data yet' / 'early estimate' / 'established'). Nothing is pooled
// across tenants and nothing is a model output — the arithmetic is here.
const { db } = require('../db');
const predict = require('./predict');

function citationScore(letterText) {
  const t = String(letterText || '');
  let score = 0;
  const signals = [];
  if (/payer policy|policy (manual|guideline)|coverage guideline|clinical guideline|medical policy|filing requirements/i.test(t)) { score += 8; signals.push('invokes the payer\'s own requirements/policy'); }
  if (/\b(CO|PR|OA)-\d+\b/.test(t)) { score += 5; signals.push('cites the denial code'); }
  if (/\bCPT\b|\bICD-?10\b|\b\d{5}\b.*\b(procedure|service)\b/i.test(t)) { score += 5; signals.push('cites procedure/diagnosis codes'); }
  if (/medical necessity|documentation (shows|supports|demonstrates)|records (show|support)|enclosed|enclosures:/i.test(t)) { score += 4; signals.push('argues from documentation / enclosures'); }
  if (t.length >= 1200) { score += 3; signals.push('substantive length'); }
  return { score, signals };
}

function documentationScore(orgId, claim) {
  let score = 0;
  const signals = [];
  const auth = db.prepare(
    'SELECT id FROM auth_requests WHERE org_id = ? AND linked_claim_id = ? LIMIT 1'
  ).get(orgId, claim.id);
  if (auth) { score += 8; signals.push('authorization on file'); }
  if (claim.cpt_codes && claim.icd_codes) { score += 4; signals.push('CPT + ICD present'); }
  if (claim.member_id) { score += 3; signals.push('member id present'); }
  return { score, signals };
}

const GRADE_ORDER = ['F', 'D', 'C', 'B', 'A'];
function letterFor(score) {
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  if (score >= 35) return 'D';
  return 'F';
}
function capLetter(letter, cap) {
  return GRADE_ORDER[Math.min(GRADE_ORDER.indexOf(letter), GRADE_ORDER.indexOf(cap))];
}

// predict.appealOverturn falls back payer+reason -> payer overall ->
// org overall. Only the pair-specific record is full evidence for THIS
// draft; broader fallbacks are discounted, and the grade says which
// basis priced it.
const BASIS_WEIGHT = [
  [/^payer \+ denial reason/, 1],
  [/^payer overall/, 0.5],
  [/^org overall/, 0.25],
];
function basisWeight(basis) {
  for (const [re, w] of BASIS_WEIGHT) if (re.test(basis || '')) return w;
  return 1;
}

function gradeAppeal(orgId, { claim, letterText = null } = {}) {
  if (!claim) return null;
  const overturn = predict.appealOverturn(orgId, claim.payer_id, claim.denial_reason || null);
  const weight = basisWeight(overturn.basis);
  const win = overturn.value == null ? null : Math.round(overturn.value * 60 * weight);
  const citation = letterText ? citationScore(letterText) : null;
  const docs = documentationScore(orgId, claim);
  const score = (win || 0) + (citation ? citation.score : 0) + docs.score;
  let letter = letterFor(score);
  if (win == null) letter = capLetter(letter, 'C');
  return {
    score,
    letter,
    partial: !letterText,
    win_rate: overturn.value,
    win_basis_weight: weight,
    sample_size: overturn.sampleSize,
    basis: overturn.basis,
    label: overturn.label,
    components: {
      win_history: win,
      citation_strength: citation ? citation.score : null,
      documentation: docs.score,
    },
    signals: {
      citation: citation ? citation.signals : [],
      documentation: docs.signals,
    },
    note: win == null
      ? 'No decided appeals in this workspace yet — grade rests on the letter and the claim file, and is capped at C.'
      : `Win history from this workspace's own decided appeals (n=${overturn.sampleSize}, ${overturn.label}; basis: ${overturn.basis}${weight < 1 ? `, weighted ${weight}× — not specific to this payer + reason` : ''}).`,
  };
}

module.exports = { gradeAppeal, citationScore, documentationScore, letterFor };
