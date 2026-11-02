const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired, requireProduct } = require('../auth');

const router = express.Router();
router.use(authRequired, requireProduct('rcm'));

function splitFirst(s) {
  return String(s || '').split(/[,\s;]+/).map((c) => c.trim()).filter(Boolean)[0] || null;
}

// Denial Copilot actions (Phase B): 'flag' only warns (the original
// behavior); 'append_modifier' auto-corrects future claims at scrub time.
// Returns { action_type, action_value } or { error }.
function parseAction(body) {
  const t = (body?.action_type || 'flag').trim();
  if (!['flag', 'append_modifier'].includes(t)) return { error: "action_type must be 'flag' or 'append_modifier'" };
  if (t === 'append_modifier') {
    const v = (body?.action_value || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{2}$/.test(v)) return { error: 'action_value must be a 2-character modifier (e.g. 25, 59, LT)' };
    return { action_type: t, action_value: v };
  }
  return { action_type: 'flag', action_value: null };
}

// --- Pending suggestions (with payer name) ---
router.get('/suggestions', (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, p.name AS payer_name
    FROM rule_suggestions s LEFT JOIN payers p ON p.id = s.payer_id
    WHERE s.org_id = ? AND s.status = 'pending'
    ORDER BY s.occurrences DESC, s.last_seen DESC
  `).all(req.orgId);
  res.json(rows);
});

// --- Analyze recent denials and surface rule suggestions ---
router.post('/analyze', roleRequired('owner', 'biller'), (req, res) => {
  const denied = db.prepare(`
    SELECT id, payer_id, denial_reason, cpt_codes, created_at
    FROM claims
    WHERE org_id = ? AND status = 'denied'
      AND date(created_at) >= date('now', '-90 days')
  `).all(req.orgId);

  // Group by (payer_id, denial_reason, first CPT)
  const groups = new Map();
  for (const c of denied) {
    const key = JSON.stringify([
      c.payer_id || null,
      (c.denial_reason || '').trim() || null,
      splitFirst(c.cpt_codes),
    ]);
    if (!groups.has(key)) groups.set(key, { payer_id: c.payer_id || null, denial_reason: (c.denial_reason || '').trim() || null, cpt_code: splitFirst(c.cpt_codes), first_seen: c.created_at, last_seen: c.created_at, occurrences: 0 });
    const g = groups.get(key);
    g.occurrences += 1;
    if (c.created_at < g.first_seen) g.first_seen = c.created_at;
    if (c.created_at > g.last_seen) g.last_seen = c.created_at;
  }

  const findExisting = db.prepare(`
    SELECT id, status FROM rule_suggestions
    WHERE org_id = ? AND COALESCE(payer_id, -1) = COALESCE(?, -1)
      AND COALESCE(denial_reason, '') = COALESCE(?, '')
      AND COALESCE(cpt_code, '') = COALESCE(?, '')
  `);
  const insertSugg = db.prepare(`
    INSERT INTO rule_suggestions (org_id, payer_id, denial_reason, cpt_code, occurrences, first_seen, last_seen, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `);
  const updateSugg = db.prepare(`
    UPDATE rule_suggestions SET occurrences = ?, last_seen = ?, status = 'pending' WHERE id = ?
  `);

  let created = 0, updated = 0;
  for (const g of groups.values()) {
    if (g.occurrences < 3) continue;
    const existing = findExisting.get(req.orgId, g.payer_id, g.denial_reason, g.cpt_code);
    if (existing) {
      if (existing.status === 'pending') { updateSugg.run(g.occurrences, g.last_seen, existing.id); updated += 1; }
      // 'accepted' → already converted to a rule; 'dismissed' → user said no. Skip both.
    } else {
      insertSugg.run(req.orgId, g.payer_id, g.denial_reason, g.cpt_code, g.occurrences, g.first_seen, g.last_seen);
      created += 1;
    }
  }
  res.json({ analyzed: denied.length, patterns: groups.size, created, updated });
});

// --- Accept a suggestion → becomes an active custom scrub rule ---
router.post('/suggestions/:id/accept', roleRequired('owner', 'biller'), (req, res) => {
  const s = db.prepare('SELECT * FROM rule_suggestions WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!s) return res.status(404).json({ error: 'Suggestion not found' });
  if (s.status !== 'pending') return res.status(400).json({ error: 'Suggestion already handled' });

  const act = parseAction(req.body || {});
  if (act.error) return res.status(400).json({ error: act.error });
  if (act.action_type === 'append_modifier' && !s.cpt_code) {
    return res.status(400).json({ error: 'Auto-append needs a CPT code on the pattern — this suggestion has none.' });
  }

  const payer = s.payer_id ? db.prepare('SELECT name FROM payers WHERE id = ?').get(s.payer_id) : null;
  const bits = [s.cpt_code ? `CPT ${s.cpt_code}` : null, payer?.name || null, s.denial_reason ? `"${s.denial_reason}"` : null].filter(Boolean);
  const name = `Denial pattern: ${bits.join(' · ') || 'recurring denial'}`;
  const message = `Detected ${s.occurrences} denials for ${s.denial_reason ? `"${s.denial_reason}"` : 'this pattern'}${payer ? ` with ${payer.name}` : ''}${s.cpt_code ? ` on CPT ${s.cpt_code}` : ''} in the last 90 days — review before submitting.`;

  const info = db.prepare(`
    INSERT INTO custom_scrub_rules (org_id, name, severity, payer_id, cpt_code, icd_code, message, source, is_active, created_by, action_type, action_value)
    VALUES (?, ?, 'warning', ?, ?, ?, ?, 'suggestion', 1, ?, ?, ?)
  `).run(req.orgId, name, s.payer_id, s.cpt_code, s.icd_code, message, req.user.id, act.action_type, act.action_value);
  db.prepare("UPDATE rule_suggestions SET status = 'accepted' WHERE id = ?").run(s.id);
  res.json({ id: info.lastInsertRowid, name });
});

// --- Dismiss a suggestion ---
router.post('/suggestions/:id/dismiss', roleRequired('owner', 'biller'), (req, res) => {
  const r = db.prepare("UPDATE rule_suggestions SET status = 'dismissed' WHERE id = ? AND org_id = ? AND status = 'pending'").run(req.params.id, req.orgId);
  if (!r.changes) return res.status(404).json({ error: 'Suggestion not found' });
  res.json({ ok: true });
});

// --- Manual custom rules: list ---
router.get('/custom', (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, p.name AS payer_name
    FROM custom_scrub_rules r LEFT JOIN payers p ON p.id = r.payer_id
    WHERE r.org_id = ? ORDER BY r.created_at DESC
  `).all(req.orgId);
  res.json(rows);
});

