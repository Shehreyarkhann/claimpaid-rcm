const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired, requireProduct } = require('../auth');
const { generateLetter, listTemplates, getTemplate, getSignature, CATEGORY_LABELS, PLACEHOLDERS, SIGNATURE_PLACEHOLDERS, DEFAULT_TEMPLATES, DEFAULT_SIGNATURE } = require('../appealLetters');
const { logActivity } = require('../activity');
const { auditLog } = require('../audit');
const { responseDaysFor, addDays, daysSince } = require('../agent/responseWindows');

const VALID_SUBMIT_CHANNELS = ['payer_portal', 'fax', 'mail', 'clearinghouse'];

const router = express.Router();
router.use(authRequired, requireProduct('rcm'));

const VALID_APPEAL_STATUS = ['open', 'in_progress', 'submitted', 'won', 'lost'];
const VALID_PRIORITY = ['low', 'medium', 'high', 'urgent'];
const canWrite = roleRequired('owner', 'biller');

function appealDetail(id, orgId) {
  return db.prepare(`
    SELECT a.*, c.claim_number, c.patient_name, p.name AS payer,
           c.billed_amount, c.paid_amount, c.denial_reason, c.service_date,
           u.name AS assignee_name, u.email AS assignee_email
    FROM appeals a
    JOIN claims c ON c.id = a.claim_id
    JOIN payers p ON p.id = c.payer_id
    LEFT JOIN users u ON u.id = a.assigned_to
    WHERE a.id = ? AND a.org_id = ?
  `).get(id, orgId);
}

// --- List appeals (work queue) ---
router.get('/', (req, res) => {
  const { status = '', assignee = '', priority = '' } = req.query;
  const where = ['a.org_id = ?'];
  const params = [req.orgId];
  if (status) { where.push('a.status = ?'); params.push(status); }
  if (priority) { where.push('a.priority = ?'); params.push(priority); }
  if (assignee === 'me') { where.push('a.assigned_to = ?'); params.push(req.user.id); }
  else if (assignee === 'unassigned') { where.push('a.assigned_to IS NULL'); }
  else if (assignee) { where.push('a.assigned_to = ?'); params.push(assignee); }

  const rows = db.prepare(`
    SELECT a.id, a.status, a.priority, a.follow_up_date, a.updated_at,
           a.submitted_via, a.submitted_at,
           (a.letter IS NOT NULL AND TRIM(a.letter) <> '') AS has_letter,
           c.claim_number, c.patient_name, p.name AS payer,
           c.billed_amount, c.paid_amount, c.denial_reason,
           (c.billed_amount - c.paid_amount) AS at_stake,
           u.name AS assignee_name,
           (SELECT COUNT(*) FROM appeal_notes n WHERE n.appeal_id = a.id) AS note_count
    FROM appeals a
    JOIN claims c ON c.id = a.claim_id
    JOIN payers p ON p.id = c.payer_id
    LEFT JOIN users u ON u.id = a.assigned_to
    WHERE ${where.join(' AND ')}
    ORDER BY
      CASE a.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      a.follow_up_date ASC
  `).all(...params);
  res.json(rows);
});

// --- Denied claims without an appeal yet (to start new appeals) ---
router.get('/unworked-denials', (req, res) => {
  const rows = db.prepare(`
    SELECT c.id AS claim_id, c.claim_number, c.patient_name, p.name AS payer,
           c.billed_amount, c.paid_amount, c.denial_reason, c.service_date,
           (c.billed_amount - c.paid_amount) AS at_stake
    FROM claims c
    JOIN payers p ON p.id = c.payer_id
    LEFT JOIN appeals a ON a.claim_id = c.id AND a.org_id = ?
    WHERE c.org_id = ? AND c.status = 'denied' AND a.id IS NULL
    ORDER BY (c.billed_amount - c.paid_amount) DESC
  `).all(req.orgId, req.orgId);
  res.json(rows);
});

