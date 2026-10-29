// Plan-usage counting + quota enforcement for the RCM app.
// Limits come from server/src/config/planLimits.js (single source of truth).
// Calendar months are UTC: claims.created_at is stored as datetime('now') (UTC).
//
// ACCOUNT POOLS (deploy #100): claims/month and AI-uses/month are pooled at
// the ACCOUNT level — the limit applies to the SUM across every workspace
// the account holder owns, never per workspace. Seats count unique people
// on the account roster. usageForOrg reports account totals plus a
// per-workspace breakdown (used_by_workspace); every enforcement point
// consults the account total, so workspace B blocks when workspace A
// consumed the pool.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const { db } = require('./db');
const { limitsForPlan, atLimit, usagePct, seatUsage } = require('./config/planLimits');
const account = require('./account');

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

// Claims used this month per workspace + the account total.
function claimsUsedByWorkspace(orgIds, now = new Date()) {
  return orgIds.map((orgId) => ({ org_id: orgId, claims: claimsUsedThisMonth(orgId, db, now) }));
}

function accountClaimsUsedThisMonth(orgId, now = new Date()) {
  return claimsUsedByWorkspace(account.accountOrgIdsForOrg(orgId), now)
    .reduce((sum, w) => sum + w.claims, 0);
}

// Seats = unique people on the ACCOUNT roster (deploy #100). Delegates to
// planLimits.seatUsage, which resolves the roster across the holder's orgs.
function seatsUsed(orgId, dbHandle = db) {
  return seatUsage(dbHandle, orgId).used;
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

// Merged AI usage for ONE org: AskBase chat queries (read from the AI DB) +
// agent turns (this DB). `unknown` tracks the AskBase read only — when that
// read fails, `used` is the agent-only partial and pct stays null.
function mergedAiQueriesUsed(orgId, now = new Date()) {
  const ai = aiQueriesUsedThisMonth(orgId, now);
  const agentTurns = agentTurnsThisMonth(orgId, now);
  return { used: (ai.used || 0) + agentTurns, unknown: ai.unknown, askbaseUsed: ai.used, agentTurns };
}

// Merged AI usage pooled across an account's orgs, with the per-workspace
// split. `unknown` is true when the AskBase read fails for any org.
function mergedAiUsedByWorkspace(orgIds, now = new Date()) {
  const per = orgIds.map((orgId) => ({ org_id: orgId, ...mergedAiQueriesUsed(orgId, now) }));
  return {
    per,
    used: per.reduce((sum, w) => sum + (w.used || 0), 0),
    unknown: per.some((w) => w.unknown),
    agentTurns: per.reduce((sum, w) => sum + (w.agentTurns || 0), 0),
  };
}

function accountMergedAiUsed(orgId, now = new Date()) {
  return mergedAiUsedByWorkspace(account.accountOrgIdsForOrg(orgId), now);
}

// Full usage snapshot for an org (powers the Billing usage bars and the 80%
// warning banner). Claims, AI uses and seats are ACCOUNT totals (deploy
// #100) with a per-workspace breakdown in used_by_workspace. Never throws —
// a counter that can't be read reports unknown.
function usageForOrg(orgId) {
  const plan = orgPlan(orgId);
  const limits = limitsForPlan(plan);
  const { ownerId, orgIds } = account.accountForOrg(orgId);

  const claimsByWs = claimsUsedByWorkspace(orgIds);
  const claimsTotal = claimsByWs.reduce((sum, w) => sum + w.claims, 0);
  const aiByWs = mergedAiUsedByWorkspace(orgIds);
  const seatsUsedCount = seatsUsed(orgId);
  const wsUsage = account.workspaceUsage(ownerId, plan);

  const orgNames = new Map(
    db.prepare(`SELECT id, name FROM orgs WHERE id IN (${orgIds.map(() => '?').join(',')})`).all(...orgIds)
      .map((o) => [o.id, o.name]),
  );
  const aiByOrg = new Map(aiByWs.per.map((w) => [w.org_id, w.used]));
  const used_by_workspace = claimsByWs.map((w) => ({
    org_id: w.org_id,
    name: orgNames.get(w.org_id) || `Workspace ${w.org_id}`,
    claims: w.claims,
    aiQueries: aiByOrg.get(w.org_id) || 0,
  }));

  const claims = { used: claimsTotal, limit: limits.claimsPerMonth, pct: usagePct(claimsTotal, limits.claimsPerMonth) };
  const seats = { used: seatsUsedCount, limit: limits.seats, pct: usagePct(seatsUsedCount, limits.seats) };
  const aiQueries = {
    used: aiByWs.used, limit: limits.aiQueriesPerMonth,
    pct: aiByWs.unknown ? null : usagePct(aiByWs.used, limits.aiQueriesPerMonth),
    unknown: aiByWs.unknown,
    agentTurns: aiByWs.agentTurns,
  };
  const workspaces = { used: wsUsage.used, limit: wsUsage.limit };
  const warn = [];
  for (const [key, u] of [['claims', claims], ['seats', seats], ['aiQueries', aiQueries]]) {
    if (u.pct !== null && u.pct >= 0.8) warn.push(key);
  }
  return {
    plan: plan || 'trial', claims, seats, aiQueries, workspaces, used_by_workspace,
    warn, monthStartUtc: monthStartUtc(),
  };
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

// Blocks claim creation (and CSV bulk import) at 100% of the monthly claim
// quota — the ACCOUNT pool (deploy #100): claims created in any of the
// account's workspaces count toward the same limit.
function checkClaimQuota(req, res, next) {
  if (req.isSuperAdmin) return next(); // super-admin: no quotas (deploy #54)
  try {
    const plan = orgPlan(req.orgId);
    const { claimsPerMonth } = limitsForPlan(plan);
    if (claimsPerMonth === null) return next(); // enterprise/grandfathered: unlimited
    const used = accountClaimsUsedThisMonth(req.orgId);
    if (atLimit(used, claimsPerMonth)) return quotaExceeded(res, 'claim_limit_reached', plan, claimsPerMonth, used);
    return next();
  } catch (e) {
    return next(e);
  }
}

// Blocks team invites at the seat cap. Seats are roster people (deploy
// #100): inviting someone who is ALREADY on the account roster into another
// workspace consumes no seat and is never blocked here.
function checkSeatQuota(req, res, next) {
  try {
    const plan = orgPlan(req.orgId);
    const { seats } = limitsForPlan(plan);
    if (seats === null) return next();
    const { ownerId } = account.accountForOrg(req.orgId);
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (ownerId && email) {
      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (existing && account.rosterUserIds(ownerId).includes(existing.id)) return next();
    }
    const used = seatsUsed(req.orgId);
    if (atLimit(used, seats)) return quotaExceeded(res, 'seat_limit_reached', plan, seats, used);
    return next();
  } catch (e) {
    return next(e);
  }
}

// Agent-turn quota gate for the agent's AI-consumption paths (chat,
// document extraction, tools/run, the brief's narrative call). Returns
// { plan, limit, used } when the ACCOUNT is at/over its plan AI-use
// allowance (pooled across its workspaces, deploy #100), else null.
// Decided policy (founder, 2026-10-28): the gate fires whenever the plan
// carries a positive finite allowance — Starter 100, Pro 2,000, AI 1,000 —
// counted against MERGED usage (agent turns + AskBase queries).
// null (enterprise / legacy-grandfathered) never blocks.
function checkAiQueryQuota(orgId) {
  const plan = orgPlan(orgId);
  const limit = limitsForPlan(plan).aiQueriesPerMonth;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return null;
  const { used } = accountMergedAiUsed(orgId);
  return used >= limit ? { plan, limit, used } : null;
}

module.exports = {
  monthStartUtc,
  monthKeyUtc,
  orgPlan,
  claimsUsedThisMonth,
  claimsUsedByWorkspace,
  accountClaimsUsedThisMonth,
  seatsUsed,
  aiQueriesUsedThisMonth,
  agentTurnsThisMonth,
  recordAgentTurn,
  mergedAiQueriesUsed,
  mergedAiUsedByWorkspace,
  accountMergedAiUsed,
  usageForOrg,
  quotaExceeded,
  checkAiQueryQuota,
  checkClaimQuota,
  checkSeatQuota,
};
