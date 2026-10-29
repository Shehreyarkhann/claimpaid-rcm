'use strict';
// Agent approval actions — the human-in-the-loop core of the agent.
// The agent PROPOSES by inserting a 'pending' row here; nothing touches
// claims/appeals until a person approves. Approve -> execute against the
// existing product flows; reject -> the proposal dies. Every decision and
// execution writes to the HIPAA audit log (auditLog) and, for executed
// appeal drafts, to the claim's activity timeline.
const { db } = require('../db');
const { auditLog } = require('../audit');
const { logActivity } = require('../activity');

function parseJson(s, fallback) {
  if (s == null) return fallback;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return fallback; }
}

function actionTitle(row, payload) {
  const p = payload || parseJson(row.payload, {});
  if (row.kind === 'apply_intake') {
    const what = p.doc_kind === 'remittance' ? 'remittance' : p.doc_kind === 'denial_letter' ? 'denial letter' : 'document';
    return `Apply intake — ${what}${p.filename ? ` (${p.filename})` : ''}`;
  }
  if (row.kind === 'draft_appeal') return `Draft appeal — claim ${p.claim_number || `#${p.claim_id || ''}`}`;
  if (row.kind === 'apply_codes') return `Apply codes — claim ${p.claim_number || `#${p.claim_id || ''}`}`;
  if (row.kind === 'resolve_exception') return `Resolve ERA exception — ${p.claim_number ? `claim ${p.claim_number}` : `line ${p.clp_ref || `#${p.era_line_id || ''}`}`}`;
  return row.kind;
}

function serializeAction(row) {
  if (!row) return null;
  const payload = parseJson(row.payload, {});
  return {
    id: row.id,
    kind: row.kind,
    title: actionTitle(row, payload),
    status: row.status,
    preview: row.preview || '',
    // Only the display-safe payload subset leaves the server (the full
    // letter lives in `preview`; the stored payload keeps it for execution).
    payload: {
      claim_id: payload.claim_id ?? null,
      claim_number: payload.claim_number ?? null,
      document_id: payload.document_id ?? null,
      doc_kind: payload.doc_kind ?? null,
      filename: payload.filename ?? null,
      payer: payload.payer ?? null,
      category: payload.category ?? null,
      angle_source: payload.angle_source ?? null,
      angle_stat: payload.angle_stat ?? null,
      subject: payload.subject ?? null,
      codes: Array.isArray(payload.codes) ? payload.codes.map((c) => ({ code: c.code, type: c.type })) : null,
      disposition: payload.disposition ?? null,
      disposition_label: payload.disposition_label ?? null,
      era_line_id: payload.era_line_id ?? null,
      job_id: payload.job_id ?? null,
    },
    result: parseJson(row.result, null),
    auto_approved: row.auto_approved === 1,
    auto_snapshot: parseJson(row.auto_snapshot, null),
    created_at: row.created_at,
    decided_at: row.decided_at,
    executed_at: row.executed_at,
  };
}

function createAction({ orgId, userId, convoId, kind, payload, preview }) {
  const info = db.prepare(`
    INSERT INTO agent_actions (org_id, user_id, convo_id, kind, payload, preview, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `).run(orgId, userId, convoId || null, kind, JSON.stringify(payload || {}), preview || '');
  const row = db.prepare('SELECT * FROM agent_actions WHERE id = ?').get(Number(info.lastInsertRowid));
  // Deploy #101: approval policy tiers — a draft_appeal created through
  // ANY path (brief, chat, wizard, intake) is evaluated against the
  // owner's auto-approve policy the moment it exists. Qualifying drafts
  // execute immediately through the same approve path a human uses;
  // everything else stays pending exactly as before. Policy is OFF by
  // default, and a policy failure must never break creation.
  if (kind === 'draft_appeal') {
    try {
      const after = maybeAutoApprove(row);
      if (after) return after;
    } catch (e) {
      console.error('[agent] auto-approve evaluation failed:', e.message);
    }
  }
  return row;
}