// --- Follow-ups due (today or overdue, not closed) ---
router.get('/due', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT a.id, a.follow_up_date, a.priority,
           c.claim_number, c.patient_name, u.name AS assignee_name
    FROM appeals a
    JOIN claims c ON c.id = a.claim_id
    LEFT JOIN users u ON u.id = a.assigned_to
    WHERE a.org_id = ? AND a.status NOT IN ('won', 'lost')
      AND a.follow_up_date IS NOT NULL AND a.follow_up_date <= ?
    ORDER BY a.follow_up_date ASC
  `).all(req.orgId, today);
  res.json(rows);
});

// --- Letter templates: list (merged defaults + org overrides) ---
// NOTE: must be defined BEFORE /:id so Express doesn't treat "letter-templates" as an id
router.get('/letter-templates', (req, res) => {
  const sig = getSignature(req.orgId);
  res.json({
    templates: listTemplates(req.orgId),
    placeholders: PLACEHOLDERS,
    signature: { body: sig.body, is_custom: sig.is_custom },
    signature_placeholders: SIGNATURE_PLACEHOLDERS,
  });
});

// --- Awaiting payer (deploy #101): submitted appeals and the wait ---
// Every appeal in the 'submitted' state with its wait measured against
// the payer's TYPICAL response window (workspace-overridable). `silent`
// is status-driven: past the window AND no ERA line has posted for the
// claim since submission — the payer owes an answer and hasn't moved.
router.get('/awaiting-payer', (req, res) => {
  const rows = db.prepare(`
    SELECT a.id, a.submitted_at, a.submitted_via, a.follow_up_date, a.assigned_to,
           c.id AS claim_id, c.claim_number, c.patient_name, c.payer_id,
           (c.billed_amount - c.paid_amount) AS at_stake,
           p.name AS payer, u.name AS assignee_name
    FROM appeals a
    JOIN claims c ON c.id = a.claim_id
    JOIN payers p ON p.id = c.payer_id
    LEFT JOIN users u ON u.id = a.assigned_to
    WHERE a.org_id = ? AND a.status = 'submitted' AND a.submitted_at IS NOT NULL
    ORDER BY a.submitted_at ASC
  `).all(req.orgId);
  const out = rows.map((r) => {
    const window = responseDaysFor(req.orgId, r.payer_id);
    const waiting = daysSince(r.submitted_at) ?? 0;
    const moved = db.prepare(`
      SELECT id FROM era_claim_lines WHERE org_id = ? AND match_claim_id = ?
        AND post_status = 'posted' AND posted_at > ? LIMIT 1
    `).get(req.orgId, r.claim_id, r.submitted_at);
    return {
      appeal_id: r.id, claim_id: r.claim_id, claim_number: r.claim_number,
      patient_name: r.patient_name, payer: r.payer, at_stake: r.at_stake,
      submitted_at: r.submitted_at, submitted_via: r.submitted_via,
      channel: r.submitted_via, follow_up_date: r.follow_up_date,
      assignee_name: r.assignee_name,
      days_waiting: waiting, response_days: window,
      expected_by: addDays(r.submitted_at, window),
      silent: waiting > window && !moved,
      payer_moved: !!moved,
    };
  });
  out.sort((a, b) => (b.silent - a.silent) || (b.days_waiting - a.days_waiting));
  res.json({ awaiting: out });
});

// --- Get single appeal with notes timeline ---
router.get('/:id', (req, res) => {
  const appeal = appealDetail(req.params.id, req.orgId);
  if (!appeal) return res.status(404).json({ error: 'Appeal not found' });
  appeal.notes = db.prepare(`
    SELECT n.id, n.note, n.created_at, u.name AS author
    FROM appeal_notes n JOIN users u ON u.id = n.user_id
    WHERE n.appeal_id = ? ORDER BY n.created_at ASC
  `).all(appeal.id);
  appeal.linked_auths = db.prepare(`
    SELECT ar.id, ar.auth_number, ar.status, ar.cpt_codes, p.name AS payer
    FROM auth_requests ar LEFT JOIN payers p ON p.id = ar.payer_id
    WHERE ar.linked_claim_id = ? AND ar.org_id = ?
    ORDER BY ar.created_at DESC
  `).all(appeal.claim_id, req.orgId);
  res.json(appeal);
});

// --- Letter templates: save override ---
router.put('/letter-templates/:category', canWrite, (req, res) => {
  const { category } = req.params;
  const isSignature = category === 'signature';
  if (!isSignature && !DEFAULT_TEMPLATES[category]) return res.status(400).json({ error: 'Unknown template category' });
  const { body, enclosures } = req.body || {};
  if (!body?.trim()) return res.status(400).json({ error: 'Template body is required' });

  let enc = [];
  if (!isSignature) {
    if (Array.isArray(enclosures)) enc = enclosures.map((e) => String(e).trim()).filter(Boolean);
    else if (typeof enclosures === 'string') enc = enclosures.split('\n').map((e) => e.trim()).filter(Boolean);
  }

  db.prepare(`
    INSERT INTO appeal_letter_templates (org_id, category, body, enclosures, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(org_id, category) DO UPDATE SET body = excluded.body, enclosures = excluded.enclosures, updated_at = datetime('now')
  `).run(req.orgId, category, body.trim(), JSON.stringify(enc));
  res.json(isSignature ? getSignature(req.orgId) : getTemplate(req.orgId, category));
});

// --- Letter templates: reset to default ---
router.delete('/letter-templates/:category', canWrite, (req, res) => {
  const { category } = req.params;
  db.prepare('DELETE FROM appeal_letter_templates WHERE org_id = ? AND category = ?').run(req.orgId, category);
  res.json(category === 'signature' ? getSignature(req.orgId) : getTemplate(req.orgId, category));
});

// --- Generate appeal letter draft ---
router.get('/:id/letter', (req, res) => {
  const appeal = appealDetail(req.params.id, req.orgId);
  if (!appeal) return res.status(404).json({ error: 'Appeal not found' });
  const claim = db.prepare(`
    SELECT c.*, p.name AS payer FROM claims c
    LEFT JOIN payers p ON p.id = c.payer_id
    WHERE c.id = ? AND c.org_id = ?
  `).get(appeal.claim_id, req.orgId);
  const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(req.orgId);
  // Pull linked auth if any (via auth_requests.linked_claim_id)
  const auth = db.prepare(`
    SELECT * FROM auth_requests WHERE linked_claim_id = ? AND org_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(appeal.claim_id, req.orgId);
  const letter = generateLetter({ claim, appeal, org, auth });
  res.json(letter);
});

