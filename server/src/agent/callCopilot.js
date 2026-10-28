'use strict';
// Payer-call copilot (agent Phase 5, WS2). The brief is DETERMINISTIC —
// every fact comes from the claim row, the payer's filing rule, the
// playbook entries the team already maintains, and the denial-reason
// family classifier the appeal letters use. No model call: a biller
// standing in a phone queue gets the same script every time, and nothing
// on it can be hallucinated. Call outcomes land in agent_call_logs AND
// on the claim's activity timeline (the existing logActivity mechanism),
// and follow-ups attach to the claim's open appeal — appeals.follow_up_
// date is the field the worklist's overdue section is built from.
const { db } = require('../db');
const { categorizeReason, CATEGORY_LABELS } = require('../appealLetters');
const { logActivity } = require('../activity');
const predict = require('./predict');

const OUTCOMES = ['promised_payment', 'denied_upheld', 'info_requested', 'transferred', 'voicemail', 'other'];
const OUTCOME_LABELS = {
  promised_payment: 'Payment promised',
  denied_upheld: 'Denial upheld',
  info_requested: 'More info requested',
  transferred: 'Transferred',
  voicemail: 'Left voicemail',
  other: 'Other',
};

// Questions keyed to the appealLetters denial families — the same
// taxonomy the appeal drafts and outcome stats already use.
const FAMILY_QUESTIONS = {
  medical_necessity: [
    'Which clinical criteria set was applied to this denial, and which element did the documentation fail to meet?',
    'Can we schedule a peer-to-peer review? What is the direct number for the reviewing clinician?',
    'Exactly which records would satisfy medical necessity here — visit notes, imaging, prior treatment history?',
  ],
  no_auth: [
    'Was an authorization on file under a different number or a different rendering provider?',
    'Is a retro-authorization possible for this date of service, and what is that window?',
    'What documentation does the retro-auth review require, and where should it be sent?',
  ],
  timely_filing: [
    'Confirm the exact received date you have on file for the original claim submission.',
    'Could the claim have been received under a different claim number or tax ID?',
    'What proof of timely filing do you accept — clearinghouse acceptance report, or the 999/277CA?',
  ],
  coding: [
    'Which specific edit fired — modifier, bundling (NCCI), or diagnosis-pointer?',
    'Do you want a corrected claim with the original claim number referenced, or a formal appeal?',
    'If corrected: what frequency/type-of-bill code should the correction carry?',
  ],
  eligibility: [
    'What coverage was active for this patient on the date of service, per your records?',
    'Is this a coordination-of-benefits order issue — is another payer primary?',
    'What eligibility reference number can I cite for this verification?',
  ],
  duplicate: [
    'What is the claim number of the original you matched this against, and its paid date?',
    'Were the services on different dates or units than the original — can we compare line by line?',
    'What documentation distinguishes this as a separate service — notes, timestamps?',
  ],
  experimental: [
    'Which policy bulletin classifies this service as experimental or investigational?',
    'What evidence or literature would reopen that classification for this case?',
    'Is an external review available for this policy category?',
  ],
  general: [
    'State the exact denial reason and the specific policy or edit that produced it.',
    'What documentation or correction would resolve this?',
    'What is the appeal deadline, and the correct submission channel — fax, portal, or mail?',
  ],
};

const GOOD_OUTCOMES = {
  medical_necessity: 'A peer-to-peer is scheduled, or the rep names the exact records that satisfy necessity and the claim is queued for re-review — with a reference number.',
  no_auth: 'A retro-auth is opened (with its reference number) or the rep confirms the auth on file and reprocesses the claim.',
  timely_filing: 'The rep confirms the original received date from their system, or tells you exactly which timely-filing proof to send and where.',
  coding: 'You know which edit fired and whether the fix is a corrected claim or an appeal — and the format they want for it.',
  eligibility: 'You have the coverage that was active on the date of service and an eligibility reference number to cite.',
  duplicate: 'You have the original claim number and paid date, and either a reprocessing or the documentation list that separates the services.',
  experimental: 'You have the policy bulletin citation and the evidence standard — or an external-review path.',
  general: 'The denial is overturned for reprocessing, or you leave with the exact next step, its deadline, and a reference number.',
};

const CLOSING_QUESTIONS = [
  'What date will this be reprocessed / resolved by?',
  'Please confirm your name and a reference number for this call that I can cite.',
];
const ESCALATION_LINE = 'If the rep cannot resolve it: "Please transfer me to a claims supervisor or the provider-relations escalation line — and note this call on the claim record before you transfer me."';

function openAppealFor(orgId, claimId) {
  return db.prepare(`
    SELECT id, status, follow_up_date FROM appeals
    WHERE org_id = ? AND claim_id = ? AND status NOT IN ('won', 'lost')
    ORDER BY id DESC LIMIT 1
  `).get(orgId, claimId) || null;
}

function recentCalls(orgId, claimId, limit = 5) {
  return db.prepare(`
    SELECT l.*, u.name AS user_name FROM agent_call_logs l
    LEFT JOIN users u ON u.id = l.user_id
    WHERE l.org_id = ? AND l.claim_id = ? ORDER BY l.id DESC LIMIT ?
  `).all(orgId, claimId, limit).map((r) => ({ ...r, outcome_label: OUTCOME_LABELS[r.outcome] || r.outcome }));
}

