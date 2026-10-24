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

// Full usage snapshot for an org (powers the Billing usage bars and the 80%
// warning banner). Never throws — a counter that can't be read reports unknown.
function usageForOrg(orgId) {
  const plan = orgPlan(orgId);
  const limits = limitsForPlan(plan);
  const claimsUsed = claimsUsedThisMonth(orgId);
  const seatsUsedCount = seatsUsed(orgId);
  const ai = aiQueriesUsedThisMonth(orgId);

  const claims = { used: claimsUsed, limit: limits.claimsPerMonth, pct: usagePct(claimsUsed, limits.claimsPerMonth) };
  const seats = { used: seatsUsedCount, limit: limits.seats, pct: usagePct(seatsUsedCount, limits.seats) };
  const aiQueries = {
    used: ai.used, limit: limits.aiQueriesPerMonth,
    pct: ai.unknown ? null : usagePct(ai.used, limits.aiQueriesPerMonth),
    unknown: ai.unknown,
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
  const noun = kind === 'claim_limit_reached' ? 'claims' : 'team seats';
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

module.exports = {
  monthStartUtc,
  monthKeyUtc,
  orgPlan,
  claimsUsedThisMonth,
  seatsUsed,
  aiQueriesUsedThisMonth,
  usageForOrg,
  checkClaimQuota,
  checkSeatQuota,
};