// --- Start an appeal for a denied claim ---
router.post('/', canWrite, (req, res) => {
  const { claim_id, assigned_to, priority, follow_up_date, note } = req.body || {};
  if (!claim_id) return res.status(400).json({ error: 'claim_id is required' });

  const claim = db.prepare('SELECT * FROM claims WHERE id = ? AND org_id = ?').get(claim_id, req.orgId);
  if (!claim) return res.status(404).json({ error: 'Claim not found' });
  if (claim.status !== 'denied') return res.status(400).json({ error: 'Appeals can only be opened for denied claims' });

  const existing = db.prepare('SELECT id FROM appeals WHERE claim_id = ? AND org_id = ?').get(claim_id, req.orgId);
  if (existing) return res.status(409).json({ error: 'An appeal already exists for this claim', appealId: existing.id });

  if (priority && !VALID_PRIORITY.includes(priority)) return res.status(400).json({ error: 'Invalid priority' });
  if (assigned_to) {
    const u = db.prepare('SELECT user_id AS id FROM user_orgs WHERE user_id = ? AND org_id = ?').get(assigned_to, req.orgId);
    if (!u) return res.status(400).json({ error: 'Assignee is not on your team' });
  }

  const id = Number(db.prepare(`
    INSERT INTO appeals (org_id, claim_id, assigned_to, status, priority, follow_up_date)
    VALUES (?, ?, ?, 'open', ?, ?)
  `).run(req.orgId, claim_id, assigned_to || null, priority || 'medium', follow_up_date || null).lastInsertRowid);

  if (note) {
    db.prepare('INSERT INTO appeal_notes (appeal_id, user_id, note) VALUES (?, ?, ?)')
      .run(id, req.user.id, note);
  }
  res.status(201).json(appealDetail(id, req.orgId));
});

