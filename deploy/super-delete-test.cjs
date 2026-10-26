// Deploy #56 test: super-admin user delete must survive real-world users.
// Pre-fix, DELETE /api/super/users/:id 500s on any user referenced by
// content tables (claims.created_by, audit_log, auth_events, ...) due to
// FK constraints. The delete must succeed, keep the content, drop the
// user's memberships/sessions, and still honor the guards.
// Run: node deploy/super-delete-test.cjs
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'super56-'));
const DB = path.join(TMP, 't.db'); const PORT = 4114;
let passed = 0, failed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log('  ok -', n); } else { failed++; console.log('  FAIL -', n, x !== undefined ? JSON.stringify(x) : ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp(tries = 60) { for (let i = 0; i < tries; i++) { try { const r = await fetch(`http://localhost:${PORT}/api/health`); if (r.ok) return true; } catch {} await sleep(500); } return false; }
async function call(method, p, body, token) {
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, body: j };
}

(async () => {
  const env = { ...process.env, PORT: String(PORT), DB_PATH: DB, NODE_ENV: 'test', SUPERADMIN_EMAIL: 'root56@test.co' };
  const srv = spawn('node', ['src/index.js'], { cwd: path.join(__dirname, '..', 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; srv.stderr.on('data', (d) => { err += d; });
  try {
    check('server up', await waitUp(), err.slice(-300));
    // Super-admin account (email matches SUPERADMIN_EMAIL).
    const root = await call('POST', '/api/auth/signup', { name: 'Root', email: 'root56@test.co', password: 'Test1234!', orgName: 'HQ' });
    const rootTok = root.body?.token;
    check('super-admin gate opens', (await call('GET', '/api/super/overview', null, rootTok)).status === 200);
    // Victim: own workspace (owner) + creates a claim (created_by FK) + audit trail.
    const vic = await call('POST', '/api/auth/signup', { name: 'Vicky Victim', email: 'vicky56@test.co', password: 'Test1234!', orgName: 'Vicky Co' });
    const vicTok = vic.body?.token; const vicId = vic.body?.user?.id;
    const cr = await call('POST', '/api/claims', { claim_number: 'V56-1', patient_name: 'Pat', payer: 'Aetna', service_date: '2026-10-01', billed_amount: 120 }, vicTok);
    check('victim created a claim (FK bait)', cr.status === 201, cr);
    // A second owner joins Vicky Co so the delete isn't blocked by last-owner.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB);
    const orgId = db.prepare('SELECT org_id FROM users WHERE id = ?').get(vicId).org_id;
    const other = await call('POST', '/api/auth/signup', { name: 'Ollie Owner', email: 'ollie56@test.co', password: 'Test1234!', orgName: 'Ollie Co' });
    db.prepare("INSERT OR IGNORE INTO user_orgs (user_id, org_id, role) VALUES (?, ?, 'owner')").run(other.body.user.id, orgId);
    db.close();

    const del = await call('DELETE', `/api/super/users/${vicId}`, null, rootTok);
    check('delete an active, content-owning user succeeds (was 500)', del.status === 200 && del.body?.deleted === true, del);
    check('victim login now fails', (await call('POST', '/api/auth/login', { email: 'vicky56@test.co', password: 'Test1234!' })).status === 401);
    const users = await call('GET', '/api/super/users', null, rootTok);
    check('user gone from the super list', (users.body?.users || users.body || []).every?.((u) => u.id !== vicId) ?? false, users.body);
    const orgDetail = await call('GET', `/api/super/orgs/${orgId}`, null, rootTok);
    check('workspace + its claim survive the delete', orgDetail.status === 200, orgDetail.status);

    // Guards still hold.
    const rootId = root.body?.user?.id;
    check('cannot delete yourself', (await call('DELETE', `/api/super/users/${rootId}`, null, rootTok)).status === 400);
    // Sole-owner org blocks deletion of its only owner.
    const solo = await call('POST', '/api/auth/signup', { name: 'Solo', email: 'solo56@test.co', password: 'Test1234!', orgName: 'Solo Co' });
    const soloDel = await call('DELETE', `/api/super/users/${solo.body.user.id}`, null, rootTok);
    check('last-owner guard still blocks', soloDel.status === 400 && /last owner/i.test(soloDel.body?.error || ''), soloDel);
  } catch (e) {
    console.error('ERROR', e); failed++;
  } finally {
    try { srv.kill(); } catch {}
    await sleep(300);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
