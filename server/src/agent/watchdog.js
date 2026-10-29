'use strict';
// Watchdog digest (agent Phase 4, WS2) — the morning brief, pushed.
//
// The brief waits to be opened; the watchdog goes and gets the biller.
// An hourly in-process sweep (started in index.js on the EHR auto-pull
// pattern) calls runDigestOnce, which does all the real gating itself:
//
//   * agent disabled globally            -> whole sweep is a no-op
//   * plans-only orgs (no product access)-> skipped entirely
//   * outside the org-local 6–10am window-> deferred to the next sweep
//   * a user with NOTHING actionable     -> no email, no log row (a later
//     sweep inside the window can still pick them up if work lands)
//   * one email per user per org-local day, deduped by agent_digest_log —
//     the row is written when a send is ATTEMPTED and records its status
//     ('sent' | 'failed'), so a failed send is visible, never silent, and
//     never retried into a duplicate.
//
// Items are computed from the same tables the product reads (pending
// agent_actions, appeal follow-ups, the deterministic filing computation,
// the ERA exception backlog) — no parallel math. The identical item set
// backs GET /api/agent/alerts for the Agent page strip, which never sends.
const { db } = require('../db');
const { agentEnabled } = require('../featureFlags');
const { FILING_SELECT, FILING_JOIN } = require('../routes/filing');
const { orgLocalDate } = require('./brief');
const { actionTitle } = require('./actions');
const { responseDaysFor, daysSince } = require('./responseWindows');
const predict = require('./predict');
const email = require('../email'); // module object: sendEmail is read at call time (test-stubbable)

function stampScheduler(job, detail) {
  try {
    db.prepare(`
      INSERT INTO agent_scheduler_log (job, last_run_at, detail) VALUES (?, datetime('now'), ?)
      ON CONFLICT(job) DO UPDATE SET last_run_at = excluded.last_run_at, detail = excluded.detail
    `).run(job, detail || null);
  } catch { /* pre-#101 DB before first boot migration — stamping is best-effort */ }
}

const WINDOW_START_HOUR = 6; // org-local, inclusive
const WINDOW_END_HOUR = 10;  // org-local, exclusive

function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function orgLocalParts(timezone, now) {
  const date = orgLocalDate(timezone, now);
  let hour = now.getUTCHours();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'America/New_York', hour: 'numeric', hourCycle: 'h23',
    }).formatToParts(now);
    const h = parts.find((p) => p.type === 'hour');
    if (h) hour = parseInt(h.value, 10) % 24;
  } catch { /* fall back to the UTC hour */ }
  return { date, hour };
}

// Org-level items every member shares (the ERA exception backlog).
// Highlights (deploy #97): the top held lines keyed by line + remittance,
// with the matched claim id when the line matched one — added for the
// Agent page's expandable alerts panel. The digest email reads only
// count + amount for this category, so the addition changes no email.
function sharedOrgItems(orgId) {
  const backlog = predict.insights(orgId).exception_backlog;
  const highlights = db.prepare(`
    SELECT id AS era_line_id, era_id AS remittance_id, match_claim_id AS claim_id,
           clp_ref AS claim_number, billed
    FROM era_claim_lines
    WHERE org_id = ? AND post_status = 'pending' AND flags IS NOT NULL AND flags != '[]'
    ORDER BY billed DESC LIMIT 3
  `).all(orgId).map((r) => ({
    era_line_id: r.era_line_id,
    remittance_id: r.remittance_id,
    claim_id: r.claim_id != null ? r.claim_id : null,
    claim_number: r.claim_number,
    amount: money(r.billed),
  }));
  return { era_exceptions: { count: backlog.count, amount: money(backlog.amount), highlights } };
}

