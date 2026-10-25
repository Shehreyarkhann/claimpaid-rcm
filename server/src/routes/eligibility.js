const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired, requireProduct } = require('../auth');
const { runCheck } = require('../eligibility/vendors');

const router = express.Router();
router.use(authRequired, requireProduct('rcm'));
const canWrite = roleRequired('owner', 'biller');
const ownerOnly = roleRequired('owner');

const ELIG_VENDORS = ['rest', 'availity'];

// Org's eligibility vendor config (columns on orgs; see db.js for the at-rest note)
function orgEligConfig(orgId) {
  const o = db.prepare(
    `SELECT eligibility_vendor, eligibility_endpoint, eligibility_api_key, eligibility_auth_scheme,
            eligibility_availity_client_id, eligibility_availity_client_secret,
            eligibility_availity_payer_map, eligibility_availity_env, billing_npi
     FROM orgs WHERE id = ?`
  ).get(orgId) || {};
  return {
    vendor: ELIG_VENDORS.includes(o.eligibility_vendor) ? o.eligibility_vendor : null,
    endpoint: o.eligibility_endpoint || '',
    api_key: o.eligibility_api_key || '',
    auth_scheme: o.eligibility_auth_scheme || 'Bearer',
    availity_client_id: o.eligibility_availity_client_id || '',
    availity_client_secret_set: !!o.eligibility_availity_client_secret,
    availity_payer_map: o.eligibility_availity_payer_map || '',
    availity_env: o.eligibility_availity_env === 'demo' ? 'demo-tst'
      : (['production', 'demo-tst', 'demo-qua'].includes(o.eligibility_availity_env) ? o.eligibility_availity_env : 'production'),
    billing_npi: o.billing_npi || '',
  };
}

const STATUSES = ['active', 'inactive', 'unknown'];
const STATUS_LABELS = { active: 'Active', inactive: 'Inactive', unknown: 'Not verified' };

// --- List ---
router.get('/', (req, res) => {
  const { status = '', payer = '', search = '' } = req.query;
  const where = ['e.org_id = ?'];
  const params = [req.orgId];
  if (status) { where.push('e.coverage_status = ?'); params.push(status); }
  if (payer) { where.push('p.name = ?'); params.push(payer); }
  if (search) { where.push('e.patient_name LIKE ?'); params.push(`%${search}%`); }

  const rows = db.prepare(`
    SELECT e.*, p.name AS payer_name, u.name AS checked_by_name
    FROM eligibility_checks e
    LEFT JOIN payers p ON p.id = e.payer_id
    LEFT JOIN users u ON u.id = e.checked_by
    WHERE ${where.join(' AND ')}
    ORDER BY e.service_date ASC
  `).all(...params);
  res.json({ checks: rows, statuses: STATUS_LABELS });
});

// --- Stats ---
router.get('/stats', (req, res) => {
  const byStatus = db.prepare(`
    SELECT coverage_status, COUNT(*) AS n FROM eligibility_checks
    WHERE org_id = ? GROUP BY coverage_status
  `).all(req.orgId);

  const upcoming = db.prepare(`
    SELECT COUNT(*) AS n FROM eligibility_checks
    WHERE org_id = ? AND coverage_status = 'unknown'
      AND service_date IS NOT NULL AND service_date >= date('now')
      AND service_date <= date('now', '+7 days')
  `).get(req.orgId).n;

  res.json({
    byStatus: Object.fromEntries(byStatus.map((r) => [r.coverage_status, r.n])),
    upcomingUnverified: upcoming,
    total: byStatus.reduce((a, r) => a + r.n, 0),
  });
});

// ================= REAL-TIME ELIGIBILITY (270/271-style) =================
// Vendor-backed lookups stored in eligibility_lookups (separate from the manual
// eligibility_checks log above). A vendor must be configured in Settings —
// there is no demo vendor (removed at market launch, deploy #52).

