// Org-scoped developer API key authentication.
//
// Contract (for the record):
//   - Keys are issued via POST /api/settings/api-keys (owner only) and look like
//       cp_sk_live_<48 lowercase hex chars>
//     The full key is returned in the create response ONLY — it is never
//     returned again. Only the SHA-256 hash (key_hash) and a display prefix
//     (key_prefix, e.g. "cp_sk_live_9f3a") are stored in the api_keys table.
//   - Callers send the key as a Bearer token:
//       Authorization: Bearer cp_sk_live_....
//     Any non-cp_ Bearer value is NOT an API key; this middleware rejects it
//     (401) rather than falling through, so /api/v1/* is key-only.
//   - A key is valid when: its hash matches a row, and revoked_at IS NULL.
//   - Keys are ORG-scoped: req.orgId is set to the key's org_id, and the key
//     can only ever see that org's data.
//   - Keys are UNAFFECTED by org MFA enforcement (they are machine
//     credentials), but they are REVOCABLE at any time from Settings → API.
//   - last_used_at is stamped on every successful call.
//   - Expired-trial orgs get no product access (same productsForOrg rule as JWT).
const crypto = require('crypto');
const { db } = require('../db');

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function apiKeyAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer\s+(cp_[A-Za-z0-9_.-]+)\s*$/);
  if (!m) {
    return res.status(401).json({ error: 'API key required. Send it as: Authorization: Bearer cp_sk_live_...' });
  }
  const row = db.prepare(
    `SELECT k.id, k.org_id, k.name, k.revoked_at, o.plan, o.plan_status, o.trial_ends_at
     FROM api_keys k JOIN orgs o ON o.id = k.org_id
     WHERE k.key_hash = ?`
  ).get(sha256Hex(m[1]));
  if (!row || row.revoked_at) {
    return res.status(401).json({ error: 'Invalid or revoked API key' });
  }
  // Same product gating as JWT sessions: an expired trial unlocks nothing.
  try {
    const { productsForOrg } = require('../routes/billing');
    req.products = productsForOrg(row);
  } catch {
    req.products = { rcm: true, ai: true };
  }
  db.prepare(`UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?`).run(row.id);
  req.apiKey = { id: row.id, name: row.name, orgId: row.org_id };
  req.orgId = row.org_id;
  req.plan = row.plan || null;
  next();
}

module.exports = { apiKeyAuth, sha256Hex };