// The auto-approve gate. Returns the updated action row when the policy
// fired (executed or failed), else null (stays human-queued).
function maybeAutoApprove(action) {
  const { evaluateDraftAction } = require('./policy');
  const verdict = evaluateDraftAction(action.org_id, action);
  if (!verdict.qualifies) return null;
  const snapshot = {
    policy: verdict.policy,
    prediction: verdict.prediction,
    claim_amount: verdict.claim_amount,
    evaluated_at: new Date().toISOString(),
  };
  db.prepare('UPDATE agent_actions SET auto_approved = 1, auto_snapshot = ? WHERE id = ?')
    .run(JSON.stringify(snapshot), action.id);
  // The executor runs as the proposing user (their id authors the appeal
  // note, labeled auto-approved there); the audit trail records the
  // decision as the policy's, with the snapshot attached to the row.
  const req = {
    orgId: action.org_id,
    user: { id: action.user_id, email: null, name: null },
    ip: null, headers: {}, autoApprove: snapshot,
  };
  const fresh = getAction(action.id, action.org_id);
  return approveAction(req, fresh, { auto: snapshot });
}

function getAction(id, orgId) {
  return db.prepare('SELECT * FROM agent_actions WHERE id = ? AND org_id = ?').get(id, orgId);
}

// --- Executors: one per action kind. Throw on failure; the caller records
// 'failed' honestly instead of pretending the work happened. ---

function executeDraftAppeal(req, action) {
  const payload = parseJson(action.payload, {});
  const claim = db.prepare('SELECT id, claim_number FROM claims WHERE id = ? AND org_id = ?')
    .get(payload.claim_id, action.org_id);
  if (!claim) throw new Error('The claim no longer exists in this workspace.');
  if (!payload.letter) throw new Error('The draft letter is missing from this action.');

  // Save through the EXISTING appeals flow: an appeal record in its initial
  // 'open' state (the pre-submission draft state — appeals only become
  // 'submitted' by an explicit user action in Denial Appeals) with the
  // letter stored ON the appeal (appeals.letter, deploy #98) where the
  // Denial Appeals letter panel renders it with Edit / Print / Mark as
  // submitted. Nothing is filed or sent to the payer. If an appeal already
  // exists for the claim, the draft attaches to it instead of duplicating
  // the record; the notes timeline gets at most ONE short system line —
  // never the full letter (pre-#98 behavior, repaired by the
  // appeal-letter-repair-98 migration).
  let appeal = db.prepare('SELECT id, letter FROM appeals WHERE claim_id = ? AND org_id = ?')
    .get(claim.id, action.org_id);
  let letterLocation = 'appeal';
  const appealPreExisted = !!appeal;
  // Deploy #101: an auto-approved draft says so on the appeal timeline —
  // nobody clicked Approve, and the record must not pretend otherwise.
  const savedNote = req.autoApprove
    ? 'Appeal draft saved by the auto-approval policy (no human decision) — the letter is in the letter panel.'
    : 'Appeal draft saved via agent approval — the letter is in the letter panel.';
  if (!appeal) {
    const info = db.prepare(`
      INSERT INTO appeals (org_id, claim_id, assigned_to, status, priority, letter)
      VALUES (?, ?, ?, 'open', 'medium', ?)
    `).run(action.org_id, claim.id, action.user_id, payload.letter);
    appeal = { id: Number(info.lastInsertRowid), letter: payload.letter };
    db.prepare('INSERT INTO appeal_notes (appeal_id, user_id, note) VALUES (?, ?, ?)')
      .run(appeal.id, req.user.id, savedNote);
  } else if (!appeal.letter || !appeal.letter.trim()) {
    db.prepare('UPDATE appeals SET letter = ? WHERE id = ?').run(payload.letter, appeal.id);
    db.prepare('INSERT INTO appeal_notes (appeal_id, user_id, note) VALUES (?, ?, ?)')
      .run(appeal.id, req.user.id, savedNote);
  } else if (appeal.letter.trim() !== payload.letter.trim()) {
    // The appeal already carries a letter (a person's own, or an earlier
    // approved draft). Keep it as THE letter; preserve this new draft as a
    // clearly-titled note so nothing is silently overwritten or lost.
    db.prepare('INSERT INTO appeal_notes (appeal_id, user_id, note) VALUES (?, ?, ?)')
      .run(appeal.id, req.user.id, `Additional draft letter (agent)\n\n${payload.letter}`);
    letterLocation = 'additional_note';
  }
  logActivity(action.org_id, claim.id, req.user.id, 'appeal_drafted',
    `Appeal drafted by the agent and approved — saved on claim ${claim.claim_number} as a draft (not submitted)`);
  return {
    appeal_id: appeal.id, appeal_status: 'open', appeal_created: !appealPreExisted,
    letter_saved_as_note: letterLocation === 'additional_note', letter_location: letterLocation,
  };
}

