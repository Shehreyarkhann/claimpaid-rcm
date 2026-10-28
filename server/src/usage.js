// Plan-usage counting + quota enforcement for the RCM app.
// Limits come from server/src/config/planLimits.js (single source of truth).
// Calendar months are UTC: claims.created_at is stored as datetime('now') (UTC).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const { db } = require('./db');
const { limitsForPlan, atLimit, usagePct } = require('./config/planLimits');

const UPGRADE_PATH = '/app/billing';

// 'YYYY-MM-01 00:00:00' for the current UTC month — string-comparable against
// claims.created_at ('YYYY-MM-DD HH:MM:SS', UTC).
function monthStartUtc(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01 00:00:00`;
}

// 'YYYY-MM' key used by the AI app's ai_query_usage table.
function monthKeyUtc(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function orgPlan(orgId) {
  const org = db.prepare('SELECT plan FROM orgs WHERE id = ?').get(orgId);
  return org?.plan || null;
}

function claimsUsedThisMonth(orgId, dbHandle = db, now = new Date()) {
  return dbHandle.prepare(
    'SELECT COUNT(*) AS c FROM claims WHERE org_id = ? AND created_at >= ?'
  ).get(orgId, monthStartUtc(now)).c;
}

function seatsUsed(orgId, dbHandle = db) {
  return dbHandle.prepare('SELECT COUNT(*) AS c FROM user_orgs WHERE org_id = ?').get(orgId).c;
}

// ---- AI query usage (read-only, from the AI app's own database) ----
// The AI app (askbase) counts queries per rcm_org_id per calendar month in its
// ai_query_usage table. This reads it read-only, mirroring how askbase reads
// the RCM DB (askbase/server/src/plans.js). Path is env-configurable so tests
// can point at a throwaway DB.
let _aiDb = null;
function aiDb() {
  if (_aiDb) return _aiDb;
  const p = process.env.AI_DB_PATH || '/opt/claimpaid-ai/server/askbase.db';
  try {
    _aiDb = new DatabaseSync(p, { readOnly: true });
    return _aiDb;
  } catch {
    return null;
  }
}

function aiQueriesUsedThisMonth(rcmOrgId, now = new Date()) {
  const adb = aiDb();
  if (!adb || !rcmOrgId) return { unknown: true, used: null };
  try {
    const t = adb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_query_usage'").get();
    if (!t) return { unknown: true, used: null };
    const row = adb.prepare('SELECT queries FROM ai_query_usage WHERE rcm_org_id = ? AND month = ?')
      .get(rcmOrgId, monthKeyUtc(now));
    return { unknown: false, used: row ? row.queries : 0 };
  } catch {
    return { unknown: true, used: null };
  }
}

// ---- Agent usage (RCM-side, agent_usage table) ----
// The in-app agent meters COMPLETED turns (chat turns + the brief's single
// narrative call) into agent_usage in THIS database — never into the AI
// app's DB. usageForOrg merges those turns into the reported aiQueries
// figure so Billing shows one true AI total across both products.
function agentTurnsThisMonth(orgId, now = new Date()) {
  try {
    const row = db.prepare('SELECT turns FROM agent_usage WHERE org_id = ? AND month = ?')
      .get(orgId, monthKeyUtc(now));
    return row ? row.turns : 0;
  } catch {
    return 0; // table missing (pre-Phase-2 DB before first boot migration) — count nothing
  }
}

function recordAgentTurn(orgId, usage = {}, now = new Date()) {
  try {
    db.prepare(`
      INSERT INTO agent_usage (org_id, month, turns, input_tokens, output_tokens)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(org_id, month) DO UPDATE SET
        turns = turns + 1,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens
    `).run(orgId, monthKeyUtc(now), usage.inputTokens || 0, usage.outputTokens || 0);
  } catch (e) {
    // Metering must never break the turn it is counting.
    console.error('[usage] recordAgentTurn failed:', e.message);
  }
}

// Merged AI usage: AskBase chat queries (read from the AI DB) + agent turns
// (this DB). `unknown` tracks the AskBase read only — when that read fails,
// `used` is the agent-only partial and pct stays null, exactly like before.
function mergedAiQueriesUsed(orgId, now = new Date()) {
  const ai = aiQueriesUsedThisMonth(orgId, now);
  const agentTurns = agentTurnsThisMonth(orgId, now);
  return { used: (ai.used || 0) + agentTurns, unknown: ai.unknown, askbaseUsed: ai.used, agentTurns };
}

// Full usage snapshot for an org (powers the Billing usage bars and the 80%
// warning banner). Never throws — a counter that can't be read reports unknown.
function usageForOrg(orgId) {
  const plan = orgPlan(orgId);
  const limits = limitsForPlan(plan);
  const claimsUsed = claimsUsedThisMonth(orgId);
  const seatsUsedCount = seatsUsed(orgId);
  const ai = mergedAiQueriesUsed(orgId);

  const claims = { used: claimsUsed, limit: limits.claimsPerMonth, pct: usagePct(claimsUsed, limits.claimsPerMonth) };
  const seats = { used: seatsUsedCount, limit: limits.seats, pct: usagePct(seatsUsedCount, limits.seats) };
  const aiQueries = {
    used: ai.used, limit: limits.aiQueriesPerMonth,
    pct: ai.unknown ? null : usagePct(ai.used, limits.aiQueriesPerMonth),
    unknown: ai.unknown,
    agentTurns: ai.agentTurns,
  };
  const warn = [];
  for (const [key, u] of [['claims', claims], ['seats', seats], ['aiQueries', aiQueries]]) {
    if (u.pct !== null && u.pct >= 0.8) warn.push(key);
  }
  return { plan: plan || 'trial', claims, seats, aiQueries, warn, monthStartUtc: monthStartUtc() };
}

// ---- Quota enforcement middleware (402 = limit hit, client shows modal) ----

function quotaExceeded(res, kind, plan, limit, used) {
  const planLabel = { starter: 'RCM Starter', pro: 'RCM Pro + AI', ai: 'ClaimPaid AI', enterprise: 'Enterprise' }[plan] || 'your';
  const noun = { claim_limit_reached: 'claims', seat_limit_reached: 'team seats', ai_query_limit_reached: 'AI queries' }[kind] || 'units';
  return res.status(402).json({
    error: kind,
    plan: plan || 'trial',
    planLabel,
    limit,
    used,
    upgrade: UPGRADE_PATH,
    message: `You've hit your ${planLabel} plan limit (${used} of ${limit} ${noun} used this month). Upgrade to keep going without interruption.`,
  });
}