// The per-user actionable set. Owners see org-wide filing risk (the team
// queue is theirs); everyone else sees filing risk only on claims whose
// open appeal is assigned to them — the same assignment semantics as
// worklist scope 'mine'.
function computeDigestItems(org, user, shared) {
  const orgId = org.id;
  const today = orgLocalDate(org.timezone);

  const pendingRows = db.prepare(`
    SELECT * FROM agent_actions WHERE org_id = ? AND user_id = ? AND status = 'pending'
    ORDER BY created_at ASC
  `).all(orgId, user.id);
  const pending = {
    count: pendingRows.length,
    highlights: pendingRows.slice(0, 3).map((r) => actionTitle(r)),
  };

  const followRows = db.prepare(`
    SELECT c.claim_number, a.follow_up_date, c.id AS claim_id, a.id AS appeal_id FROM appeals a JOIN claims c ON c.id = a.claim_id
    WHERE a.org_id = ? AND a.assigned_to = ? AND a.status NOT IN ('won', 'lost')
      AND a.follow_up_date IS NOT NULL AND a.follow_up_date < ?
    ORDER BY a.follow_up_date ASC
  `).all(orgId, user.id, today);
  const followups = {
    count: followRows.length,
    highlights: followRows.slice(0, 3).map((r) => ({
      claim_number: r.claim_number, due: r.follow_up_date, claim_id: r.claim_id, appeal_id: r.appeal_id,
    })),
  };

  const assignedClause = user.role === 'owner'
    ? ''
    : `AND EXISTS (SELECT 1 FROM appeals am WHERE am.claim_id = c.id AND am.org_id = c.org_id
        AND am.status NOT IN ('won', 'lost') AND am.assigned_to = ${Number(user.id)})`;
  const filingRows = db.prepare(`
    SELECT c.claim_number, (c.billed_amount - c.paid_amount) AS at_stake, c.id AS claim_id, c.status AS claim_status, ${FILING_SELECT}
    FROM claims c ${FILING_JOIN}
    WHERE c.org_id = ? AND c.status IN ('pending', 'in_ar', 'denied') ${assignedClause}
  `).all(orgId)
    .filter((r) => r.days_until_filing != null && r.days_until_filing <= 14)
    .sort((a, b) => a.days_until_filing - b.days_until_filing);
  const filing = {
    count: filingRows.length,
    amount: money(filingRows.reduce((s, r) => s + (r.at_stake || 0), 0)),
    highlights: filingRows.slice(0, 3).map((r) => ({
      claim_number: r.claim_number, days_left: r.days_until_filing, amount: money(r.at_stake),
      claim_id: r.claim_id, status: r.claim_status,
    })),
  };

  // Payer silence (deploy #101): appeals this user submitted whose payer
  // has not answered inside the payer's typical response window — no ERA
  // line posted for the claim since submission. Status-driven, not
  // calendar-driven: the follow-up date no longer decides this, the
  // payer's silence does.
  const submittedRows = db.prepare(`
    SELECT a.id AS appeal_id, a.submitted_at, a.submitted_via, a.follow_up_date,
           c.id AS claim_id, c.claim_number, c.payer_id
    FROM appeals a JOIN claims c ON c.id = a.claim_id
    WHERE a.org_id = ? AND a.assigned_to = ? AND a.status = 'submitted' AND a.submitted_at IS NOT NULL
    ORDER BY a.submitted_at ASC
  `).all(orgId, user.id);
  const silentRows = [];
  for (const r of submittedRows) {
    const waiting = daysSince(r.submitted_at);
    const window = responseDaysFor(orgId, r.payer_id);
    if (waiting == null || waiting <= window) continue;
    const moved = db.prepare(`
      SELECT id FROM era_claim_lines
      WHERE org_id = ? AND match_claim_id = ? AND post_status = 'posted' AND posted_at > ?
      LIMIT 1
    `).get(orgId, r.claim_id, r.submitted_at);
    if (moved) continue;
    silentRows.push({ ...r, days_waiting: waiting, response_days: window });
  }
  const payerSilent = {
    count: silentRows.length,
    highlights: silentRows.slice(0, 3).map((r) => ({
      claim_number: r.claim_number, claim_id: r.claim_id, appeal_id: r.appeal_id,
      days_waiting: r.days_waiting, response_days: r.response_days, via: r.submitted_via,
    })),
  };

  // Re-denied appeals (deploy #101): the ERA feedback loop reopened
  // these when the payer denied again — each is a response draft waiting
  // to be written. Clears from the list once the claim leaves 'denied'
  // or a newer outcome lands.
  const redeniedRows = db.prepare(`
    SELECT c.claim_number, c.id AS claim_id, a.id AS appeal_id, a.outcome_at
    FROM appeals a JOIN claims c ON c.id = a.claim_id
    WHERE a.org_id = ? AND a.assigned_to = ? AND a.outcome = 're_denied' AND a.status = 'open'
      AND c.status = 'denied'
    ORDER BY a.outcome_at DESC
  `).all(orgId, user.id);
  const redenied = {
    count: redeniedRows.length,
    highlights: redeniedRows.slice(0, 3).map((r) => ({
      claim_number: r.claim_number, claim_id: r.claim_id, appeal_id: r.appeal_id,
    })),
  };

  const exceptions = shared ? shared.era_exceptions : sharedOrgItems(orgId).era_exceptions;
  const total = pending.count + followups.count + filing.count + exceptions.count
    + payerSilent.count + redenied.count;
  return {
    pending_approvals: pending, followups_overdue: followups, filing_risk: filing,
    era_exceptions: exceptions, payer_silent: payerSilent, re_denied: redenied, total,
  };
}