// --- apply_codes (Phase 3): apply the human-approved Valid code set ---
// Uses the EXISTING claim-update path — applyToClaim from the coding
// routes, the same dedupe-merge the Coding panel's decide endpoint runs.
// Only codes the quote-verified engine marked 'valid' are ever in the
// payload (the suggest_codes tool builds it that way), mirroring the
// panel's hard rule that unverified codes never apply on AI authority.
function recordCodingDecisions(jobId, codes, decision, userId) {
  if (!jobId || !Array.isArray(codes) || !codes.length) return;
  const ins = db.prepare(`
    INSERT INTO coding_decisions (job_id, code, type, decision, final_code, in_library, decided_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const c of codes) ins.run(jobId, c.code, c.type, decision, c.final_code || null, 1, userId);
}

function executeApplyCodes(req, action) {
  const payload = parseJson(action.payload, {});
  const claim = db.prepare('SELECT id, claim_number FROM claims WHERE id = ? AND org_id = ?')
    .get(payload.claim_id, action.org_id);
  if (!claim) throw new Error('The claim no longer exists in this workspace.');
  const codes = Array.isArray(payload.codes) ? payload.codes : [];
  if (!codes.length) throw new Error('No verified codes were attached to this action.');
  const { applyToClaim } = require('../routes/coding');
  applyToClaim(action.org_id, claim.id, req.user.id,
    codes.map((c) => ({ code: c.code, type: c.type, final_code: c.final_code || null })));
  recordCodingDecisions(payload.job_id, codes, 'accepted', req.user.id);
  logActivity(action.org_id, claim.id, req.user.id, 'codes_applied',
    `Agent-proposed codes approved and applied to claim ${claim.claim_number} (${codes.map((c) => c.final_code || c.code).join(', ')})`);
  return { claim_id: claim.id, applied_codes: codes.map((c) => `${c.type}:${c.final_code || c.code}`), job_id: payload.job_id || null };
}

// --- resolve_exception (Phase 3): apply an approved ERA disposition ---
// Runs eraResolve.applyResolution — posting dispositions go through the
// existing eraPosting.postLine engine; write-off through the existing
// ignore transition. eraResolve is required lazily: it imports
// createAction from this module, and the lazy require keeps the cycle
// one-directional at load time.
function executeResolveException(req, action) {
  const payload = parseJson(action.payload, {});
  const { applyResolution } = require('./eraResolve');
  const line = db.prepare('SELECT * FROM era_claim_lines WHERE id = ? AND org_id = ?')
    .get(payload.era_line_id, action.org_id);
  if (!line) throw new Error('The ERA line no longer exists in this workspace.');
  const result = applyResolution({ orgId: action.org_id, user: req.user }, line, payload.disposition);
  if (result.claim_id) {
    logActivity(action.org_id, result.claim_id, req.user.id, 'era_exception_resolved',
      `ERA exception resolved via agent action (${payload.disposition}) on claim — ${result.posted ? `posted, claim now ${result.new_status}` : 'line written off/ignored'}`);
  }
  return result;
}

// --- apply_intake (Phase 5): apply a reviewed document intake ---
// intake.js builds its actions through this module's createAction, so it
// is required lazily (same one-directional cycle rule as eraResolve).
function executeApplyIntake(req, action) {
  return require('./intake').applyIntake(req, action);
}

const EXECUTORS = { draft_appeal: executeDraftAppeal, apply_codes: executeApplyCodes, resolve_exception: executeResolveException, apply_intake: executeApplyIntake };

function executeAction(req, action) {
  const fn = EXECUTORS[action.kind];
  if (!fn) throw new Error(`No executor for action kind '${action.kind}'`);
  return fn(req, action);
}

function decidedError() {
  const e = new Error('This action has already been decided.');
  e.status = 409;
  return e;
}

function approveAction(req, action, opts = {}) {
  if (action.status !== 'pending') throw decidedError();
  const label = actionTitle(action);
  const auto = opts.auto || null;
  auditLog(req, auto ? 'agent_action_auto_approve' : 'agent_action_approve', 'agent_action', action.id, label);
  try {
    const result = executeAction(req, action);
    const stored = auto ? { ...result, auto_approved: true, auto_snapshot: auto } : result;
    db.prepare(`
      UPDATE agent_actions SET status = 'executed', result = ?,
        decided_at = datetime('now'), executed_at = datetime('now') WHERE id = ?
    `).run(JSON.stringify(stored), action.id);
    auditLog(req, auto ? 'agent_action_auto_execute' : 'agent_action_execute', 'agent_action', action.id, label);
  } catch (e) {
    db.prepare(`
      UPDATE agent_actions SET status = 'failed', result = ?,
        decided_at = datetime('now') WHERE id = ?
    `).run(JSON.stringify({ error: e.message }), action.id);
    auditLog(req, 'agent_action_execute_failed', 'agent_action', action.id, label);
  }
  return getAction(action.id, action.org_id);
}

// --- Void an auto-approved draft (deploy #101) ---
// The review stream's undo: removes the draft appeal the policy created
// (the appeal row + its notes, the same delete the Denials DELETE route
// performs) and marks the action 'voided'. Refused once the appeal has
// left the draft state — submitted or decided appeals are real work
// product and are never deleted from a review list.
function voidAutoApproved(req, action) {
  if (!action.auto_approved || action.kind !== 'draft_appeal' || action.status !== 'executed') {
    const e = new Error('Only an executed auto-approved draft can be voided.');
    e.status = 400;
    throw e;
  }
  const result = parseJson(action.result, {});
  const appealId = result.appeal_id;
  const appeal = appealId
    ? db.prepare('SELECT * FROM appeals WHERE id = ? AND org_id = ?').get(appealId, action.org_id)
    : null;
  if (appeal) {
    if (appeal.status !== 'open' || appeal.submitted_at) {
      const e = new Error('This draft has already been worked or submitted — void it from Denial Appeals instead.');
      e.status = 409;
      throw e;
    }
    if (result.letter_location === 'additional_note') {
      // The appeal pre-existed with its own letter; the policy only added
      // a draft note — remove exactly that note, nothing else.
      const note = db.prepare(`
        SELECT id FROM appeal_notes WHERE appeal_id = ? AND note LIKE 'Additional draft letter (agent)%'
        ORDER BY id DESC LIMIT 1
      `).get(appeal.id);
      if (note) db.prepare('DELETE FROM appeal_notes WHERE id = ?').run(note.id);
      logActivity(action.org_id, appeal.claim_id, req.user.id, 'appeal_voided',
        `Auto-approved draft note voided from the review stream — appeal #${appeal.id} kept, draft note removed`);
    } else if (result.appeal_created) {
      db.prepare('DELETE FROM appeal_notes WHERE appeal_id = ?').run(appeal.id);
      db.prepare('DELETE FROM appeals WHERE id = ?').run(appeal.id);
      logActivity(action.org_id, appeal.claim_id, req.user.id, 'appeal_voided',
        `Auto-approved appeal draft voided from the review stream — draft appeal #${appeal.id} removed`);
    } else {
      // The appeal pre-existed empty; the policy filled its letter —
      // voiding clears the letter back out.
      db.prepare('UPDATE appeals SET letter = NULL WHERE id = ?').run(appeal.id);
      logActivity(action.org_id, appeal.claim_id, req.user.id, 'appeal_voided',
        `Auto-approved draft letter voided from the review stream — letter cleared from appeal #${appeal.id}`);
    }
  }
  db.prepare("UPDATE agent_actions SET status = 'voided' WHERE id = ?").run(action.id);
  auditLog(req, 'agent_action_void_auto', 'agent_action', action.id, actionTitle(action));
  return getAction(action.id, action.org_id);
}