// Blocks claim creation (and CSV bulk import) at 100% of the monthly claim quota.
function checkClaimQuota(req, res, next) {
  if (req.isSuperAdmin) return next(); // super-admin: no quotas (deploy #54)
  try {
    const plan = orgPlan(req.orgId);
    const { claimsPerMonth } = limitsForPlan(plan);
    if (claimsPerMonth === null) return next(); // enterprise/grandfathered: unlimited
    const used = claimsUsedThisMonth(req.orgId);
    if (atLimit(used, claimsPerMonth)) return quotaExceeded(res, 'claim_limit_reached', plan, claimsPerMonth, used);
    return next();
  } catch (e) {
    return next(e);
  }
}

// Blocks team invites at the seat cap.
function checkSeatQuota(req, res, next) {
  try {
    const plan = orgPlan(req.orgId);
    const { seats } = limitsForPlan(plan);
    if (seats === null) return next();
    const used = seatsUsed(req.orgId);
    if (atLimit(used, seats)) return quotaExceeded(res, 'seat_limit_reached', plan, seats, used);
    return next();
  } catch (e) {
    return next(e);
  }
}

// Agent-turn quota gate for POST /api/agent/chat. Returns { plan, limit,
// used } when the org is at/over its plan AI-query allowance, else null.
// Phase-2 policy (founder decision pending — see the Phase 2 report): the
// gate fires ONLY when the plan carries a positive finite allowance (Pro
// 2,000, AI 1,000). A 0 allowance (Starter: "no AI product") does NOT block
// the agent in this phase — those turns are counted and surfaced instead,
// and null (enterprise / legacy-grandfathered) never blocks.
function checkAiQueryQuota(orgId) {
  const plan = orgPlan(orgId);
  const limit = limitsForPlan(plan).aiQueriesPerMonth;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return null;
  const { used } = mergedAiQueriesUsed(orgId);
  return used >= limit ? { plan, limit, used } : null;
}

module.exports = {
  monthStartUtc,
  monthKeyUtc,
  orgPlan,
  claimsUsedThisMonth,
  seatsUsed,
  aiQueriesUsedThisMonth,
  agentTurnsThisMonth,
  recordAgentTurn,
  mergedAiQueriesUsed,
  usageForOrg,
  quotaExceeded,
  checkAiQueryQuota,
  checkClaimQuota,
  checkSeatQuota,
};
