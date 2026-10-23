const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired, requireProduct } = require('../auth');

const router = express.Router();
router.use(authRequired, requireProduct('rcm'));

function splitFirst(s) {
  return String(s || '').split(/[,\s;]+/).map((c) => c.trim()).filter(Boolean)[0] || null;
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

  const payer = s.payer_id ? db.prepare('SELECT name FROM payers WHERE id = ?').get(s.payer_id) : null;
  const bits = [s.cpt_code ? `CPT ${s.cpt_code}` : null, payer?.name || null, s.denial_reason ? `"${s.denial_reason}"` : null].filter(Boolean);
  const name = `Denial pattern: ${bits.join(' · ') || 'recurring denial'}`;
  const message = `Detected ${s.occurrences} denials for ${s.denial_reason ? `"${s.denial_reason}"` : 'this pattern'}${payer ? ` with ${payer.name}` : ''}${s.cpt_code ? ` on CPT ${s.cpt_code}` : ''} in the last 90 days — review before submitting.`;

  const info = db.prepare(`
    INSERT INTO custom_scrub_rules (org_id, name, severity, payer_id, cpt_code, icd_code, message, source, is_active, created_by)
    VALUES (?, ?, 'warning', ?, ?, ?, ?, 'suggestion', 1, ?)
  `).run(req.orgId, name, s.payer_id, s.cpt_code, s.icd_code, message, req.user.id);
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
  const info = db.prepare(`
    INSERT INTO custom_scrub_rules (org_id, name, severity, payer_id, cpt_code, icd_code, message, source, is_active, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)
  `).run(
    req.orgId, name.trim(), severity,
    payer_id ? Number(payer_id) : null,
    cpt_code?.trim() || null, icd_code?.trim() || null,
    message.trim(), is_active === false ? 0 : 1, req.user.id
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

// --- Manual custom rules: delete ---
router.delete('/custom/:id', roleRequired('owner', 'biller'), (req, res) => {
  const r = db.prepare('DELETE FROM custom_scrub_rules WHERE id = ? AND org_id = ?').run(req.params.id, req.orgId);
  if (!r.changes) return res.status(404).json({ error: 'Rule not found' });
  res.json({ ok: true });
});

module.exports = router;
