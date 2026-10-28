'use strict';
// Manager's agent (Phase 5, WS3) — team oversight computed entirely from
// data the product already keeps: the worklist engine (same 'mine'
// scope the teammate sees), appeals follow-ups and outcomes, and the
// agent's own approval ledger. No model, no estimates: every number here
// can be re-derived from the rows behind it. Owner-gated at the route.
const { db } = require('../db');
const { computeWorklist } = require('../worklistCore');
const { FILING_SELECT, FILING_JOIN } = require('../routes/filing');

function computeTeamInsights(orgId) {
  const members = db.prepare(`
    SELECT u.id, u.name, u.email, uo.role FROM user_orgs uo
    JOIN users u ON u.id = uo.user_id
    WHERE uo.org_id = ? ORDER BY u.name
  `).all(orgId);

  const users = members.map((u) => {
    const worklist = computeWorklist(orgId, u.id, 'mine');
    const overdue = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(c.billed_amount - c.paid_amount), 0) AS amount
      FROM appeals a JOIN claims c ON c.id = a.claim_id
      WHERE a.org_id = ? AND a.assigned_to = ? AND a.follow_up_date IS NOT NULL
        AND a.follow_up_date < date('now') AND a.status NOT IN ('won', 'lost')
    `).get(orgId, u.id);
    // Proposals this user generated that still await a decision-maker.
    const pendingApprovals = db.prepare(`
      SELECT COUNT(*) AS n FROM agent_actions
      WHERE org_id = ? AND user_id = ? AND status = 'pending'
    `).get(orgId, u.id).n;
    const decided = db.prepare(`
      SELECT COUNT(*) AS decided,
        COALESCE(SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END), 0) AS won
      FROM appeals WHERE org_id = ? AND assigned_to = ? AND status IN ('won', 'lost')
    `).get(orgId, u.id);
    const drafts = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN status = 'executed' THEN 1 ELSE 0 END), 0) AS approved,
        COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected
      FROM agent_actions WHERE org_id = ? AND user_id = ? AND kind = 'draft_appeal'
    `).get(orgId, u.id);
    return {
      user_id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      open_worklist_items: worklist.summary.total,
      overdue_followups: overdue.n,
      overdue_amount: Math.round(overdue.amount * 100) / 100,
      pending_approvals: pendingApprovals,
      appeals_decided: decided.decided,
      appeals_won: decided.won,
      win_rate: decided.decided > 0 ? Math.round((decided.won / decided.decided) * 100) / 100 : null,
      agent_drafts_approved: drafts.approved,
      agent_drafts_rejected: drafts.rejected,
    };
  });

  // Stalled: still open, untouched for 7+ days, and no timeline activity
  // in that window either — the claims nobody is looking at.
  const stalled = db.prepare(`
    SELECT c.id AS claim_id, c.claim_number, c.patient_name, p.name AS payer, c.status,
      round(c.billed_amount - c.paid_amount, 2) AS balance,
      CAST(julianday('now') - julianday(COALESCE(c.last_touched_at, c.created_at)) AS INTEGER) AS idle_days,
      (SELECT a.assigned_to FROM appeals a
        WHERE a.claim_id = c.id AND a.org_id = c.org_id AND a.status NOT IN ('won', 'lost')
        ORDER BY a.id DESC LIMIT 1) AS owner_id,
      (SELECT u.name FROM appeals a JOIN users u ON u.id = a.assigned_to
        WHERE a.claim_id = c.id AND a.org_id = c.org_id AND a.status NOT IN ('won', 'lost')
        ORDER BY a.id DESC LIMIT 1) AS owner_name
    FROM claims c JOIN payers p ON p.id = c.payer_id
    WHERE c.org_id = ? AND c.status IN ('pending', 'in_ar', 'denied')
      AND COALESCE(c.last_touched_at, c.created_at) < datetime('now', '-7 days')
      AND NOT EXISTS (
        SELECT 1 FROM claim_activity ca WHERE ca.claim_id = c.id AND ca.created_at >= datetime('now', '-7 days')
      )
    ORDER BY balance DESC LIMIT 25
  `).all(orgId);

  // Reassignment suggestions: filing-risk claims (deadline within 14
  // days, or already past) whose open appeal sits with the most
  // overdue-loaded teammate, offered to the lightest-loaded one — only
  // while a move strictly reduces the imbalance (after the move the
  // target still carries less than the source did). Deterministic ties:
  // lowest user id.
  const suggestions = [];
  if (users.length >= 2) {
    const loads = new Map(users.map((u) => [u.user_id, u.overdue_followups]));
    const byLoadDesc = [...users].sort((a, b) => (loads.get(b.user_id) - loads.get(a.user_id)) || (a.user_id - b.user_id));
    const source = byLoadDesc[0];
    if (source && loads.get(source.user_id) > 0) {
      const riskClaims = db.prepare(`
        SELECT * FROM (
          SELECT c.id AS claim_id, c.claim_number,
            round(c.billed_amount - c.paid_amount, 2) AS balance,
            ${FILING_SELECT}
          FROM claims c ${FILING_JOIN}
          JOIN appeals a ON a.claim_id = c.id AND a.org_id = c.org_id AND a.status NOT IN ('won', 'lost')
          WHERE c.org_id = ? AND a.assigned_to = ? AND c.status IN ('pending', 'in_ar', 'denied')
        ) WHERE days_until_filing <= 14
        ORDER BY days_until_filing ASC, balance DESC
      `).all(orgId, source.user_id);
      const effLoad = new Map(loads);
      for (const claim of riskClaims) {
        const targets = users.filter((u) => u.user_id !== source.user_id)
          .sort((a, b) => (effLoad.get(a.user_id) - effLoad.get(b.user_id)) || (a.user_id - b.user_id));
        const target = targets[0];
        if (!target) break;
        if (effLoad.get(target.user_id) + 1 < effLoad.get(source.user_id)) {
          suggestions.push({
            claim_id: claim.claim_id,
            claim_number: claim.claim_number,
            balance: claim.balance,
            days_left: claim.days_until_filing,
            from_user_id: source.user_id,
            from_name: source.name,
            to_user_id: target.user_id,
            to_name: target.name,
            reason: `${source.name} carries ${loads.get(source.user_id)} overdue follow-up${loads.get(source.user_id) === 1 ? '' : 's'}; ${target.name} carries ${effLoad.get(target.user_id)}. Claim ${claim.claim_number} hits its filing deadline in ${claim.days_until_filing} day${claim.days_until_filing === 1 ? '' : 's'}.`,
          });
          effLoad.set(source.user_id, effLoad.get(source.user_id) - 1);
          effLoad.set(target.user_id, effLoad.get(target.user_id) + 1);
        }
      }
    }
  }

  return { users, stalled, suggestions };
}

module.exports = { computeTeamInsights };
