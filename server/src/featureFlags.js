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

module.exports = { statementPaymentsHeld, FEATURE_HELD_BODY };
