// Plan usage limits — THE single source of truth for plan quotas.
// Consumed by:
//   - server/src/usage.js          (claims/seats counting + 402 enforcement + /api/billing/usage)
//   - server/src/auth.js           (signToken embeds plan+limits into the RCM JWT)
//   - server/src/routes/claims.js  (claim creation / CSV upload quota)
//   - server/src/routes/auth.js    (team invite seat cap)
//   - askbase (loads this file by path, see askbase/server/src/planLimits.js)
//
// Launch numbers (owner-adjustable here — everything else derives from this):
//   Starter    $199/mo : 1,000 claims/month,   3 seats, 100 AI uses/month
//   Pro        $499/mo : 10,000 claims/month, 15 seats, AI w/ 2,000 AI queries/month
//   AI          $99/mo : 1,000 AI queries/month, 5 seats, RCM app not included
//   Enterprise custom : unlimited everything
//
// AI-use policy (founder decision, 2026-10-28): the in-app AGENT is included
// on every RCM plan and draws on the plan's AI-use allowance — Starter gets
// 100 AI uses/month (agent turns + any merged AI usage), then the 402
// upgrade gate fires. The standalone ClaimPaid AI APP is a separate product:
// NOT included on Starter (product-gated in routes/billing.js
// productsForPlan — starter ai:false), included on Pro / AI / Enterprise.
// The agent lives inside the RCM app, so the AI plan (no RCM app) has no
// agent; its 1,000 uses are spent in the AI app.
// Trial orgs get the same limits as their chosen plan (trial inherits plan).
// Legacy orgs with no plan value are grandfathered unlimited — never lock out
// an existing org by accident.
//
// null = unlimited, 0 = not included (feature is blocked by product gating).

const PLAN_LIMITS = {
  starter: {
    price: 199,
    claimsPerMonth: 1000,
    seats: 3,
    aiQueriesPerMonth: 100, // agent included (100 AI uses/mo); the standalone AI app is NOT (product gate)
  },
  pro: {
    price: 499,
    claimsPerMonth: 10000,
    seats: 15,
    aiQueriesPerMonth: 2000,
  },
  ai: {
    price: 99,
    claimsPerMonth: 0, // RCM app not included on the AI plan
    seats: 5,
    aiQueriesPerMonth: 1000,
  },
  enterprise: {
    price: null, // custom
    claimsPerMonth: null,
    seats: null,
    aiQueriesPerMonth: null,
  },
};

// Legacy seat-limits table kept for the settings/API-key workstream.
const PLAN_SEAT_LIMITS = {
  starter: 3,
  pro: 15,
  ai: 5,
  enterprise: null, // null = unlimited
};

// Resolve the limits row for a plan value. Returns a fresh copy.
// null / unknown plan => grandfathered unlimited (never strand a legacy org).
function limitsForPlan(plan) {
  const row = PLAN_LIMITS[plan];
  if (row) return { ...row };
  return { price: null, claimsPerMonth: null, seats: null, aiQueriesPerMonth: null };
}

// Whether a usage figure is at/over a limit (null limit => never).
function atLimit(used, limit) {
  return limit !== null && limit !== undefined && used >= limit;
}

// Fraction of quota consumed; null when unlimited or unknown.
function usagePct(used, limit) {
  if (limit === null || limit === undefined || limit <= 0) return null;
  return Math.min(1, used / limit);
}

// Returns the seat limit for a plan, or null for unlimited.
function seatLimitForPlan(plan) {
  if (Object.prototype.hasOwnProperty.call(PLAN_SEAT_LIMITS, plan)) {
    return PLAN_SEAT_LIMITS[plan];
  }
  return PLAN_SEAT_LIMITS.starter; // trial / null / unknown → Starter limits
}

// { used, limit, plan, atCap } for an org id.
function seatUsage(db, orgId) {
  const used = db.prepare('SELECT COUNT(*) AS c FROM user_orgs WHERE org_id = ?').get(orgId).c;
  const org = db.prepare('SELECT plan FROM orgs WHERE id = ?').get(orgId);
  const limit = seatLimitForPlan(org && org.plan);
  return { used, limit, plan: (org && org.plan) || 'trial', atCap: limit !== null && used >= limit };
}

module.exports = {
  PLAN_LIMITS,
  limitsForPlan,
  atLimit,
  usagePct,
  PLAN_SEAT_LIMITS,
  seatLimitForPlan,
  seatUsage,
};
