'use strict';
// Brief precompute (deploy #101) — the morning brief, ready before the
// first click. The brief used to generate LAZILY on first open, so a
// user opening the app at 3 PM got a "morning" brief composed at 3 PM.
// The hourly watchdog sweep now also runs this pass: in each org's local
// 06:00 hour it generates that day's brief for the org's recently active
// users, through the EXACT lazy path (getOrCreateBrief) — same content,
// same UNIQUE-constraint dedupe, same quota degradation (at the account
// AI cap the brief assembles without its narrative call, exactly as the
// lazy path degrades).
//
// Gates mirror the watchdog's: agent disabled -> no-op; plans-only orgs
// skipped; outside the org-local 06:00 hour -> deferred. Attempts are
// deduped per user per org-local day by agent_brief_precompute_log —
// the row is written BEFORE generation (attempt semantics, like the
// digest log), so a failure never retries into a double brief inside
// the same sweep day.
const { db } = require('../db');
const { agentEnabled } = require('../featureFlags');
const { getOrCreateBrief, orgLocalDate } = require('./brief');
const { orgLocalParts } = require('./watchdog');

const PRECOMPUTE_HOUR = 6; // org-local
const ACTIVE_DAYS = 14;

// "Active in the last 14 days" from the signals the product already
// records: a brief was generated for them, they talked to the agent,
// they worked claims (activity log), or their reads hit the audit log.
function activeUsers(orgId) {
  return db.prepare(`
    SELECT DISTINCT u.id, u.email, u.name, uo.role
    FROM user_orgs uo JOIN users u ON u.id = uo.user_id
    WHERE uo.org_id = ?
      AND (
        EXISTS (SELECT 1 FROM agent_briefs b WHERE b.org_id = uo.org_id AND b.user_id = u.id
                  AND b.created_at >= datetime('now', '-${ACTIVE_DAYS} days'))
        OR EXISTS (SELECT 1 FROM agent_conversations cv WHERE cv.org_id = uo.org_id AND cv.user_id = u.id
                  AND cv.updated_at >= datetime('now', '-${ACTIVE_DAYS} days'))
        OR EXISTS (SELECT 1 FROM claim_activity ca WHERE ca.org_id = uo.org_id AND ca.user_id = u.id
                  AND ca.created_at >= datetime('now', '-${ACTIVE_DAYS} days'))
        OR EXISTS (SELECT 1 FROM audit_log al WHERE al.org_id = uo.org_id AND al.user_id = u.id
                  AND al.created_at >= datetime('now', '-${ACTIVE_DAYS} days'))
      )
  `).all(orgId);
}

async function runBriefPrecompute(now = new Date()) {
  const summary = { generated: 0, skipped: 0, orgs: 0 };
  if (!agentEnabled()) return { ...summary, skipped_reason: 'agent_disabled' };
  const { productsForOrg } = require('../routes/billing'); // lazy: Stripe stack cycle guard (watchdog pattern)

  const orgs = db.prepare('SELECT * FROM orgs').all();
  for (const org of orgs) {
    try {
      const products = productsForOrg(org);
      if (!products.rcm) continue; // the brief is an RCM-agent surface
      const { date, hour } = orgLocalParts(org.timezone, now);
      if (hour !== PRECOMPUTE_HOUR) continue;
      summary.orgs++;
      for (const user of activeUsers(org.id)) {
        const already = db.prepare(
          'SELECT id FROM agent_brief_precompute_log WHERE org_id = ? AND user_id = ? AND brief_date = ?'
        ).get(org.id, user.id, date);
        if (already) { summary.skipped++; continue; }
        // Existing brief (lazy path beat us to it) — record and move on.
        const existing = db.prepare(
          'SELECT id FROM agent_briefs WHERE org_id = ? AND user_id = ? AND brief_date = ?'
        ).get(org.id, user.id, date);
        if (existing) {
          db.prepare('INSERT OR IGNORE INTO agent_brief_precompute_log (org_id, user_id, brief_date, status) VALUES (?, ?, ?, ?)')
            .run(org.id, user.id, date, 'already_present');
          summary.skipped++;
          continue;
        }
        try {
          db.prepare('INSERT INTO agent_brief_precompute_log (org_id, user_id, brief_date, status) VALUES (?, ?, ?, ?)')
            .run(org.id, user.id, date, 'attempted');
        } catch { summary.skipped++; continue; } // UNIQUE race — the other attempt owns it
        try {
          await getOrCreateBrief({ orgId: org.id, user, isSuperAdmin: false });
          db.prepare("UPDATE agent_brief_precompute_log SET status = 'generated' WHERE org_id = ? AND user_id = ? AND brief_date = ?")
            .run(org.id, user.id, date);
          summary.generated++;
        } catch (e) {
          db.prepare("UPDATE agent_brief_precompute_log SET status = 'failed' WHERE org_id = ? AND user_id = ? AND brief_date = ?")
            .run(org.id, user.id, date);
          console.error(`[brief-precompute] org ${org.id} user ${user.id} failed: ${e.message}`);
        }
      }
    } catch (e) {
      console.error(`[brief-precompute] org ${org.id} failed: ${e.message}`);
    }
  }
  try {
    db.prepare(`
      INSERT INTO agent_scheduler_log (job, last_run_at, detail) VALUES ('brief_precompute', datetime('now'), ?)
      ON CONFLICT(job) DO UPDATE SET last_run_at = excluded.last_run_at, detail = excluded.detail
    `).run(JSON.stringify(summary));
  } catch { /* best-effort stamp */ }
  return summary;
}

module.exports = { runBriefPrecompute, activeUsers, PRECOMPUTE_HOUR, orgLocalDate };