function subjectFor(items) {
  const parts = [];
  if (items.pending_approvals.count) parts.push(`${items.pending_approvals.count} approval${items.pending_approvals.count === 1 ? '' : 's'} waiting`);
  if (items.filing_risk.count) parts.push(`$${items.filing_risk.amount.toLocaleString('en-US')} at filing risk`);
  if (items.followups_overdue.count) parts.push(`${items.followups_overdue.count} follow-up${items.followups_overdue.count === 1 ? '' : 's'} overdue`);
  if (items.era_exceptions.count) parts.push(`${items.era_exceptions.count} ERA exception${items.era_exceptions.count === 1 ? '' : 's'} on hold`);
  if (items.re_denied && items.re_denied.count) parts.push(`${items.re_denied.count} appeal${items.re_denied.count === 1 ? '' : 's'} re-denied`);
  if (items.payer_silent && items.payer_silent.count) parts.push(`${items.payer_silent.count} payer${items.payer_silent.count === 1 ? '' : 's'} silent`);
  return `${parts.slice(0, 2).join(', ')} — ClaimPaid`;
}

function digestBodies(org, user, items) {
  const first = (user.name || 'there').split(' ')[0];
  const appUrl = (process.env.APP_URL || 'https://claimpaid.io').replace(/\/+$/, '');
  const ctaUrl = `${appUrl}/app/`;
  const lines = [];
  if (items.pending_approvals.count) {
    lines.push(`Approvals waiting on you: ${items.pending_approvals.count}`);
    for (const t of items.pending_approvals.highlights) lines.push(`  • ${t}`);
  }
  if (items.filing_risk.count) {
    lines.push(`Filing risk (deadline within 14 days): ${items.filing_risk.count} claim${items.filing_risk.count === 1 ? '' : 's'}, $${items.filing_risk.amount.toLocaleString('en-US')} at stake`);
    for (const f of items.filing_risk.highlights) lines.push(`  • ${f.claim_number} — ${f.days_left < 0 ? `expired ${-f.days_left}d ago` : `${f.days_left}d left`} · $${f.amount.toLocaleString('en-US')}`);
  }
  if (items.followups_overdue.count) {
    lines.push(`Appeal follow-ups overdue: ${items.followups_overdue.count}`);
    for (const f of items.followups_overdue.highlights) lines.push(`  • ${f.claim_number} — was due ${f.due}`);
  }
  if (items.era_exceptions.count) {
    lines.push(`ERA exceptions on hold: ${items.era_exceptions.count} ($${items.era_exceptions.amount.toLocaleString('en-US')} waiting on a decision)`);
  }
  // Deploy #101: counts only in email for the new status-driven items —
  // the claim-level detail lives in the app, not in an inbox.
  if (items.re_denied && items.re_denied.count) {
    lines.push(`Appeals re-denied by the payer: ${items.re_denied.count} — ready for a response draft in the Agent tab`);
  }
  if (items.payer_silent && items.payer_silent.count) {
    lines.push(`Payers silent past their typical response window: ${items.payer_silent.count} submitted appeal${items.payer_silent.count === 1 ? '' : 's'} awaiting an answer — call briefs are ready in the app`);
  }
  const text =
    `Hi ${first},\n\n` +
    `Here's what needs your attention in ${org.name || 'your workspace'} this morning:\n\n` +
    `${lines.join('\n')}\n\n` +
    `Open ClaimPaid to work it: ${ctaUrl}\n\n` +
    `— The ClaimPaid Team`;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const sections = lines.map((l) => (l.startsWith('  • ')
    ? `<div style="margin:0 0 2px 14px;color:#475569;font-size:14px">${esc(l.slice(4))}</div>`
    : `<p style="margin:14px 0 4px;font-weight:600;color:#0f172a">${esc(l)}</p>`)).join('');
  const inner =
    `<h2 style="margin:0 0 12px;font-size:20px;color:#0f172a">This morning in ${esc(org.name || 'your workspace')}</h2>` +
    `<p style="margin:0 0 4px">Hi ${esc(first)} — here's what needs your attention:</p>` +
    sections +
    `<a href="${ctaUrl}" style="display:inline-block;background:#10B981;color:#ffffff;font-weight:700;padding:14px 32px;border-radius:12px;text-decoration:none;margin:22px 0 4px">Open the Agent tab</a>` +
    `<p style="margin:12px 0 0;color:#64748b;font-size:13px">Approvals, the full queue, and your morning brief are waiting there.</p>`;
  const html = email.layout(inner, 'You receive this digest once a day, only on mornings when something in your workspace needs your attention.');
  return { text, html };
}

