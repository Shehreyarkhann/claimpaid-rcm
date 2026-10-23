const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired } = require('../auth');
const { billingStatusFor } = require('./billing');

const router = express.Router();

const VALID_PLANS = ['starter', 'pro', 'ai'];
const TEAM_SIZES = ['Just me', '2–10', '11–50', '51+'];
const ROLES = ['Owner', 'Billing manager', 'Biller', 'Practice admin', 'Other'];
const TRIAL_DAYS = 30;

function getOrg(orgId) {
  return db.prepare('SELECT * FROM orgs WHERE id = ?').get(orgId);
}

// ---- GET /api/onboarding/status — does this owner still need the funnel? ----
router.get('/status', authRequired, (req, res) => {
  const org = getOrg(req.orgId);
  if (!org) return res.json({ needed: false, orgName: '', plan: null });
  res.json({
    needed: req.user.role === 'owner' && !org.onboarding_completed_at,
    orgName: org.name || '',
    plan: VALID_PLANS.includes(org.plan) ? org.plan : null,
  });
});

// ---- POST /api/onboarding/complete — owner picks a plan, 30-day trial starts ----
router.post('/complete', authRequired, roleRequired('owner'), (req, res) => {
  const { companyName, teamSize, role, goals, plan } = req.body || {};
  if (!VALID_PLANS.includes(plan)) {
    return res.status(400).json({ error: 'Please choose a plan: starter, pro, or ai.' });
  }
  const org = getOrg(req.orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  // Idempotent-safe: completing twice never resets or extends the trial clock.
  if (org.onboarding_completed_at) {
    return res.json({ already_completed: true, ...billingStatusFor(getOrg(req.orgId)) });
  }

  const now = new Date();
  const ends = new Date(now.getTime() + TRIAL_DAYS * 86400000);
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
    `UPDATE orgs SET name = ?, plan = ?, plan_status = 'trialing',
      trial_started_at = ?, trial_ends_at = ?,
      onboarding_data = ?, onboarding_completed_at = ?
     WHERE id = ?`
  ).run(name, plan, now.toISOString(), ends.toISOString(), data, now.toISOString(), org.id);

  res.status(201).json(billingStatusFor(getOrg(req.orgId)));
});

module.exports = router;
