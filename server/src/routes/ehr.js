// EHR integration API (athenahealth first, pluggable).
//
// Honest scope: live encounters require a real EHR connection. athenahealth
// needs a Developer Console app (+ practice authorization for production).
// Epic needs certification (~$10k+, 6-12 months) — out of scope, noted in UI.
// Until an org connects a real EHR, the `demo` provider serves clearly-labeled
// synthetic encounters so the convert-to-claim workflow is fully testable.

const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired, requireProduct } = require('../auth');
const { PROVIDERS, syncEncounters } = require('../ehr/providers');
const athena = require('../ehr/athenahealth');
const { convertEncounter } = require('../ehr/convert');

const router = express.Router();

// GET /api/ehr/athena/callback — PUBLIC. athenahealth redirects the practice
// admin's browser here after authorization. The org is identified by the
// `state` we generated in /athena/authorize, so no session is required.
router.get('/athena/callback', async (req, res) => {
  const page = (title, body, ok) => res.send(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;` +
    `align-items:center;justify-content:center;min-height:100vh;margin:0}.card{max-width:480px;background:#1e293b;` +
    `border-radius:16px;padding:32px;text-align:center}.ok{color:#34d399}.err{color:#fb7185}` +
    `a{color:#34d399}</style></head><body><div class="card">` +
    `<h2 class="${ok ? 'ok' : 'err'}">${title}</h2><p>${body}</p>` +
    `<p><a href="/app">Return to ClaimPaid → open the EHR page</a></p>` +
    `</div></body></html>`);
  try {
    if (req.query.error) throw new Error(`Authorization ${req.query.error}: ${req.query.error_description || 'the request was not approved'}.`);
    const { code, state } = req.query;
    if (!code || !state) throw new Error('Missing authorization code — please start the connect flow again from the EHR page.');
    const conn = db.prepare(`SELECT * FROM ehr_connections WHERE provider='athenahealth' AND oauth_state = ?`).get(state);
    if (!conn) throw new Error('Unknown authorization session — please start the connect flow again from the EHR page.');
    const orgRow = db.prepare(
      `SELECT id, ehr_athena_client_id, ehr_athena_client_secret, ehr_athena_env, ehr_athena_practice_id FROM orgs WHERE id = ?`
    ).get(conn.org_id) || {};
    const { env, token } = await athena.exchangeCode(orgRow, code);
    db.prepare(`UPDATE ehr_connections SET
        status='connected', access_token=?, refresh_token=?, token_expires_at=?,
        practice_id=COALESCE(?, practice_id), auth_mode='3legged',
        oauth_state=NULL, last_error=NULL, updated_at=datetime('now')
      WHERE id = ?`).run(
      token.access_token, token.refresh_token || null,
      new Date(Date.now() + (token.expires_in || 3600) * 1000).toISOString(),
      orgRow.ehr_athena_practice_id || null, conn.id);
    page('athenahealth connected', `This workspace is now connected to athenahealth (${env}). Use “Sync now” on the EHR page to pull encounters.`, true);
  } catch (e) {
    page('Connection failed', String(e.message || e).replace(/</g, '&lt;'), false);
  }
});

router.use(authRequired, requireProduct('rcm'));
const canWrite = roleRequired('owner', 'biller');

const CONN_PUBLIC_COLS = 'id, org_id, provider, status, practice_id, auth_mode, auto_convert, last_sync_at, last_error, created_at, updated_at';

function orgEhrRow(orgId) {
  return db.prepare(
    `SELECT id, ehr_athena_client_id, ehr_athena_client_secret, ehr_athena_env, ehr_athena_practice_id
     FROM orgs WHERE id = ?`
  ).get(orgId) || {};
}

// ---- connections ------------------------------------------------------------

// GET /api/ehr/connections — org-scoped; tokens are NEVER exposed.
router.get('/connections', (req, res) => {
  const rows = db.prepare(`SELECT ${CONN_PUBLIC_COLS} FROM ehr_connections WHERE org_id = ? ORDER BY provider`).all(req.orgId);
  const orgRow = orgEhrRow(req.orgId);
  const envClientId = !!(process.env.ATHENA_CLIENT_ID || orgRow.ehr_athena_client_id);
  res.json({
    connections: rows,
    athena_configured: envClientId,
    athena_env: (process.env.ATHENA_ENV || orgRow.ehr_athena_env || 'preview'),
  });
});

