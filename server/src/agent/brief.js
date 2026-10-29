'use strict';
// Morning brief (agent Phase 2) — the proactive daily summary at the top
// of the Agent page. Generated LAZILY on the first GET /api/agent/brief of
// a user's org-local day and then stored: no cron, no timers, and the
// UNIQUE(org_id, user_id, brief_date) constraint makes regeneration on a
// double-open impossible.
//
// Composition is deterministic first, model second:
//   1. "While you were away" counts from the claims / ERA / appeals tables
//      since the user's previous brief (or the last 24h for the first one).
//   2. Today's ranked plan from the SAME worklist computation the product
//      queue uses (worklistCore — deadline × dollars), with reasons.
//   3. Up to 3 appeal-ready denied claims in the plan get PENDING
//      draft_appeal actions pre-created through the Phase-1 executor, so
//      the brief renders approval cards inline. Claims with a live appeal
//      or an existing pending draft are skipped.
//   4. Only then — and only when there is something to summarize — ONE
//      model call writes the narrative sentence or two. The structured
//      content is complete without it; a model failure leaves summary null
//      and the brief still ships. That call counts as one metered turn.
const { db } = require('../db');
const { computeWorklist } = require('../worklistCore');
const { createExecutor } = require('./tools');
const { getAction, serializeAction } = require('./actions');
const { recordAgentTurn, checkAiQueryQuota } = require('../usage');
const { reconcileOutcomes } = require('./outcomes');
const predict = require('./predict');
const model = require('./model');

const MAX_PROPOSED_DRAFTS = 3;
const PLAN_ITEMS_SHOWN = 8;

