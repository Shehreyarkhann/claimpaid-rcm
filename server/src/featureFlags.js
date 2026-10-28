'use strict';
// Feature flags — single source of truth for server-side feature state.
// Read at REQUEST time (never cached at boot) so an env change + restart
// is enough to flip state.

// ---------------------------------------------------------------------------
// STATEMENT PAYMENTS HOLD (founder decision, 2026-10-27): Stripe Connect
// onboarding and statement pay links are fully built but ship DORMANT.
// While held, the feature cannot be activated:
//   - POST /api/statements/:id/payment-link      -> 403 FEATURE_HELD
//   - POST /api/settings/payments/connect        -> 403 FEATURE_HELD
//   - POST /api/settings/payments/disconnect     -> 403 FEATURE_HELD
//   - GET  /api/settings/payments still answers and reports `held: true`,
//     and the client renders every control disabled from that server truth.
// The Connect code is NOT removed — it sits behind this one flag.
//
// RE-ENABLE (either path, then restart/redeploy):
//   1. Set env STATEMENT_PAYMENTS_HELD=0 (or 'false') on the server. This
//      lifts the hold with no code change; or
//   2. Flip the default in statementPaymentsHeld() below to return false
//      and deploy.
// Anything other than an explicit '0'/'false' keeps the hold — including
// the variable being unset (the shipped state).
// ---------------------------------------------------------------------------
function statementPaymentsHeld() {
  const v = String(process.env.STATEMENT_PAYMENTS_HELD || '').trim().toLowerCase();
  if (v === '0' || v === 'false') return false;
  return true;
}

// The one 403 body every held endpoint returns (identical shape everywhere).
const FEATURE_HELD_BODY = Object.freeze({
  code: 'FEATURE_HELD',
  error: 'Patient payment links are currently restricted.',
});

// ---------------------------------------------------------------------------
// IN-APP AGENT (Phase 1, dark-shipped): the OpenDuet-pattern agent (panel +
// tools + human-approval actions) exists in code but is OFF unless BOTH:
//   - AGENT_ENABLED=1 (or 'true'), AND
//   - a model provider key is configured: AGENT_API_KEY or ANTHROPIC_API_KEY
//     (env only — see server/src/agent/model.js for the provider config
//     surface, incl. the OpenAI-compatible AGENT_BASE_URL mode).
// While off, every /api/agent/* endpoint answers 403 AGENT_DISABLED and the
// client renders a clean "not enabled" state. Read at request time like the
// hold above: env change + restart flips it, no code change.
// ---------------------------------------------------------------------------
function agentEnabled() {
  const v = String(process.env.AGENT_ENABLED || '').trim().toLowerCase();
  if (v !== '1' && v !== 'true') return false;
  const key = String(process.env.AGENT_API_KEY || process.env.ANTHROPIC_API_KEY || '').trim();
  return key.length > 0;
}

// The one 403 body every disabled agent endpoint returns.
const AGENT_DISABLED_BODY = Object.freeze({
  code: 'AGENT_DISABLED',
  error: 'The ClaimPaid agent is not enabled on this server yet.',
});

module.exports = { statementPaymentsHeld, FEATURE_HELD_BODY, agentEnabled, AGENT_DISABLED_BODY };