// POST /api/ehr/connect { provider: 'demo' } — any org member.
// athenahealth connects via the OAuth authorize flow below, not here.
router.post('/connect', (req, res) => {
  const provider = (req.body?.provider || '').trim();
  if (provider === 'athenahealth') {
    return res.status(400).json({ error: 'athenahealth connects via OAuth — use the Connect button to start the authorization flow.' });
  }
  if (provider !== 'demo') {
    return res.status(400).json({ error: `Unknown EHR provider: ${provider || '(none)'}. Available: ${PROVIDERS.join(', ')}` });
  }
  db.prepare(`
    INSERT INTO ehr_connections (org_id, provider, status, auth_mode, updated_at)
    VALUES (?, 'demo', 'connected', 'demo', datetime('now'))
    ON CONFLICT(org_id, provider) DO UPDATE SET status='connected', last_error=NULL, updated_at=datetime('now')
  `).run(req.orgId);
  res.json({ ok: true, provider: 'demo' });
});

// GET /api/ehr/athena/authorize — owner-only; starts 3-legged OAuth.
router.get('/athena/authorize', roleRequired('owner'), (req, res) => {
  try {
    const state = athena.newOauthState();
    const url = athena.authorizeUrl(orgEhrRow(req.orgId), state);
    db.prepare(`
      INSERT INTO ehr_connections (org_id, provider, status, oauth_state, updated_at)
      VALUES (?, 'athenahealth', 'disconnected', ?, datetime('now'))
      ON CONFLICT(org_id, provider) DO UPDATE SET oauth_state=excluded.oauth_state, updated_at=datetime('now')
    `).run(req.orgId, state);
    res.json({ authorize_url: url });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---- athena app config (owner-only; env ATHENA_CLIENT_ID/SECRET preferred) --

router.get('/athena/config', roleRequired('owner'), (req, res) => {
  const o = orgEhrRow(req.orgId);
  res.json({
    env: o.ehr_athena_env || 'preview',
    practice_id: o.ehr_athena_practice_id || '',
    client_id: o.ehr_athena_client_id ? '••••••••' : '',
    client_id_set: !!o.ehr_athena_client_id,
    env_provides_id: !!process.env.ATHENA_CLIENT_ID,
    env_provides_secret: !!process.env.ATHENA_CLIENT_SECRET,
    redirect_uri: (process.env.ATHENA_REDIRECT_URI || 'https://claimpaid.io/api/ehr/athena/callback'),
  });
});

router.put('/athena/config', roleRequired('owner'), (req, res) => {
  const { env, practice_id, client_id, client_secret } = req.body || {};
  if (env !== undefined && !['preview', 'production'].includes(env)) {
    return res.status(400).json({ error: "env must be 'preview' or 'production'" });
  }
  const sets = [], params = [];
  if (env !== undefined) { sets.push('ehr_athena_env = ?'); params.push(env); }
  if (practice_id !== undefined) { sets.push('ehr_athena_practice_id = ?'); params.push(String(practice_id).trim() || null); }
  if (client_id) { sets.push('ehr_athena_client_id = ?'); params.push(String(client_id).trim()); }
  if (client_secret) { sets.push('ehr_athena_client_secret = ?'); params.push(String(client_secret)); }
  if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.orgId);
  db.prepare(`UPDATE orgs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

// POST /api/ehr/disconnect { provider } — owner-only.
router.post('/disconnect', roleRequired('owner'), (req, res) => {
  const provider = (req.body?.provider || '').trim();
  const row = db.prepare('SELECT id FROM ehr_connections WHERE org_id = ? AND provider = ?').get(req.orgId, provider);
  if (!row) return res.status(404).json({ error: 'No such EHR connection' });
  // Wipe tokens on disconnect — a reconnect starts clean.
  db.prepare(`UPDATE ehr_connections
    SET status='disconnected', access_token=NULL, refresh_token=NULL,
        token_expires_at=NULL, oauth_state=NULL, last_error=NULL, updated_at=datetime('now')
    WHERE id = ?`).run(row.id);
  res.json({ ok: true });
});

// ---- sync + auto-pull -------------------------------------------------------
//
// runSyncForOrg pulls new encounters for every connected provider, then —
// for connections with auto_convert on — turns every still-'new' encounter
// into a claim draft automatically (deploy #42). Synced encounters are
// completed visits only (athena sync filters to checked-out appointments),
// so a closed encounter landing in the inbox and becoming a draft is the
// same event. Held encounters keep their reason in convert_note and are
// retried on the next sync. Shared by the manual route and the scheduler.
async function runSyncForOrg(orgId, userId) {
  const orgRow = orgEhrRow(orgId);
  const conns = db.prepare(`SELECT * FROM ehr_connections WHERE org_id = ? AND status = 'connected'`).all(orgId);
  const summary = { synced: [], errors: [] };
  for (const conn of conns) {
    try {
      const since = conn.last_sync_at ? conn.last_sync_at.slice(0, 10) : null;
      const { encounters, errors, tokenUpdate } = await syncEncounters(conn, orgRow, since);
      let added = 0;
      const ins = db.prepare(`
        INSERT OR IGNORE INTO ehr_encounters
          (org_id, connection_id, ehr_encounter_id, ehr_patient_id, patient_first, patient_last,
           patient_dob, payer_name, date_of_service, cpt_codes, icd_codes, rendering_provider, raw_payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const e of encounters) {
        const r = ins.run(orgId, conn.id, e.ehr_encounter_id, e.ehr_patient_id || null,
          e.patient_first || '', e.patient_last || '', e.patient_dob || null, e.payer_name || null,
          e.date_of_service || null, JSON.stringify(e.cpt_codes || []), JSON.stringify(e.icd_codes || []),
          e.rendering_provider || null, e.raw_payload ? JSON.stringify(e.raw_payload) : null);
        if (r.changes) added++;
      }
      const upd = { last_sync_at: new Date().toISOString(), status: 'connected', last_error: errors.length ? errors.slice(0, 3).join(' | ') : null };
      if (tokenUpdate) Object.assign(upd, tokenUpdate);
      db.prepare(`UPDATE ehr_connections SET
          last_sync_at = ?, status = ?, last_error = ?,
          access_token = COALESCE(?, access_token), refresh_token = COALESCE(?, refresh_token),
          token_expires_at = COALESCE(?, token_expires_at), updated_at = datetime('now')
        WHERE id = ?`).run(upd.last_sync_at, upd.status, upd.last_error,
        tokenUpdate?.access_token || null, tokenUpdate?.refresh_token || null, tokenUpdate?.token_expires_at || null, conn.id);

      // Auto-pull: convert every open encounter on this connection.
      let autoCreated = 0;
      const autoFailed = [];
      if (conn.auto_convert) {
        const open = db.prepare(`
          SELECT * FROM ehr_encounters WHERE org_id = ? AND connection_id = ? AND status = 'new'
          ORDER BY id ASC LIMIT 200
        `).all(orgId, conn.id);
        for (const enc of open) {
          const r = convertEncounter(orgId, userId, enc, { auto: true });
          if (r.ok) autoCreated++;
          else if (autoFailed.length < 10) {
            autoFailed.push({ encounter_id: enc.id, patient: `${enc.patient_first || ''} ${enc.patient_last || ''}`.trim(), reason: r.error });
          }
        }
      }
      summary.synced.push({ provider: conn.provider, new_encounters: added, seen: encounters.length, auto_created: autoCreated, auto_failed: autoFailed });
      if (errors.length) summary.errors.push({ provider: conn.provider, errors: errors.slice(0, 5) });
    } catch (e) {
      db.prepare(`UPDATE ehr_connections SET status='error', last_error=?, updated_at=datetime('now') WHERE id = ?`)
        .run(e.message.slice(0, 500), conn.id);
      summary.errors.push({ provider: conn.provider, errors: [e.message] });
    }
  }
  return summary;
}

// POST /api/ehr/sync — owner/biller; pulls new encounters (+ auto-pull).
router.post('/sync', canWrite, async (req, res) => {
  const any = db.prepare(`SELECT COUNT(*) AS n FROM ehr_connections WHERE org_id = ? AND status = 'connected'`).get(req.orgId);
  if (!any.n) return res.status(400).json({ error: 'No connected EHR — connect the demo EHR or athenahealth first.' });
  res.json(await runSyncForOrg(req.orgId, req.user.id));
});

// POST /api/ehr/auto-convert { provider, enabled } — owner-only toggle.
router.post('/auto-convert', roleRequired('owner'), (req, res) => {
  const provider = (req.body?.provider || '').trim();
  if (!PROVIDERS.includes(provider)) return res.status(400).json({ error: `Unknown EHR provider: ${provider || '(none)'}` });
  const enabled = req.body?.enabled ? 1 : 0;
  const row = db.prepare('SELECT id FROM ehr_connections WHERE org_id = ? AND provider = ?').get(req.orgId, provider);
  if (!row) return res.status(404).json({ error: 'No such EHR connection' });
  db.prepare(`UPDATE ehr_connections SET auto_convert = ?, updated_at = datetime('now') WHERE id = ?`).run(enabled, row.id);
  res.json({ ok: true, provider, auto_convert: enabled });
});

// ---- encounter inbox --------------------------------------------------------

function parseEncounter(row) {
  return {
    ...row,
    cpt_codes: safeJson(row.cpt_codes),
    icd_codes: safeJson(row.icd_codes),
    raw_payload: row.raw_payload ? safeJson(row.raw_payload, true) : null,
  };
}
function safeJson(s, asObj = false) {
  try { const v = JSON.parse(s || (asObj ? '{}' : '[]')); return v ?? (asObj ? {} : []); }
  catch { return asObj ? {} : []; }
}

// GET /api/ehr/encounters?status=new — org-scoped inbox.
router.get('/encounters', (req, res) => {
  const status = (req.query.status || 'new').trim();
  if (!['new', 'converted', 'ignored'].includes(status)) return res.status(400).json({ error: 'Invalid status filter' });
  const rows = db.prepare(`
    SELECT e.*, c.provider AS connection_provider
    FROM ehr_encounters e JOIN ehr_connections c ON c.id = e.connection_id
    WHERE e.org_id = ? AND e.status = ?
    ORDER BY e.date_of_service DESC, e.id DESC LIMIT 200
  `).all(req.orgId, status).map((r) => {
    const p = parseEncounter(r);
    delete p.raw_payload;
    return p;
  });
  res.json(rows);
});

// GET /api/ehr/encounters/:id — full encounter detail INCLUDING raw_payload
// (the list strips it). Used by the AI code assist to build a coding note.
router.get('/encounters/:id', (req, res) => {
  const row = db.prepare(`
    SELECT e.*, c.provider AS connection_provider
    FROM ehr_encounters e JOIN ehr_connections c ON c.id = e.connection_id
    WHERE e.id = ? AND e.org_id = ?
  `).get(req.params.id, req.orgId);
  if (!row) return res.status(404).json({ error: 'Encounter not found' });
  res.json(parseEncounter(row));
});

// POST /api/ehr/encounters/:id/convert — owner/biller; creates a claim draft
// via the shared converter (same code path as auto-pull).
router.post('/encounters/:id/convert', canWrite, (req, res) => {
  const enc = db.prepare('SELECT * FROM ehr_encounters WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!enc) return res.status(404).json({ error: 'Encounter not found' });
  const r = convertEncounter(req.orgId, req.user.id, enc, { auto: false });
  if (!r.ok) {
    if (r.errors) return res.status(400).json({ errors: r.errors });
    return res.status(r.status || 400).json({ error: r.error });
  }
  res.status(201).json({ ok: true, claim_id: r.claim.id, claim_number: r.claim.claim_number });
});

// POST /api/ehr/encounters/:id/ignore — owner/biller.
router.post('/encounters/:id/ignore', canWrite, (req, res) => {
  const enc = db.prepare('SELECT id, status FROM ehr_encounters WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!enc) return res.status(404).json({ error: 'Encounter not found' });
  if (enc.status === 'converted') return res.status(400).json({ error: 'Encounter already converted to a claim' });
  db.prepare(`UPDATE ehr_encounters SET status='ignored' WHERE id = ?`).run(enc.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.runSyncForOrg = runSyncForOrg;
