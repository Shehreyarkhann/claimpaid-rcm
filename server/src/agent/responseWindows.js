'use strict';
// Payer response windows (deploy #101) — how long a payer TYPICALLY takes
// to answer a submitted appeal, in days. This drives follow-up defaults,
// the Awaiting-payer board, and payer-silence escalation: the workflow
// runs on payer-response expectations instead of a flat calendar guess.
//
// Honesty rules:
//   * The figure is a TYPICAL window, labeled as such everywhere it is
//     shown — it is not a payer commitment and not measured from the
//     org's own outcomes (that would need submitted-appeal history most
//     workspaces do not have yet).
//   * The product default is 30 days for every payer. A workspace can
//     override per payer (payer_filing_rules.response_days, edited on
//     the Filing Rules tab) — that row IS the workspace's payer rule.
const { db } = require('../db');

const DEFAULT_RESPONSE_DAYS = 30;

// Effective window for (org, payer): the workspace's override when set,
// else the default. Returns { days, is_default }.
function responseWindowFor(orgId, payerId) {
  if (payerId == null) return { days: DEFAULT_RESPONSE_DAYS, is_default: true };
  const row = db.prepare(
    'SELECT response_days FROM payer_filing_rules WHERE org_id = ? AND payer_id = ?'
  ).get(orgId, payerId);
  if (row && Number.isInteger(row.response_days) && row.response_days > 0) {
    return { days: row.response_days, is_default: false };
  }
  return { days: DEFAULT_RESPONSE_DAYS, is_default: true };
}

function responseDaysFor(orgId, payerId) {
  return responseWindowFor(orgId, payerId).days;
}

// 'YYYY-MM-DD' + n days -> 'YYYY-MM-DD' (UTC date math, like the rest of
// the codebase's date handling).
function addDays(dateStr, n) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Whole days between a stored timestamp ('YYYY-MM-DD HH:MM:SS' UTC or a
// date) and now. Negative when the timestamp is in the future.
function daysSince(ts, now = new Date()) {
  if (!ts) return null;
  const then = new Date(String(ts).replace(' ', 'T') + (String(ts).includes('T') ? '' : 'Z'));
  if (Number.isNaN(then.getTime())) return null;
  return Math.floor((now.getTime() - then.getTime()) / 86400000);
}

module.exports = { DEFAULT_RESPONSE_DAYS, responseWindowFor, responseDaysFor, addDays, daysSince };