// --- Run a real-time check ---
router.post('/check', canWrite, async (req, res) => {
  const b = req.body || {};
  // Accept payer_id (preferred, from the app's payer list) or a raw payer name
  let payerName = (b.payer || '').trim();
  if (b.payer_id) {
    const p = db.prepare('SELECT name FROM payers WHERE id = ? AND org_id = ?').get(b.payer_id, req.orgId);
    if (!p) return res.status(400).json({ error: 'Payer not found' });
    payerName = p.name;
  } else if (payerName) {
    const p = db.prepare('SELECT id FROM payers WHERE org_id = ? AND LOWER(name) = LOWER(?)').get(req.orgId, payerName);
    if (!p) return res.status(400).json({ error: 'Payer not found in your payer list' });
    payerName = p.name;
  }

  const cfg = orgEligConfig(req.orgId);
  if (!cfg.vendor) {
    return res.status(400).json({ error: 'No eligibility vendor configured — connect Availity or a REST endpoint in Organization settings.' });
  }
  let result;
  try {
    const rawOrg = db.prepare(
      'SELECT eligibility_availity_client_secret FROM orgs WHERE id = ?'
    ).get(req.orgId) || {};
    result = await runCheck(cfg.vendor, {
      eligibility_endpoint: cfg.endpoint,
      eligibility_api_key: cfg.api_key,
      eligibility_auth_scheme: cfg.auth_scheme,
      eligibility_availity_client_id: cfg.availity_client_id,
      eligibility_availity_client_secret: rawOrg.eligibility_availity_client_secret || '',
      eligibility_availity_payer_map: cfg.availity_payer_map,
      eligibility_availity_env: cfg.availity_env,
      billing_npi: cfg.billing_npi,
    }, { ...b, payer: payerName });
  } catch (e) {
    // Validation errors -> 400; vendor failures -> 502 (never silently demo)
    return res.status(e.status || 502).json({ error: e.message });
  }

  const demo = !!(result.raw_response && result.raw_response.demo);
  const id = Number(db.prepare(`
    INSERT INTO eligibility_lookups
      (org_id, patient_first, patient_last, dob, member_id, payer, date_of_service,
       vendor, coverage_active, plan_name, plan_type, group_number,
       copay_primary, copay_specialist, deductible_individual, deductible_remaining,
       oop_max, effective_date, term_date, raw_request, raw_response, checked_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.orgId, b.patient_first.trim(), b.patient_last.trim(), b.dob, b.member_id.trim(),
    payerName, b.date_of_service, cfg.vendor,
    result.coverage_active, result.plan_name, result.plan_type, result.group_number,
    result.copay_primary, result.copay_specialist, result.deductible_individual,
    result.deductible_remaining, result.oop_max, result.effective_date, result.term_date,
    JSON.stringify(result.raw_request), JSON.stringify(result.raw_response), req.user.id,
  ).lastInsertRowid);

  const row = db.prepare('SELECT * FROM eligibility_lookups WHERE id = ?').get(id);
  res.status(201).json({ ...row, demo });
});

// --- Lookup history (org-scoped, raw payloads excluded from the list) ---
const LOOKUP_LIST_COLS = `l.id, l.org_id, l.patient_first, l.patient_last, l.dob, l.member_id, l.payer,
  l.date_of_service, l.vendor, l.coverage_active, l.plan_name, l.plan_type, l.group_number,
  l.copay_primary, l.copay_specialist, l.deductible_individual, l.deductible_remaining,
  l.oop_max, l.effective_date, l.term_date, l.checked_by, l.created_at`;

router.get('/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const rows = db.prepare(`
    SELECT ${LOOKUP_LIST_COLS}, u.name AS checked_by_name
    FROM eligibility_lookups l LEFT JOIN users u ON u.id = l.checked_by
    WHERE l.org_id = ? ORDER BY l.created_at DESC, l.id DESC LIMIT ?
  `).all(req.orgId, limit);
  res.json({ lookups: rows.map((r) => ({ ...r, demo: r.vendor === 'demo' })) });
});

// --- Lookup detail (includes raw request/response) ---
router.get('/lookup/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM eligibility_lookups WHERE id = ? AND org_id = ?')
    .get(req.params.id, req.orgId);
  if (!row) return res.status(404).json({ error: 'Eligibility check not found' });
  res.json({ ...row, demo: row.vendor === 'demo' });
});

// --- Vendor mode (any org member — powers the vendor badge) ---
router.get('/mode', (req, res) => {
  const cfg = orgEligConfig(req.orgId);
  res.json({ vendor: cfg.vendor, demo: false });
});

// --- Vendor config (owner only) ---
router.get('/config', ownerOnly, (req, res) => {
  res.json(orgEligConfig(req.orgId));
});

router.put('/config', ownerOnly, (req, res) => {
  const b = req.body || {};
  const vendor = (b.vendor || '').trim();
  if (!ELIG_VENDORS.includes(vendor)) return res.status(400).json({ error: 'Invalid vendor' });
  const endpoint = (b.endpoint || '').trim();
  const auth_scheme = (b.auth_scheme || 'Bearer').trim() || 'Bearer';
  if (vendor === 'rest' && !endpoint) {
    return res.status(400).json({ error: 'Endpoint URL is required for a custom REST vendor' });
  }
  if (endpoint && !/^https?:\/\//i.test(endpoint)) {
    return res.status(400).json({ error: 'Endpoint must be an http(s) URL' });
  }
  // Availity fields (deploy #46 step 4): client id + payer map always
  // updatable; the secret only changes when a non-empty value is sent.
  if (b.availity_payer_map !== undefined && b.availity_payer_map !== '') {
    try {
      const pm = JSON.parse(b.availity_payer_map);
      if (!pm || typeof pm !== 'object' || Array.isArray(pm)) throw new Error('not an object');
    } catch {
      return res.status(400).json({ error: 'Availity payer map must be a JSON object of payer name -> Availity payer ID' });
    }
  }
  if (vendor === 'availity') {
    const existing = orgEligConfig(req.orgId);
    const cid = (b.availity_client_id !== undefined ? b.availity_client_id : existing.availity_client_id || '').trim();
    const hasSecret = !!(b.availity_client_secret || existing.availity_client_secret_set);
    if (!cid || !hasSecret) {
      return res.status(400).json({ error: 'Availity needs your developer app Client ID and Client Secret' });
    }
  }
  const updates = ['eligibility_vendor = ?', 'eligibility_endpoint = ?', 'eligibility_auth_scheme = ?'];
  const params = [vendor, endpoint || null, auth_scheme];
  if (b.availity_client_id !== undefined) { updates.push('eligibility_availity_client_id = ?'); params.push((b.availity_client_id || '').trim() || null); }
  if (b.availity_client_secret) { updates.push('eligibility_availity_client_secret = ?'); params.push(b.availity_client_secret); }
  if (b.availity_payer_map !== undefined) { updates.push('eligibility_availity_payer_map = ?'); params.push((b.availity_payer_map || '').trim() || null); }
  if (b.availity_env !== undefined) {
    const envNorm = b.availity_env === 'demo' ? 'demo-tst' : b.availity_env;
    if (!['production', 'demo-tst', 'demo-qua'].includes(envNorm)) return res.status(400).json({ error: 'Availity environment must be production, demo-tst, or demo-qua' });
    updates.push('eligibility_availity_env = ?'); params.push(envNorm);
  }
  if (b.api_key !== undefined && b.api_key !== '') {
    updates.push('eligibility_api_key = ?');
    params.push(b.api_key);
  }
  params.push(req.orgId);
  db.prepare(`UPDATE orgs SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(orgEligConfig(req.orgId));
});


// --- Create ---
router.post('/', canWrite, (req, res) => {
  const b = req.body || {};
  if (!b.patient_name?.trim()) return res.status(400).json({ error: 'Patient name is required' });
  if (b.coverage_status && !STATUSES.includes(b.coverage_status)) {
    return res.status(400).json({ error: 'Invalid coverage status' });
  }
  if (b.payer_id) {
    const p = db.prepare('SELECT id FROM payers WHERE id = ? AND org_id = ?').get(b.payer_id, req.orgId);
    if (!p) return res.status(400).json({ error: 'Payer not found' });
  }

  const id = Number(db.prepare(`
    INSERT INTO eligibility_checks
      (org_id, patient_name, payer_id, service_date, coverage_status, verified_via,
       effective_date, term_date, copay, deductible_remaining, notes, checked_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.orgId, b.patient_name.trim(), b.payer_id || null, b.service_date || null,
    b.coverage_status || 'unknown', b.verified_via || null, b.effective_date || null,
    b.term_date || null, b.copay ?? null, b.deductible_remaining ?? null,
    b.notes?.trim() || null, req.user.id,
  ).lastInsertRowid);
  res.status(201).json(db.prepare('SELECT * FROM eligibility_checks WHERE id = ?').get(id));
});

// --- Update ---
router.put('/:id', canWrite, (req, res) => {
  const existing = db.prepare('SELECT * FROM eligibility_checks WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!existing) return res.status(404).json({ error: 'Record not found' });

  const b = req.body || {};
  const updates = [], params = [];
  const fields = ['patient_name', 'service_date', 'verified_via', 'effective_date', 'term_date', 'copay', 'deductible_remaining', 'notes'];
  for (const f of fields) {
    if (b[f] !== undefined) { updates.push(`${f} = ?`); params.push(b[f] === '' ? null : b[f]); }
  }
  if (b.coverage_status !== undefined) {
    if (!STATUSES.includes(b.coverage_status)) return res.status(400).json({ error: 'Invalid coverage status' });
    updates.push('coverage_status = ?'); params.push(b.coverage_status);
    updates.push('checked_by = ?'); params.push(req.user.id);
  }
  if (b.payer_id !== undefined) {
    if (b.payer_id !== null) {
      const p = db.prepare('SELECT id FROM payers WHERE id = ? AND org_id = ?').get(b.payer_id, req.orgId);
      if (!p) return res.status(400).json({ error: 'Payer not found' });
    }
    updates.push('payer_id = ?'); params.push(b.payer_id);
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id, req.orgId);
  db.prepare(`UPDATE eligibility_checks SET ${updates.join(', ')} WHERE id = ? AND org_id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM eligibility_checks WHERE id = ?').get(req.params.id));
});

// --- Delete ---
router.delete('/:id', canWrite, (req, res) => {
  const r = db.prepare('DELETE FROM eligibility_checks WHERE id = ? AND org_id = ?').run(req.params.id, req.orgId);
  if (!r.changes) return res.status(404).json({ error: 'Record not found' });
  res.json({ deleted: true });
});

module.exports = router;