// --- Manual custom rules: create ---
router.post('/custom', roleRequired('owner', 'biller'), (req, res) => {
  const { name, severity, payer_id, cpt_code, icd_code, message, is_active } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Rule name is required' });
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });
  if (!['error', 'warning'].includes(severity)) return res.status(400).json({ error: 'Severity must be error or warning' });
  const act = parseAction(req.body || {});
  if (act.error) return res.status(400).json({ error: act.error });
  if (act.action_type === 'append_modifier' && !cpt_code?.trim()) {
    return res.status(400).json({ error: 'Auto-append needs a CPT code to attach the modifier to.' });
  }
  const info = db.prepare(`
    INSERT INTO custom_scrub_rules (org_id, name, severity, payer_id, cpt_code, icd_code, message, source, is_active, created_by, action_type, action_value)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)
  `).run(
    req.orgId, name.trim(), severity,
    payer_id ? Number(payer_id) : null,
    cpt_code?.trim() || null, icd_code?.trim() || null,
    message.trim(), is_active === false ? 0 : 1, req.user.id,
    act.action_type, act.action_value
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

// --- One-click rule from a single denial (Denial Copilot) ---
// Creates an ACTIVE rule scoped to the denied claim's payer + first CPT so
// the pattern is caught (or auto-corrected) on every future claim. If an
// identical active rule already exists, returns it instead of duplicating.
router.post('/from-denial/:claimId', roleRequired('owner', 'biller'), (req, res) => {
  const claim = db.prepare(`
    SELECT c.*, p.name AS payer_name FROM claims c LEFT JOIN payers p ON p.id = c.payer_id
    WHERE c.id = ? AND c.org_id = ?
  `).get(req.params.claimId, req.orgId);
  if (!claim) return res.status(404).json({ error: 'Claim not found' });
  if (claim.status !== 'denied') return res.status(400).json({ error: 'Rules are created from denied claims' });
  const act = parseAction(req.body || {});
  if (act.error) return res.status(400).json({ error: act.error });
  const cpt = splitFirst(claim.cpt_codes);
  if (act.action_type === 'append_modifier' && !cpt) {
    return res.status(400).json({ error: 'This claim has no CPT code to attach a modifier to.' });
  }
  const existing = db.prepare(`
    SELECT id FROM custom_scrub_rules
    WHERE org_id = ? AND COALESCE(payer_id, -1) = COALESCE(?, -1)
      AND COALESCE(cpt_code, '') = COALESCE(?, '')
      AND action_type = ? AND COALESCE(action_value, '') = COALESCE(?, '')
      AND is_active = 1
  `).get(req.orgId, claim.payer_id, cpt, act.action_type, act.action_value);
  if (existing) return res.json({ id: existing.id, deduped: true });

  const bits = [cpt ? `CPT ${cpt}` : null, claim.payer_name || null, claim.denial_reason ? `"${claim.denial_reason}"` : null].filter(Boolean);
  const name = `Denial pattern: ${bits.join(' · ') || 'recurring denial'}`;
  const message = act.action_type === 'append_modifier'
    ? `${claim.claim_number} was denied${claim.denial_reason ? ` (${claim.denial_reason})` : ''} — modifier ${act.action_value} is auto-appended to CPT ${cpt} before submission.`
    : `${claim.claim_number} was denied${claim.denial_reason ? ` (${claim.denial_reason})` : ''} — review claims matching this pattern before submitting.`;
  const info = db.prepare(`
    INSERT INTO custom_scrub_rules (org_id, name, severity, payer_id, cpt_code, icd_code, message, source, is_active, created_by, action_type, action_value)
    VALUES (?, ?, 'warning', ?, ?, ?, ?, 'manual', 1, ?, ?, ?)
  `).run(req.orgId, name, claim.payer_id, cpt, null, message, req.user.id, act.action_type, act.action_value);
  res.status(201).json({ id: info.lastInsertRowid, name });
});

// --- Toggle a rule on/off ---
router.post('/custom/:id/toggle', roleRequired('owner', 'biller'), (req, res) => {
  const r = db.prepare('UPDATE custom_scrub_rules SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ? AND org_id = ?')
    .run(req.params.id, req.orgId);
  if (!r.changes) return res.status(404).json({ error: 'Rule not found' });
  const row = db.prepare('SELECT is_active FROM custom_scrub_rules WHERE id = ?').get(req.params.id);
  res.json({ ok: true, is_active: row.is_active });
});

// --- Recent auto-corrections applied by rules ---
router.get('/applications', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, r.name AS rule_name, c.claim_number
    FROM rule_applications a
    JOIN custom_scrub_rules r ON r.id = a.rule_id
    JOIN claims c ON c.id = a.claim_id
    WHERE a.org_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 50
  `).all(req.orgId);
  res.json(rows);
});

// --- Manual custom rules: delete ---
router.delete('/custom/:id', roleRequired('owner', 'biller'), (req, res) => {
  const r = db.prepare('DELETE FROM custom_scrub_rules WHERE id = ? AND org_id = ?').run(req.params.id, req.orgId);
  if (!r.changes) return res.status(404).json({ error: 'Rule not found' });
  res.json({ ok: true });
});

module.exports = router;
