// Deploy #59 test: FK-safe workspace deletion (schema-discovered sweep),
// org-less login recovery (heal / noOrg gate / create-workspace), and the
// shared user purge behind super-admin delete. Reproduces the 2026-10-26
// production failure: workspace delete 500'd with an FK error and the
// workspace's member could never log in again.
// Run: node deploy/org-delete-test.cjs
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orgdel59-'));
const DB = path.join(TMP, 't.db'); const PORT = 4116;
let passed = 0, failed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log('  ok -', n); } else { failed++; console.log('  FAIL -', n, x !== undefined ? JSON.stringify(x) : ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp(tries = 60) { for (let i = 0; i < tries; i++) { try { const r = await fetch(`http://localhost:${PORT}/api/health`); if (r.ok) return true; } catch {} await sleep(500); } return false; }
async function call(method, p, body, token) {
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, body: j };
}

// Insert one row filling NOT NULL columns generically (ids of FK parents
// passed via overrides).
function seedRow(db, table, overrides = {}) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const names = [], vals = [];
  for (const c of cols) {
    if (c.pk && c.type === 'INTEGER') continue;
    let v;
    if (c.name in overrides) v = overrides[c.name];
    else if (c.dflt_value != null) continue;
    else if (!c.notnull) continue;
    else if (c.name === 'user_id' || c.name.endsWith('_by')) v = overrides.__user;
    else v = c.type.includes('INT') ? 1 : c.type.includes('REAL') ? 1.5 : 'x';
    names.push(c.name); vals.push(v);
  }
  try {
    const info = db.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...vals);
    return Number(info.lastInsertRowid);
  } catch (e) {
    throw new Error(`seed ${table} [${names.join(',')}]: ${e.message}`);
  }
}