function buildCallBrief(orgId, claim) {
  const family = claim.status === 'denied' || claim.denial_reason
    ? categorizeReason(claim.denial_reason || '') : 'general';
  const filing = predict.filingRisk(orgId, claim.id);
  const appeal = openAppealFor(orgId, claim.id);
  const playbook = db.prepare(`
    SELECT title, category, content FROM payer_playbook
    WHERE org_id = ? AND (payer_id = ? OR payer_id IS NULL)
    ORDER BY CASE category WHEN 'appeals' THEN 0 WHEN 'billing' THEN 1 ELSE 2 END, updated_at DESC
    LIMIT 3
  `).all(orgId, claim.payer_id).map((e) => ({ title: e.title, category: e.category, content: String(e.content || '').slice(0, 400) }));

  const haveReady = [
    { label: 'Claim number', value: claim.claim_number },
    claim.payer_icn ? { label: 'Payer ICN / DCN', value: claim.payer_icn } : null,
    { label: 'Patient', value: claim.patient_name },
    claim.patient_dob ? { label: 'Patient DOB', value: claim.patient_dob } : null,
    claim.member_id ? { label: 'Member ID', value: claim.member_id } : null,
    { label: 'Date of service', value: claim.service_date },
    { label: 'Billed', value: `$${(claim.billed_amount || 0).toFixed(2)}` },
    claim.rendering_npi ? { label: 'Rendering NPI', value: claim.rendering_npi } : null,
  ].filter(Boolean);

  return {
    claim: {
      id: claim.id, claim_number: claim.claim_number, patient_name: claim.patient_name,
      payer: claim.payer, status: claim.status, denial_reason: claim.denial_reason || null,
      billed_amount: claim.billed_amount, paid_amount: claim.paid_amount,
    },
    family,
    family_label: CATEGORY_LABELS[family] || 'General',
    opening_line: `I'm calling about claim ${claim.claim_number} for ${claim.patient_name}, date of service ${claim.service_date}${claim.denial_reason ? `, denied for: ${claim.denial_reason}` : ''}.`,
    have_ready: haveReady,
    questions: [...(FAMILY_QUESTIONS[family] || FAMILY_QUESTIONS.general), ...CLOSING_QUESTIONS],
    good_outcome: GOOD_OUTCOMES[family] || GOOD_OUTCOMES.general,
    escalation: ESCALATION_LINE,
    playbook,
    filing_risk: filing,
    open_appeal: appeal ? { id: appeal.id, status: appeal.status, follow_up_date: appeal.follow_up_date || null } : null,
    recent_calls: recentCalls(orgId, claim.id, 3),
  };
}

function todayPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Follow-up rule: an explicit promised_date always wins; otherwise the
// outcome implies one (voicemail → retry tomorrow; a promise, an info
// request, or a transfer → check back in a week). denied_upheld / other
// carry no implied follow-up — the next step there is the appeal itself.
function impliedFollowUp(outcome, promisedDate) {
  if (promisedDate) return promisedDate;
  if (outcome === 'voicemail') return todayPlus(1);
  if (outcome === 'promised_payment' || outcome === 'info_requested' || outcome === 'transferred') return todayPlus(7);
  return null;
}

function logCall({ orgId, userId, claim, input }) {
  const outcome = String((input && input.outcome) || '');
  if (!OUTCOMES.includes(outcome)) {
    const e = new Error(`outcome must be one of: ${OUTCOMES.join(', ')}`);
    e.status = 400; throw e;
  }
  const promisedDate = input.promised_date && /^\d{4}-\d{2}-\d{2}$/.test(input.promised_date) ? input.promised_date : null;
  if (input.promised_date && !promisedDate) {
    const e = new Error('promised_date must be YYYY-MM-DD');
    e.status = 400; throw e;
  }
  const agentName = input.agent_name ? String(input.agent_name).slice(0, 120) : null;
  const referenceNumber = input.reference_number ? String(input.reference_number).slice(0, 120) : null;
  const notes = input.notes ? String(input.notes).slice(0, 2000) : null;
  const followUpDate = impliedFollowUp(outcome, promisedDate);

  const info = db.prepare(`
    INSERT INTO agent_call_logs (org_id, claim_id, user_id, agent_name, reference_number, outcome, promised_date, follow_up_date, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(orgId, claim.id, userId, agentName, referenceNumber, outcome, promisedDate, followUpDate, notes);
  const logId = Number(info.lastInsertRowid);

  // The follow-up attaches to the claim's open appeal — that is the
  // follow-up the worklist and the watchdog actually watch. With no open
  // appeal the date stays on the log row only (reported honestly).
  let followUpAppliedTo = null;
  const appeal = followUpDate ? openAppealFor(orgId, claim.id) : null;
  if (appeal) {
    db.prepare("UPDATE appeals SET follow_up_date = ?, updated_at = datetime('now') WHERE id = ?")
      .run(followUpDate, appeal.id);
    followUpAppliedTo = 'appeal';
  }

  const detail = [
    `Called ${claim.payer || 'payer'}`,
    agentName ? `spoke with ${agentName}` : null,
    referenceNumber ? `ref ${referenceNumber}` : null,
    `outcome: ${OUTCOME_LABELS[outcome] || outcome}`,
    promisedDate ? `payment promised by ${promisedDate}` : null,
    followUpDate ? `follow-up ${followUpDate}${followUpAppliedTo === 'appeal' ? ' set on the open appeal' : ''}` : null,
    notes,
  ].filter(Boolean).join(' — ');
  logActivity(orgId, claim.id, userId, 'payer_call', detail);

  const log = db.prepare('SELECT * FROM agent_call_logs WHERE id = ?').get(logId);
  return {
    log: { ...log, outcome_label: OUTCOME_LABELS[log.outcome] || log.outcome },
    follow_up: followUpDate ? { date: followUpDate, applied_to: followUpAppliedTo || 'log_only' } : null,
  };
}

module.exports = { buildCallBrief, logCall, recentCalls, OUTCOMES, OUTCOME_LABELS };
