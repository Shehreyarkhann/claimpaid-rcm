'use strict';
// Notification center (deploy #101) — one bell, one queue. Items are
// DERIVED at read time from the same tables the product already reads
// (pending approvals, appeal follow-ups, payer silence, held ERA
// remittances, auto-approved drafts awaiting review) — there is no
// notification table to drift out of sync. Read state is a single
// per-user watermark (users.notifications_read_at): an item is unread
// when its timestamp is newer than the watermark; opening the panel
// posts the watermark forward.
const { db } = require('../db');
const { responseDaysFor, daysSince } = require('./responseWindows');
const { actionTitle } = require('./actions');

function money(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Returns { items, unread_count, read_at, digest_opt_out } for the user
// in their current org. Items newest-first, capped per category so one
// noisy category can't flood the panel.
function buildNotifications(orgId, user) {
  const items = [];
  const canDecide = ['owner', 'biller'].includes(user.role);
  const today = new Date().toISOString().slice(0, 10);

  if (canDecide) {
    const pending = db.prepare(`
      SELECT * FROM agent_actions WHERE org_id = ? AND status = 'pending'
      ORDER BY created_at DESC LIMIT 10
    `).all(orgId);
    for (const a of pending) {
      items.push({
        id: `approval-${a.id}`,
        category: 'approval',
        title: actionTitle(a),
        detail: 'Waiting for a decision in the Agent tab',
        ts: a.created_at,
        target: { page: 'agent', section: 'approvals' },
      });
    }
  }

  const followups = db.prepare(`
    SELECT a.id AS appeal_id, a.follow_up_date, a.updated_at, c.id AS claim_id, c.claim_number
    FROM appeals a JOIN claims c ON c.id = a.claim_id
    WHERE a.org_id = ? AND a.assigned_to = ? AND a.status NOT IN ('won', 'lost')
      AND a.follow_up_date IS NOT NULL AND a.follow_up_date <= ?
    ORDER BY a.follow_up_date ASC LIMIT 10
  `).all(orgId, user.id, today);
  for (const f of followups) {
    items.push({
      id: `followup-${f.appeal_id}`,
      category: 'followup',
      title: `Follow-up due — claim ${f.claim_number}`,
      detail: f.follow_up_date < today ? `Was due ${f.follow_up_date}` : 'Due today',
      ts: f.updated_at,
      target: { page: 'denials', appealId: f.appeal_id },
    });
  }

  // Payer silence (deploy #101): my submitted appeals past the payer's
  // typical window with no ERA movement since submission.
  const submitted = db.prepare(`
    SELECT a.id AS appeal_id, a.submitted_at, a.submitted_via, c.id AS claim_id, c.claim_number, c.payer_id
    FROM appeals a JOIN claims c ON c.id = a.claim_id
    WHERE a.org_id = ? AND a.assigned_to = ? AND a.status = 'submitted' AND a.submitted_at IS NOT NULL
    ORDER BY a.submitted_at ASC LIMIT 25
  `).all(orgId, user.id);
  for (const s of submitted) {
    const waiting = daysSince(s.submitted_at);
    const window = responseDaysFor(orgId, s.payer_id);
    if (waiting == null || waiting <= window) continue;
    const moved = db.prepare(`
      SELECT id FROM era_claim_lines WHERE org_id = ? AND match_claim_id = ?
        AND post_status = 'posted' AND posted_at > ? LIMIT 1
    `).get(orgId, s.claim_id, s.submitted_at);
    if (moved) continue;
    items.push({
      id: `silent-${s.appeal_id}`,
      category: 'payer_silent',
      title: `Payer silent — claim ${s.claim_number}`,
      detail: `${waiting} days waiting · typical window ${window} days · submitted via ${s.submitted_via || '—'}`,
      ts: s.submitted_at,
      target: { page: 'denials', appealId: s.appeal_id },
    });
  }

  const held = db.prepare(`
    SELECT r.id, r.payer_name, r.created_at,
      (SELECT COUNT(*) FROM era_claim_lines l WHERE l.era_id = r.id AND l.post_status = 'pending') AS pending_lines,
      (SELECT COALESCE(SUM(l.billed), 0) FROM era_claim_lines l WHERE l.era_id = r.id AND l.post_status = 'pending') AS pending_amount
    FROM era_remittances r
    WHERE r.org_id = ? AND r.status != 'posted'
    ORDER BY r.created_at DESC LIMIT 10
  `).all(orgId).filter((r) => r.pending_lines > 0);
  for (const h of held) {
    items.push({
      id: `era-${h.id}`,
      category: 'era_held',
      title: `ERA on hold — ${h.payer_name || 'remittance'}`,
      detail: `${h.pending_lines} line${h.pending_lines === 1 ? '' : 's'} waiting · $${money(h.pending_amount).toLocaleString('en-US')} billed`,
      ts: h.created_at,
      target: { page: 'era' },
    });
  }

  if (canDecide) {
    const autos = db.prepare(`
      SELECT * FROM agent_actions
      WHERE org_id = ? AND auto_approved = 1 AND status = 'executed'
        AND executed_at >= datetime('now', '-7 days')
      ORDER BY executed_at DESC LIMIT 10
    `).all(orgId);
    for (const a of autos) {
      items.push({
        id: `auto-${a.id}`,
        category: 'auto_approved',
        title: actionTitle(a),
        detail: 'Auto-approved by your policy — review it in the Agent tab',
        ts: a.executed_at,
        target: { page: 'agent', section: 'auto' },
      });
    }
  }

  items.sort((x, y) => String(y.ts).localeCompare(String(x.ts)));
  const row = db.prepare('SELECT notifications_read_at, COALESCE(digest_opt_out, 0) AS digest_opt_out FROM users WHERE id = ?').get(user.id);
  const readAt = row ? row.notifications_read_at : null;
  const unread = readAt ? items.filter((i) => String(i.ts) > String(readAt).replace('T', ' ')).length : items.length;
  return {
    items,
    unread_count: unread,
    read_at: readAt,
    digest_opt_out: row ? row.digest_opt_out === 1 : false,
  };
}

module.exports = { buildNotifications };