async function runDigestOnce(now = new Date()) {
  const summary = { sent: 0, failed: 0, skippedUsers: 0, orgs: 0 };
  if (!agentEnabled()) return { ...summary, skipped: 'agent_disabled' };
  stampScheduler('watchdog_digest');
  // Lazy require, mirroring auth.js: routes/billing pulls the Stripe
  // stack and requiring it at module load risks a cycle.
  const { productsForOrg } = require('../routes/billing');

  const orgs = db.prepare('SELECT * FROM orgs').all();
  for (const org of orgs) {
    try {
      const products = productsForOrg(org);
      if (!products.rcm && !products.ai) continue; // plans-only: skipped entirely
      const { date, hour } = orgLocalParts(org.timezone, now);
      if (hour < WINDOW_START_HOUR || hour >= WINDOW_END_HOUR) continue; // outside the morning window — a later sweep retries
      summary.orgs++;
      const shared = sharedOrgItems(org.id);
      const members = db.prepare(`
        SELECT u.id, u.email, u.name, uo.role, COALESCE(u.digest_opt_out, 0) AS digest_opt_out FROM user_orgs uo
        JOIN users u ON u.id = uo.user_id WHERE uo.org_id = ?
      `).all(org.id);
      for (const user of members) {
        if (!user.email) { summary.skippedUsers++; continue; }
        // Deploy #101: the per-user email-digest opt-out (notification
        // center) — an opted-out user gets no digest, ever.
        if (user.digest_opt_out) { summary.skippedUsers++; continue; }
        const already = db.prepare(
          'SELECT id FROM agent_digest_log WHERE org_id = ? AND user_id = ? AND digest_date = ?'
        ).get(org.id, user.id, date);
        if (already) { summary.skippedUsers++; continue; }
        const items = computeDigestItems(org, user, shared);
        if (!items.total) { summary.skippedUsers++; continue; } // nothing actionable: no email, no log row
        const { text, html } = digestBodies(org, user, items);
        let status = 'sent';
        let error = null;
        try {
          await email.sendEmail({ to: user.email, subject: subjectFor(items), text, html });
        } catch (e) {
          status = 'failed';
          error = e.message;
          console.error(`[agent-watchdog] digest to ${user.email} (org ${org.id}) failed: ${e.message}`);
        }
        try {
          db.prepare(`
            INSERT INTO agent_digest_log (org_id, user_id, digest_date, items_count, status, error)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(org.id, user.id, date, items.total, status, error);
        } catch (e) {
          // UNIQUE race with a concurrent sweep: the other row wins and
          // the dedupe guarantee still holds; the email already went out.
          console.error(`[agent-watchdog] digest log insert failed (org ${org.id}, user ${user.id}): ${e.message}`);
        }
        if (status === 'sent') summary.sent++; else summary.failed++;
      }
    } catch (e) {
      console.error(`[agent-watchdog] org ${org.id} failed: ${e.message}`);
    }
  }
  return summary;
}

module.exports = {
  runDigestOnce, computeDigestItems, sharedOrgItems, subjectFor, orgLocalParts,
  WINDOW_START_HOUR, WINDOW_END_HOUR,
};