// The org-local calendar date ('YYYY-MM-DD') in the org's configured
// timezone — the same timezone source the Settings page saves to.
function orgLocalDate(timezone, now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function utcStamp(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// ---- Deterministic sections (no model involved) ----

function buildWhileAway(orgId, sinceIso) {
  const newDenials = db.prepare(`
    SELECT id, claim_number, patient_name, billed_amount, denial_reason FROM claims
    WHERE org_id = ? AND status = 'denied' AND created_at >= ?
    ORDER BY billed_amount DESC LIMIT 5
  `).all(orgId, sinceIso);
  const newDenialsCount = db.prepare(
    "SELECT COUNT(*) AS n FROM claims WHERE org_id = ? AND status = 'denied' AND created_at >= ?"
  ).get(orgId, sinceIso).n;

  const eraPosted = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(paid), 0) AS total_paid FROM era_claim_lines
    WHERE org_id = ? AND post_status = 'posted' AND posted_at >= ?
  `).get(orgId, sinceIso);

  const excWhere = "org_id = ? AND post_status = 'pending' AND flags IS NOT NULL AND flags != '[]'";
  const eraExceptionsNew = db.prepare(`SELECT COUNT(*) AS n FROM era_claim_lines WHERE ${excWhere} AND created_at >= ?`).get(orgId, sinceIso).n;
  const eraExceptionsOnHold = db.prepare(`SELECT COUNT(*) AS n FROM era_claim_lines WHERE ${excWhere}`).get(orgId).n;

  // Follow-up dates that passed inside the window [window start, today).
  const followups = db.prepare(`
    SELECT COUNT(*) AS n FROM appeals
    WHERE org_id = ? AND status NOT IN ('won', 'lost')
      AND follow_up_date IS NOT NULL
      AND follow_up_date >= date(?) AND follow_up_date < date('now')
  `).get(orgId, sinceIso);

  return {
    since: sinceIso,
    new_denials: {
      count: newDenialsCount,
      highlights: newDenials.map((c) => ({
        claim_id: c.id, claim_number: c.claim_number, patient_name: c.patient_name,
        amount: money(c.billed_amount), denial_reason: c.denial_reason || null,
      })),
    },
    era_postings: { count: eraPosted.n, total_paid: money(eraPosted.total_paid) },
    era_exceptions: { new_count: eraExceptionsNew, on_hold_count: eraExceptionsOnHold },
    followups_passed: { count: followups.n },
  };
}

function slimPlanItem(item, rank) {
  return {
    rank,
    key: item.key,
    type: item.type,
    title: item.title,
    subtitle: item.subtitle || null,
    reason: item.reason,
    amount: item.amount != null ? money(item.amount) : null,
    due: item.due || null,
    claim_id: item.claim_id || null,
    appeal_id: item.appeal_id || null,
  };
}

const PLAN_KEY_ID = /^(followup|filing|denial|stale)-(\d+)$/;

// Guarantee explicit claim_id / appeal_id (nullable) on every plan item
// (deploy #97): the client wires Open claim / Draft appeal buttons off
// these fields, so a plan row must never arrive without them. Worklist
// items carry both already; the item key encodes them as a fallback
// (followup-<appealId>, filing-<claimId>, denial-<claimId>), and a
// follow-up item whose claim is missing resolves it through its appeal.
// Applied at build time AND in presentBrief, so a brief stored before an
// item gained its ids still reads actionable. Title/reason/amount are
// never touched.
function normalizePlanItem(orgId, item) {
  const out = { ...item, claim_id: item.claim_id ?? null, appeal_id: item.appeal_id ?? null };
  const m = PLAN_KEY_ID.exec(item.key || '');
  if (m) {
    const idFromKey = Number(m[2]);
    if (m[1] === 'followup' && out.appeal_id == null) out.appeal_id = idFromKey;
    if (m[1] !== 'followup' && out.claim_id == null) out.claim_id = idFromKey;
  }
  if (out.claim_id == null && out.appeal_id != null) {
    const appeal = db.prepare('SELECT claim_id FROM appeals WHERE id = ? AND org_id = ?').get(out.appeal_id, orgId);
    if (appeal) out.claim_id = appeal.claim_id;
  }
  return out;
}

// Appeal-ready = denied claim with NO live (non-terminal) appeal and NO
// pending draft_appeal action anywhere in the org for that claim.
function draftCandidates(orgId, planItems) {
  const pendingDraftClaims = new Set(
    db.prepare("SELECT payload FROM agent_actions WHERE org_id = ? AND kind = 'draft_appeal' AND status = 'pending'")
      .all(orgId)
      .map((r) => { try { return JSON.parse(r.payload || '{}').claim_id; } catch { return null; } })
      .filter((id) => id != null)
  );
  const seen = new Set();
  const out = [];
  for (const item of planItems) {
    if (!item.claim_id || seen.has(item.claim_id)) continue;
    seen.add(item.claim_id);
    const claim = db.prepare('SELECT id, status FROM claims WHERE id = ? AND org_id = ?').get(item.claim_id, orgId);
    if (!claim || claim.status !== 'denied') continue;
    const liveAppeal = db.prepare(
      "SELECT id FROM appeals WHERE claim_id = ? AND org_id = ? AND status NOT IN ('won', 'lost') LIMIT 1"
    ).get(item.claim_id, orgId);
    if (liveAppeal) continue;
    if (pendingDraftClaims.has(item.claim_id)) continue;
    out.push(item.claim_id);
    if (out.length >= MAX_PROPOSED_DRAFTS) break;
  }
  return out;
}

function hasAnythingToSummarize(content) {
  const w = content.while_away;
  return w.new_denials.count + w.era_postings.count + w.era_exceptions.new_count
    + w.followups_passed.count + content.plan.length > 0;
}

const NARRATIVE_SYSTEM = [
  'You write the one-paragraph narrative at the top of a medical billing team\'s morning brief.',
  'Use ONLY the JSON data given — never add facts, numbers, names, or advice that is not in it.',
  'Two or three short sentences, plain and operational: what changed overnight, then the single most important thing to work first (the top plan item) and why.',
  'No greeting, no sign-off, no markdown.',
].join('\n');

// ---- Stored-brief access ----

function findBrief(orgId, userId, briefDate) {
  return db.prepare('SELECT * FROM agent_briefs WHERE org_id = ? AND user_id = ? AND brief_date = ?')
    .get(orgId, userId, briefDate);
}

function briefActions(orgId, content) {
  const ids = (content && content.proposed_draft_action_ids) || [];
  return ids
    .map((id) => getAction(id, orgId))
    .filter((row) => row && row.status === 'pending')
    .map(serializeAction);
}

function presentBrief(row) {
  let content = {};
  try { content = row.content ? JSON.parse(row.content) : {}; } catch { content = {}; }
  return {
    brief: {
      id: row.id,
      brief_date: row.brief_date,
      timezone: content.timezone || null,
      summary: content.summary || null,
      while_away: content.while_away || null,
      plan: (content.plan || []).map((p) => normalizePlanItem(row.org_id, p)),
      proposed_draft_action_ids: content.proposed_draft_action_ids || [],
      created_at: row.created_at,
    },
    actions: briefActions(row.org_id, content),
  };
}

// Get today's brief, generating + persisting it on first read of the day.
// isSuperAdmin mirrors the chat route's quota exemption (deploy #89).
async function getOrCreateBrief({ orgId, user, isSuperAdmin = false }) {
  const org = db.prepare('SELECT timezone FROM orgs WHERE id = ?').get(orgId);
  const timezone = (org && org.timezone) || 'America/New_York';
  const today = orgLocalDate(timezone);

  const existing = findBrief(orgId, user.id, today);
  if (existing) return presentBrief(existing);

  // Phase 3 (WS5): refresh the org's appeal-outcome stats from decided
  // agent-drafted appeals before composing — once per org per day
  // (guarded inside), so today's predictions read yesterday's outcomes.
  // A reconciliation failure must never sink the brief.
  try { reconcileOutcomes(orgId); } catch (e) { console.error('[agent brief] outcome reconciliation failed:', e.message); }

  // Window: since the user's previous brief, else the last 24 hours.
  const prev = db.prepare(
    'SELECT created_at FROM agent_briefs WHERE org_id = ? AND user_id = ? AND brief_date < ? ORDER BY brief_date DESC LIMIT 1'
  ).get(orgId, user.id, today);
  const sinceIso = prev ? prev.created_at : utcStamp(new Date(Date.now() - 24 * 3600 * 1000));

  const worklist = computeWorklist(orgId, user.id, 'all');
  // Phase 3: plan items carry their prediction basis when the org's own
  // data supports one (e.g. "appeals to UHC on CO-172 overturn 58% of the
  // time here (n=24)") — structured field plus a suffix on the reason.
  const planRows = worklist.items.slice(0, PLAN_ITEMS_SHOWN);
  const planClaimIds = [...new Set(planRows.map((i) => i.claim_id).filter(Boolean))];
  const planClaims = new Map();
  if (planClaimIds.length) {
    for (const c of db.prepare(`
      SELECT c.*, p.name AS payer FROM claims c LEFT JOIN payers p ON p.id = c.payer_id
      WHERE c.org_id = ? AND c.id IN (${planClaimIds.map(() => '?').join(',')})
    `).all(orgId, ...planClaimIds)) planClaims.set(c.id, c);
  }
  const plan = planRows.map((item, i) => {
    const slim = normalizePlanItem(orgId, slimPlanItem(item, i + 1));
    const claim = item.claim_id ? planClaims.get(item.claim_id) : null;
    const pred = claim ? predict.predictionForClaim(orgId, claim) : null;
    if (pred) {
      slim.prediction = pred;
      slim.reason = `${slim.reason} · ${pred.detail}`;
    }
    return slim;
  });
  const content = {
    timezone,
    summary: null,
    while_away: buildWhileAway(orgId, sinceIso),
    plan,
    proposed_draft_action_ids: [],
  };

  // Persist FIRST: the UNIQUE constraint is the race guard — a concurrent
  // second open loses the insert and re-reads the winner's brief instead
  // of duplicating drafts.
  let row;
  try {
    const info = db.prepare('INSERT INTO agent_briefs (org_id, user_id, brief_date, content) VALUES (?, ?, ?, ?)')
      .run(orgId, user.id, today, JSON.stringify(content));
    row = db.prepare('SELECT * FROM agent_briefs WHERE id = ?').get(Number(info.lastInsertRowid));
  } catch (e) {
    const winner = findBrief(orgId, user.id, today);
    if (winner) return presentBrief(winner);
    throw e;
  }

  // Proposed drafts through the same executor the chat uses (convoId null:
  // these belong to the brief, not a conversation).
  const execute = createExecutor({ orgId, user, convoId: null });
  const actionIds = [];
  for (const claimId of draftCandidates(orgId, worklist.items)) {
    const result = await execute('draft_appeal', { claim_id: claimId });
    if (result && result.action) actionIds.push(result.action.id);
  }
  content.proposed_draft_action_ids = actionIds;

  // One narrative model call, only when there is something to summarize —
  // and only within the plan's AI-use allowance (deploy #89): at the cap
  // the narrative is skipped and the brief still ships, deterministic
  // sections complete, exactly as on a model failure.
  const narrativeAllowed = isSuperAdmin || !checkAiQueryQuota(orgId);
  if (hasAnythingToSummarize(content) && narrativeAllowed) {
    try {
      const slim = {
        while_away: content.while_away,
        plan: content.plan.slice(0, 5).map((p) => ({ title: p.title, reason: p.reason, amount: p.amount })),
        proposed_drafts: actionIds.length,
      };
      const result = await model.runTurn({
        system: NARRATIVE_SYSTEM,
        history: [],
        userText: `MORNING BRIEF NARRATIVE — write the brief narrative from this data:\n${JSON.stringify(slim)}`,
        tools: [],
        executeTool: async () => ({ output: { error: 'No tools are available for the brief narrative.' }, isError: true }),
      });
      if (result.reply) {
        content.summary = result.reply;
        recordAgentTurn(orgId, result.usage || {});
      }
    } catch (e) {
      console.error('[agent brief] narrative failed:', e.message);
    }
  }

  db.prepare('UPDATE agent_briefs SET content = ? WHERE id = ?').run(JSON.stringify(content), row.id);
  row = db.prepare('SELECT * FROM agent_briefs WHERE id = ?').get(row.id);
  return presentBrief(row);
}

module.exports = { getOrCreateBrief, orgLocalDate };
