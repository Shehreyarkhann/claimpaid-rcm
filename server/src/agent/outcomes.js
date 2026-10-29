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
// Phase 4 (WS1): the aggregate gains the ANGLE dimension — the letter
// category the appeal argued, read from the action payload (actions
// created before payloads carried a category fall back to the category
// the letter engine derived from the denial reason, which is what those
// letters in fact argued). predict.js can then ask which angle wins for
// a payer + reason pair, and draft_appeal can argue that angle next time.
//
// Idempotent by construction: the org's stats are rebuilt wholesale from
// the action/appeal/claim rows, so re-running changes nothing. Runs at
// most once per org per day (agent_reconcile_log), invoked from the
// morning-brief generation — the same lazy, no-cron pattern.
const { db } = require('../db');
const { categorizeReason } = require('../appealLetters');

function reconcileOutcomes(orgId, { force = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  if (!force) {
    const log = db.prepare('SELECT last_run_date FROM agent_reconcile_log WHERE org_id = ?').get(orgId);
    if (log && log.last_run_date === today) return { skipped: true, decided: 0, overturned: 0 };
  }
  const rows = db.prepare(`
    SELECT ap.status AS appeal_status, ap.outcome AS appeal_outcome,
           c.status AS claim_status, c.paid_amount,
           c.payer_id, COALESCE(NULLIF(TRIM(c.denial_reason), ''), 'Unspecified') AS denial_reason,
           json_extract(a.payload, '$.category') AS payload_angle
    FROM agent_actions a
    JOIN appeals ap ON ap.id = CAST(json_extract(a.result, '$.appeal_id') AS INTEGER)
    JOIN claims c ON c.id = ap.claim_id
    WHERE a.org_id = ? AND a.kind = 'draft_appeal' AND a.status = 'executed' AND a.result IS NOT NULL
  `).all(orgId);

  const agg = new Map(); // `${payer_id}|${reason}|${angle}` -> { payer_id, denial_reason, angle, appeals, overturned }
  let decided = 0;
  let overturnedTotal = 0;
  for (const r of rows) {
    // Deploy #101: the ERA feedback loop records outcomes on the appeal
    // (won / partial / re_denied) as payer answers arrive — they are
    // decided cases exactly like a manual won/lost. A partial payment
    // counts as a half-overturn: the payer moved, but not in full.
    let overturned = null;
    if (r.appeal_status === 'won') overturned = 1;
    else if (r.appeal_status === 'lost') overturned = 0;
    else if (r.appeal_outcome === 'won') overturned = 1;
    else if (r.appeal_outcome === 'partial') overturned = 0.5;
    else if (r.appeal_outcome === 're_denied') overturned = 0;
    else if (r.claim_status === 'paid' && r.paid_amount > 0) overturned = 1;
    if (overturned === null) continue; // still open — not training data yet
    decided++;
    overturnedTotal += overturned;
    const angle = r.payload_angle || categorizeReason(r.denial_reason);
    const key = `${r.payer_id}|${r.denial_reason}|${angle}`;
    const cur = agg.get(key) || { payer_id: r.payer_id, denial_reason: r.denial_reason, angle, appeals: 0, overturned: 0 };
    cur.appeals++;
    cur.overturned += overturned;
    agg.set(key, cur);
  }

  // Deploy #101: the ERA feedback loop calls this from INSIDE the
  // posting transaction — join the caller's transaction when one is
  // already open instead of failing on a nested BEGIN (the rebuild is
  // wholesale + idempotent, so riding the outer commit is safe).
  let ownTx = false;
  try { db.exec('BEGIN'); ownTx = true; } catch { /* already in a transaction */ }
  try {
    db.prepare('DELETE FROM agent_outcome_stats WHERE org_id = ?').run(orgId);
    const ins = db.prepare(`
      INSERT INTO agent_outcome_stats (org_id, payer_id, denial_reason, angle, appeals, overturned, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    for (const s of agg.values()) ins.run(orgId, s.payer_id, s.denial_reason, s.angle, s.appeals, s.overturned);
    db.prepare(`
      INSERT INTO agent_reconcile_log (org_id, last_run_date) VALUES (?, ?)
      ON CONFLICT(org_id) DO UPDATE SET last_run_date = excluded.last_run_date
    `).run(orgId, today);
    if (ownTx) db.exec('COMMIT');
  } catch (e) {
    if (ownTx) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } }
    throw e;
  }
  return { skipped: false, decided, overturned: overturnedTotal };
}

module.exports = { reconcileOutcomes };
