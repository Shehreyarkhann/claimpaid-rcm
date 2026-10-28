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
  if (row.kind === 'draft_appeal') return `Draft appeal — claim ${p.claim_number || `#${p.claim_id || ''}`}`;
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
      payer: payload.payer ?? null,
      category: payload.category ?? null,
      subject: payload.subject ?? null,
    },
    result: parseJson(row.result, null),
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
  return db.prepare('SELECT * FROM agent_actions WHERE id = ?').get(Number(info.lastInsertRowid));
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
  // letter preserved on the appeal timeline as a note. Nothing is filed or
  // sent to the payer. If an appeal already exists for the claim, the draft
  // letter attaches to it instead of duplicating the record.
  let appeal = db.prepare('SELECT id FROM appeals WHERE claim_id = ? AND org_id = ?')
    .get(claim.id, action.org_id);
  if (!appeal) {
    const info = db.prepare(`
      INSERT INTO appeals (org_id, claim_id, assigned_to, status, priority)
      VALUES (?, ?, ?, 'open', 'medium')
    `).run(action.org_id, claim.id, action.user_id);
    appeal = { id: Number(info.lastInsertRowid) };
  }
  db.prepare('INSERT INTO appeal_notes (appeal_id, user_id, note) VALUES (?, ?, ?)')
    .run(appeal.id, req.user.id, payload.letter);
  logActivity(action.org_id, claim.id, req.user.id, 'appeal_drafted',
    `Appeal drafted by the agent and approved — saved on claim ${claim.claim_number} as a draft (not submitted)`);
  return { appeal_id: appeal.id, appeal_status: 'open', letter_saved_as_note: true };
}

const EXECUTORS = { draft_appeal: executeDraftAppeal };

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

function approveAction(req, action) {
  if (action.status !== 'pending') throw decidedError();
  const label = actionTitle(action);
  auditLog(req, 'agent_action_approve', 'agent_action', action.id, label);
  try {
    const result = executeAction(req, action);
    db.prepare(`
      UPDATE agent_actions SET status = 'executed', result = ?,
        decided_at = datetime('now'), executed_at = datetime('now') WHERE id = ?
    `).run(JSON.stringify(result), action.id);
    auditLog(req, 'agent_action_execute', 'agent_action', action.id, label);
  } catch (e) {
    db.prepare(`
      UPDATE agent_actions SET status = 'failed', result = ?,
        decided_at = datetime('now') WHERE id = ?
    `).run(JSON.stringify({ error: e.message }), action.id);
    auditLog(req, 'agent_action_execute_failed', 'agent_action', action.id, label);
  }
  return getAction(action.id, action.org_id);
}

function rejectAction(req, action) {
  if (action.status !== 'pending') throw decidedError();
  db.prepare("UPDATE agent_actions SET status = 'rejected', decided_at = datetime('now') WHERE id = ?").run(action.id);
  auditLog(req, 'agent_action_reject', 'agent_action', action.id, actionTitle(action));
  return getAction(action.id, action.org_id);
}

module.exports = { createAction, getAction, serializeAction, approveAction, rejectAction, actionTitle };
