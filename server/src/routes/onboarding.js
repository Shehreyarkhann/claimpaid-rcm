const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired } = require('../auth');
const { billingStatusFor } = require('./billing');
const account = require('../account');

const router = express.Router();

const VALID_PLANS = ['starter', 'pro', 'ai'];
const ACCOUNT_PLANS = ['starter', 'pro', 'ai', 'enterprise'];
const TEAM_SIZES = ['Just me', '2–10', '11–50', '51+'];
const ROLES = ['Owner', 'Billing manager', 'Biller', 'Practice admin', 'Other'];
const TRIAL_DAYS = 30;

function getOrg(orgId) {
  return db.prepare('SELECT * FROM orgs WHERE id = ?').get(orgId);
}

// The account's plan-of-record on a SIBLING workspace (deploy #100): when
// the account already chose a plan (a sibling workspace completed onboarding
// or carries the Stripe subscription), a new workspace never picks its own —
// it mirrors the account plan. Returns the sibling org row or null.
function siblingPlanOrg(userId, currentOrgId) {
  const orgIds = account.orgIdsOwnedBy(userId).filter((id) => id !== currentOrgId);
  if (!orgIds.length) return null;
  const planOrg = account.planOfRecordOrg(orgIds);
  if (!planOrg) return null;
  if (!ACCOUNT_PLANS.includes(planOrg.plan)) return null;
  if (!planOrg.onboarding_completed_at && !planOrg.stripe_subscription_id) return null;
  return planOrg;
}

// ---- GET /api/onboarding/status — does this owner still need the funnel? ----
router.get('/status', authRequired, (req, res) => {
  // Org-less account (workspace deleted / fresh database): the funnel starts
  // with workspace creation, handled by the client's create-workspace gate.
  if (req.noOrg) return res.json({ needed: true, noOrg: true, orgName: '', plan: null, accountPlan: null });
  const org = getOrg(req.orgId);
  if (!org) return res.json({ needed: false, orgName: '', plan: null, accountPlan: null });
  // Deploy #100: when the account already has a plan, the wizard shows a
  // read-only plan line instead of a picker (client renders from this).
  let accountPlan = null;
  if (req.user.role === 'owner') {
    const sib = siblingPlanOrg(req.user.id, org.id);
    if (sib) {
      accountPlan = {
        plan: sib.plan,
        plan_status: sib.plan_status,
        trial_ends_at: sib.trial_ends_at,
        workspaces: account.workspaceUsage(req.user.id, sib.plan),
      };
    }
  }
  res.json({
    needed: req.user.role === 'owner' && !org.onboarding_completed_at,
    orgName: org.name || '',
    plan: VALID_PLANS.includes(org.plan) ? org.plan : null,
    accountPlan,
  });
});

// ---- POST /api/onboarding/complete — first run picks the account plan once;
// later workspaces mirror it (deploy #100) ----
router.post('/complete', authRequired, roleRequired('owner'), (req, res) => {
  const { companyName, teamSize, role, goals, plan } = req.body || {};
  const org = getOrg(req.orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  // Idempotent-safe: completing twice never resets or extends the trial clock.
  if (org.onboarding_completed_at) {
    return res.json({ already_completed: true, ...billingStatusFor(getOrg(req.orgId)) });
  }

  // Deploy #100 mirror mode: the account already has a plan on a sibling
  // workspace — the submitted plan (if any) is IGNORED and the account plan,
  // status and trial window are mirrored onto this workspace. There is no
  // path where a workspace gets a separate plan.
  const sib = siblingPlanOrg(req.user.id, org.id);

  const now = new Date();
  // ONE trial per user, ever (deploy #61): the 30-day window lives on the
  // owner's account. A first onboarding starts it; every later workspace
  // (plan switches included) mirrors the SAME window — and once it's over,
  // new workspaces start expired, headed straight for checkout with no
  // trial days. Deleting a workspace can never mint a fresh trial.
  const owner = db.prepare('SELECT trial_started_at, trial_ends_at FROM users WHERE id = ?').get(req.user.id);
  let trialStarted = owner?.trial_started_at || null;
  let trialEnds = owner?.trial_ends_at || null;

  let effectivePlan;
  let effectiveStatus;
  if (sib) {
    effectivePlan = sib.plan;
    effectiveStatus = sib.plan_status || 'trialing';
    // Mirror the account window: the user's window is canonical; fall back
    // to the sibling's mirrored copy. Never mint a fresh window here.
    if (!trialEnds) {
      trialStarted = sib.trial_started_at || null;
      trialEnds = sib.trial_ends_at || null;
    }
  } else {
    if (!VALID_PLANS.includes(plan)) {
      return res.status(400).json({ error: 'Please choose a plan: starter, pro, or ai.' });
    }
    effectivePlan = plan;
    effectiveStatus = 'trialing';
    if (!trialEnds) {
      trialStarted = now.toISOString();
      trialEnds = new Date(now.getTime() + TRIAL_DAYS * 86400000).toISOString();
      db.prepare('UPDATE users SET trial_started_at = ?, trial_ends_at = ? WHERE id = ?')
        .run(trialStarted, trialEnds, req.user.id);
    }
  }

  const data = JSON.stringify({
    teamSize: TEAM_SIZES.includes(teamSize) ? teamSize : null,
    role: ROLES.includes(role) ? role : null,
    goals: Array.isArray(goals) ? goals.filter((g) => typeof g === 'string').slice(0, 12) : [],
    completed_via: 'wizard',
  });
  const name =
    typeof companyName === 'string' && companyName.trim()
      ? companyName.trim().slice(0, 120)
      : org.name;

  db.prepare(
    `UPDATE orgs SET name = ?, plan = ?, plan_status = ?,
      trial_started_at = ?, trial_ends_at = ?,
      onboarding_data = ?, onboarding_completed_at = ?
     WHERE id = ?`
  ).run(name, effectivePlan, effectiveStatus, trialStarted, trialEnds, data, now.toISOString(), org.id);

  // Keep every sibling workspace on the same account plan + window, so
  // per-org readers (tokens, product gates, AskBase) never see drift.
  account.propagatePlanFields(org.id, {
    plan: effectivePlan, plan_status: effectiveStatus,
    trial_started_at: trialStarted, trial_ends_at: trialEnds,
  });

  res.status(201).json(billingStatusFor(getOrg(req.orgId)));
});

module.exports = router;