(async () => {
  const env = { ...process.env, PORT: String(PORT), DB_PATH: DB, NODE_ENV: 'test', SUPERADMIN_EMAIL: 'owner-a@test.co' };
  const srv = spawn('node', ['src/index.js'], { cwd: path.join(__dirname, '..', 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; srv.stderr.on('data', (d) => { err += d; });
  try {
    check('server up', await waitUp(), err.slice(-300));
    const A = await call('POST', '/api/auth/signup', { name: 'Owner A', email: 'owner-a@test.co', password: 'Test1234!', orgName: 'Org A' });
    const B = await call('POST', '/api/auth/signup', { name: 'Owner B', email: 'owner-b@test.co', password: 'Test1234!', orgName: 'Org B' });
    check('signups ok', !!A.body?.token && !!B.body?.token, { A: A.body, B: B.body });
    const orgA = A.body.user.org_id, orgB = B.body.user.org_id, idA = A.body.user.id;

    // Member G whose ONLY workspace is Org A (mirrors the production Gmail case)
    const G = await call('POST', '/api/auth/signup', { name: 'Gmail Member', email: 'gmail@test.co', password: 'Test1234!', orgName: 'Org G' });
    const idG = G.body.user.id, orgG = G.body.user.org_id;

    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB);
    db.exec('PRAGMA foreign_keys = ON');
    const payerA = db.prepare('SELECT id FROM payers WHERE org_id = ? LIMIT 1').get(orgA).id;
    const U = { __user: idA };
    // Nasty org-scoped rows, incl. every table the old static list missed
    const claimId = seedRow(db, 'claims', { ...U, org_id: orgA, payer_id: payerA });
    seedRow(db, 'claim_activity', { ...U, org_id: orgA, claim_id: claimId, user_id: idA });
    const appealId = seedRow(db, 'appeals', { ...U, org_id: orgA, claim_id: claimId });
    seedRow(db, 'appeal_notes', { appeal_id: appealId, user_id: idA, __user: idA });
    seedRow(db, 'api_keys', { ...U, org_id: orgA, created_by: idA });
    seedRow(db, 'baa_signatures', { ...U, org_id: orgA });
    const connId = seedRow(db, 'ehr_connections', { ...U, org_id: orgA, provider: 'athenahealth' });
    seedRow(db, 'ehr_encounters', { ...U, org_id: orgA, connection_id: connId });
    const stmtId = seedRow(db, 'patient_statements', { ...U, org_id: orgA, created_by: idA });
    seedRow(db, 'statement_lines', { statement_id: stmtId, claim_id: claimId, __user: idA });
    seedRow(db, 'transmission_outbox', { ...U, org_id: orgA });
    seedRow(db, 'coding_jobs', { ...U, org_id: orgA, created_by: idA });
    seedRow(db, 'claim_batches', { ...U, org_id: orgA, created_by: idA });
    const eraId = seedRow(db, 'era_remittances', { ...U, org_id: orgA, uploaded_by: idA });
    seedRow(db, 'era_claim_lines', { ...U, org_id: orgA, remittance_id: eraId, posted_by: idA });
    // G belongs only to Org A now, with user-referencing rows that used to FK-block deletion
    db.prepare('DELETE FROM user_orgs WHERE user_id = ?').run(idG);
    db.prepare('UPDATE users SET org_id = ? WHERE id = ?').run(orgA, idG);
    db.prepare('DELETE FROM payer_filing_rules WHERE org_id = ?').run(orgG);
    db.prepare('DELETE FROM payers WHERE org_id = ?').run(orgG);
    db.prepare('DELETE FROM orgs WHERE id = ?').run(orgG);
    db.prepare('INSERT INTO user_orgs (user_id, org_id, role) VALUES (?, ?, ?)').run(idG, orgA, 'biller');
    seedRow(db, 'password_resets', { user_id: idG, __user: idG });
    seedRow(db, 'auth_events', { user_id: idG, __user: idG });
    seedRow(db, 'mfa_codes', { user_id: idG, __user: idG });
    db.close();

    // THE DELETE — the exact call that 500'd in production
    const del = await call('DELETE', `/api/auth/orgs/${orgA}`, null, A.body.token);
    check('workspace delete returns 200 (no FK 500)', del.status === 200 && del.body?.deleted === true, del);

    const db2 = new DatabaseSync(DB, { readOnly: true });
    const tables = db2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
    let dangling = [];
    for (const t of tables) {
      if (t === 'users') continue; // home-org pointer of org-less users is healed by the auth layer, not swept
      const cols = db2.prepare(`PRAGMA table_info(${t})`).all();
      if (cols.some((c) => c.name === 'org_id')) {
        const n = db2.prepare(`SELECT COUNT(*) c FROM ${t} WHERE org_id = ?`).get(orgA).c;
        if (n > 0) dangling.push(`${t}:${n}`);
      }
    }
    check('no org-scoped rows left for deleted org', dangling.length === 0, dangling);
    check('appeal_notes swept via parent', db2.prepare('SELECT COUNT(*) c FROM appeal_notes WHERE appeal_id = ?').get(appealId).c === 0);
    check('statement_lines swept via parent', db2.prepare('SELECT COUNT(*) c FROM statement_lines WHERE statement_id = ?').get(stmtId).c === 0);
    check('org B untouched', !!db2.prepare('SELECT id FROM orgs WHERE id = ?').get(orgB)
      && db2.prepare('SELECT COUNT(*) c FROM payers WHERE org_id = ?').get(orgB).c > 0);
    check('both users survive org-less (logins NOT deleted)', !!db2.prepare('SELECT id FROM users WHERE id = ?').get(idA)
      && !!db2.prepare('SELECT id FROM users WHERE id = ?').get(idG));
    db2.close();

    // Org-less recovery: G logs in and is routed to workspace creation
    const login = await call('POST', '/api/auth/login', { email: 'gmail@test.co', password: 'Test1234!' });
    check('org-less user can log in', login.status === 200 && !!login.body?.token, login);
    const tokG = login.body.token;
    check('/me works org-less (no 401 loop)', (await call('GET', '/api/auth/me', null, tokG)).status === 200);
    const st = await call('GET', '/api/onboarding/status', null, tokG);
    check('onboarding status flags noOrg', st.body?.needed === true && st.body?.noOrg === true, st.body);
    const blocked = await call('GET', '/api/claims', null, tokG);
    check('business routes blocked with noOrg 403 (not 401/500)', blocked.status === 403 && blocked.body?.noOrg === true, blocked);
    const created = await call('POST', '/api/auth/orgs', { name: 'G New Co' }, tokG);
    check('org-less user can create a workspace', created.status === 201 && !!created.body?.id, created);
    const sw = await call('POST', '/api/auth/switch', { org_id: created.body.id }, tokG);
    check('switch into new workspace', sw.status === 200 && !!sw.body?.token, sw);
    const me2 = await call('GET', '/api/auth/me', null, sw.body.token);
    check('/me lands in the new workspace', me2.body?.orgName === 'G New Co', me2.body);
    const st2 = await call('GET', '/api/onboarding/status', null, sw.body.token);
    check('onboarding continues normally in new workspace', st2.body?.needed === true && !st2.body?.noOrg, st2.body);

    // Shared purge behind super-admin user delete (refactor regression check).
    // The last-owner guard requires deleting the workspace first — which also
    // exercises deleteOrg from the super-admin path.
    const victim = await call('POST', '/api/auth/signup', { name: 'Vic Tim', email: 'vic@test.co', password: 'Test1234!', orgName: 'Vic Co' });
    const orgDel = await call('DELETE', `/api/super/orgs/${victim.body.user.org_id}`, null, A.body.token);
    check('super org delete works', orgDel.status === 200 && orgDel.body?.deleted === true, orgDel);
    const purge = await call('DELETE', `/api/super/users/${victim.body.user.id}`, null, A.body.token);
    check('super user delete still works (shared purge)', purge.status === 200 && purge.body?.deleted === true, purge);
    check('purged user cannot log in', (await call('POST', '/api/auth/login', { email: 'vic@test.co', password: 'Test1234!' })).status === 401);
  } catch (e) {
    failed++; console.log('  FAIL - exception:', e.stack || e.message);
  } finally {
    srv.kill();
    await sleep(300);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