function rejectAction(req, action) {
  if (action.status !== 'pending') throw decidedError();
  db.prepare("UPDATE agent_actions SET status = 'rejected', decided_at = datetime('now') WHERE id = ?").run(action.id);
  auditLog(req, 'agent_action_reject', 'agent_action', action.id, actionTitle(action));
  // Decision substrate (Phase 3): a rejected apply_codes proposal records
  // the rejected coding decisions on its job, same as the Coding panel —
  // accept/reject history is what Phase 4 learns suggestion quality from.
  if (action.kind === 'apply_codes') {
    const payload = parseJson(action.payload, {});
    recordCodingDecisions(payload.job_id, payload.codes, 'rejected', req.user.id);
  }
  // Rejecting an intake apply dismisses the document — nothing created.
  if (action.kind === 'apply_intake') {
    const payload = parseJson(action.payload, {});
    if (payload.document_id) {
      db.prepare(`
        UPDATE agent_documents SET status = 'dismissed', updated_at = datetime('now')
        WHERE id = ? AND org_id = ? AND status != 'applied'
      `).run(payload.document_id, action.org_id);
    }
  }
  return getAction(action.id, action.org_id);
}

module.exports = { createAction, getAction, serializeAction, approveAction, rejectAction, actionTitle, voidAutoApproved };
