'use strict';
// Appeal-outcome reconciliation (agent Phase 3, WS5) — the loop that
// makes the agent smarter from the org's own decided work.
//
// For every EXECUTED draft_appeal action, follow its appeal to the
// outcome: appeal 'won' -> overturned; appeal 'lost' -> not overturned;
// appeal still open but the claim reached 'paid' with money collected ->
// overturned (recovered after the appeal); anything else is still open
// and excluded. Results aggregate into agent_outcome_stats by payer +
// denial reason, which predict.js reads for overturn likelihood.
//
// Idempotent by construction: the org's stats are rebuilt wholesale from
// the action/appeal/claim rows, so re-running changes nothing. Runs at
// most once per org per day (agent_reconcile_log), invoked from the
// morning-brief generation — the same lazy, no-cron pattern.
const { db } = require('../db');

function reconcileOutcomes(orgId, { force = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  if (!force) {
    const log = db.prepare('SELECT last_run_date FROM agent_reconcile_log WHERE org_id = ?').get(orgId);
    if (log && log.last_run_date === today) return { skipped: true, decided: 0, overturned: 0 };
  }
  const rows = db.prepare(`
    SELECT ap.status AS appeal_status, c.status AS claim_status, c.paid_amount,
           c.payer_id, COALESCE(NULLIF(TRIM(c.denial_reason), ''), 'Unspecified') AS denial_reason
    FROM agent_actions a
    JOIN appeals ap ON ap.id = CAST(json_extract(a.result, '$.appeal_id') AS INTEGER)
    JOIN claims c ON c.id = ap.claim_id
    WHERE a.org_id = ? AND a.kind = 'draft_appeal' AND a.status = 'executed' AND a.result IS NOT NULL
  `).all(orgId);

  const agg = new Map(); // `${payer_id}|${reason}` -> { payer_id, denial_reason, appeals, overturned }
  let decided = 0;
  let overturnedTotal = 0;
  for (const r of rows) {
    let overturned = null;
    if (r.appeal_status === 'won') overturned = 1;
    else if (r.appeal_status === 'lost') overturned = 0;
    else if (r.claim_status === 'paid' && r.paid_amount > 0) overturned = 1;
    if (overturned === null) continue; // still open — not training data yet
    decided++;
    overturnedTotal += overturned;
    const key = `${r.payer_id}|${r.denial_reason}`;
    const cur = agg.get(key) || { payer_id: r.payer_id, denial_reason: r.denial_reason, appeals: 0, overturned: 0 };
    cur.appeals++;
    cur.overturned += overturned;
    agg.set(key, cur);
  }

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM agent_outcome_stats WHERE org_id = ?').run(orgId);
    const ins = db.prepare(`
      INSERT INTO agent_outcome_stats (org_id, payer_id, denial_reason, appeals, overturned, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `);
    for (const s of agg.values()) ins.run(orgId, s.payer_id, s.denial_reason, s.appeals, s.overturned);
    db.prepare(`
      INSERT INTO agent_reconcile_log (org_id, last_run_date) VALUES (?, ?)
      ON CONFLICT(org_id) DO UPDATE SET last_run_date = excluded.last_run_date
    `).run(orgId, today);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { skipped: false, decided, overturned: overturnedTotal };
}

module.exports = { reconcileOutcomes };