// --- Update appeal (status, assignee, priority, follow-up) ---
router.put('/:id', canWrite, (req, res) => {
  const appeal = db.prepare('SELECT * FROM appeals WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!appeal) return res.status(404).json({ error: 'Appeal not found' });

  const { status, assigned_to, priority, follow_up_date } = req.body || {};
  const updates = [], params = [];

  if (status !== undefined) {
    if (!VALID_APPEAL_STATUS.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    updates.push('status = ?'); params.push(status);
    // Winning/losing an appeal updates the underlying claim
    if (status === 'won') {
      const c = db.prepare('SELECT billed_amount FROM claims WHERE id = ?').get(appeal.claim_id);
      db.prepare('UPDATE claims SET status = ?, paid_amount = billed_amount WHERE id = ?').run('paid', appeal.claim_id);
    } else if (status === 'lost') {
      db.prepare('UPDATE claims SET status = ? WHERE id = ?').run('denied', appeal.claim_id);
    }
    // SMART FOLLOW-UP: auto-set a follow-up date on status change (unless the user set one explicitly)
    if (follow_up_date === undefined) {
      const days = { in_progress: 7, submitted: 14, open: 3 }[status];
      if (days) {
        const d = new Date();
        d.setDate(d.getDate() + days);
        updates.push('follow_up_date = ?');
        params.push(d.toISOString().slice(0, 10));
      }
    }
  }
  if (assigned_to !== undefined) {
    if (assigned_to !== null) {
      const u = db.prepare('SELECT user_id AS id FROM user_orgs WHERE user_id = ? AND org_id = ?').get(assigned_to, req.orgId);
      if (!u) return res.status(400).json({ error: 'Assignee is not on your team' });
    }
    updates.push('assigned_to = ?'); params.push(assigned_to);
  }
  if (priority !== undefined) {
    if (!VALID_PRIORITY.includes(priority)) return res.status(400).json({ error: 'Invalid priority' });
    updates.push('priority = ?'); params.push(priority);
  }
  if (follow_up_date !== undefined) { updates.push('follow_up_date = ?'); params.push(follow_up_date || null); }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id, req.orgId);
  db.prepare(`UPDATE appeals SET ${updates.join(', ')} WHERE id = ? AND org_id = ?`).run(...params);
  const updated = appealDetail(req.params.id, req.orgId);
  updated.notes = db.prepare(`
    SELECT n.id, n.note, n.created_at, u.name AS author
    FROM appeal_notes n JOIN users u ON u.id = n.user_id
    WHERE n.appeal_id = ? ORDER BY n.created_at ASC
  `).all(updated.id);
  updated.linked_auths = db.prepare(`
    SELECT ar.id, ar.auth_number, ar.status, ar.cpt_codes, p.name AS payer
    FROM auth_requests ar LEFT JOIN payers p ON p.id = ar.payer_id
    WHERE ar.linked_claim_id = ? AND ar.org_id = ?
    ORDER BY ar.created_at DESC
  `).all(updated.claim_id, req.orgId);
  res.json(updated);
});

// Full detail payload shared by the letter endpoints (same shape the
// PUT /:id handler returns: detail + notes timeline + linked auths).
function fullAppeal(id, orgId) {
  const appeal = appealDetail(id, orgId);
  if (!appeal) return null;
  appeal.notes = db.prepare(`
    SELECT n.id, n.note, n.created_at, u.name AS author
    FROM appeal_notes n JOIN users u ON u.id = n.user_id
    WHERE n.appeal_id = ? ORDER BY n.created_at ASC
  `).all(appeal.id);
  appeal.linked_auths = db.prepare(`
    SELECT ar.id, ar.auth_number, ar.status, ar.cpt_codes, p.name AS payer
    FROM auth_requests ar LEFT JOIN payers p ON p.id = ar.payer_id
    WHERE ar.linked_claim_id = ? AND ar.org_id = ?
    ORDER BY ar.created_at DESC
  `).all(appeal.claim_id, orgId);
  return appeal;
}

// --- Save an edited appeal letter (deploy #98) ---
// The letter lives on the appeal (appeals.letter) — this is the save path
// for the letter panel's Edit action. Activity- + audit-logged like every
// other record change.
router.put('/:id/letter', canWrite, (req, res) => {
  const appeal = db.prepare('SELECT * FROM appeals WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!appeal) return res.status(404).json({ error: 'Appeal not found' });
  const { letter } = req.body || {};
  if (typeof letter !== 'string' || !letter.trim()) return res.status(400).json({ error: 'Letter text is required' });
  if (letter.length > 100000) return res.status(400).json({ error: 'Letter is too long' });
  db.prepare("UPDATE appeals SET letter = ?, updated_at = datetime('now') WHERE id = ? AND org_id = ?")
    .run(letter, appeal.id, req.orgId);
  const detail = appealDetail(appeal.id, req.orgId);
  logActivity(req.orgId, appeal.claim_id, req.user.id, 'appeal_letter_edited',
    `Appeal letter edited on claim ${detail ? detail.claim_number : appeal.claim_id}`);
  auditLog(req, 'update', 'appeal_letter', appeal.id, detail ? detail.claim_number : null);
  res.json(fullAppeal(appeal.id, req.orgId));
});

// --- Mark an appeal as submitted (deploy #98) ---
// Records HOW and WHEN the letter actually left the building (nothing in
// ClaimPaid transmits it — the submission pipe is not live). Sets the
// follow-up that keeps the appeal in the work queue: the caller's date
// when given, else the payer's typical response window (deploy #101 —
// submitted date + window days; the window is the workspace's per-payer
// rule, default 30).
router.post('/:id/mark-submitted', canWrite, (req, res) => {
  const appeal = db.prepare('SELECT * FROM appeals WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!appeal) return res.status(404).json({ error: 'Appeal not found' });
  const { via, follow_up_date } = req.body || {};
  if (!VALID_SUBMIT_CHANNELS.includes(via)) {
    return res.status(400).json({ error: `via must be one of: ${VALID_SUBMIT_CHANNELS.join(', ')}` });
  }
  let followUp = follow_up_date || null;
  if (followUp !== null && !/^\d{4}-\d{2}-\d{2}$/.test(followUp)) {
    return res.status(400).json({ error: 'follow_up_date must be YYYY-MM-DD' });
  }
  if (!followUp) {
    const claim = db.prepare('SELECT payer_id FROM claims WHERE id = ?').get(appeal.claim_id);
    const window = responseDaysFor(req.orgId, claim ? claim.payer_id : null);
    followUp = addDays(new Date().toISOString().slice(0, 10), window);
  }
  db.prepare(`
    UPDATE appeals SET status = 'submitted', submitted_via = ?, submitted_at = datetime('now'),
      follow_up_date = ?, updated_at = datetime('now')
    WHERE id = ? AND org_id = ?
  `).run(via, followUp, appeal.id, req.orgId);
  const detail = appealDetail(appeal.id, req.orgId);
  logActivity(req.orgId, appeal.claim_id, req.user.id, 'appeal_submitted',
    `Appeal on claim ${detail ? detail.claim_number : appeal.claim_id} marked submitted via ${via} — follow-up ${followUp}`);
  auditLog(req, 'submit', 'appeal', appeal.id, detail ? detail.claim_number : null);
  res.json(fullAppeal(appeal.id, req.orgId));
});

// --- Add a note to the timeline ---
router.post('/:id/notes', canWrite, (req, res) => {
  const appeal = db.prepare('SELECT id FROM appeals WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!appeal) return res.status(404).json({ error: 'Appeal not found' });
  if (!req.body.note || !req.body.note.trim()) return res.status(400).json({ error: 'Note text is required' });

  const nid = Number(db.prepare('INSERT INTO appeal_notes (appeal_id, user_id, note) VALUES (?, ?, ?)')
    .run(appeal.id, req.user.id, req.body.note.trim()).lastInsertRowid);
  db.prepare("UPDATE appeals SET updated_at = datetime('now') WHERE id = ?").run(appeal.id);
  res.status(201).json(db.prepare(`
    SELECT n.id, n.note, n.created_at, u.name AS author
    FROM appeal_notes n JOIN users u ON u.id = n.user_id WHERE n.id = ?
  `).get(nid));
});

// --- Delete appeal ---
router.delete('/:id', canWrite, (req, res) => {
  const appeal = db.prepare('SELECT id FROM appeals WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!appeal) return res.status(404).json({ error: 'Appeal not found' });
  db.prepare('DELETE FROM appeal_notes WHERE appeal_id = ?').run(appeal.id);
  db.prepare('DELETE FROM appeals WHERE id = ?').run(appeal.id);
  res.json({ deleted: true });
});

module.exports = router;
