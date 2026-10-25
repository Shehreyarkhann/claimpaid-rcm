// ehr-autopull-test.cjs — deploy #42 verification, reworked in #52 after
// the demo EHR provider was removed. Proves the auto-pull behavior of the
// production sync function (runSyncForOrg — the same function the HTTP
// sync route and the 15-minute scheduler call):
//  1. an athenahealth connection defaults auto_convert ON
//  2. the sweep auto-creates a claim draft for EVERY staged encounter
//     (incl. the athena-style payer name "Anthem" resolving to the org's
//     "Anthem BCBS" payer)
//  3. an encounter with an unknown payer is HELD with a convert_note, and
//     converts automatically on the next run once the payer is added
//  4. with auto-pull toggled OFF, encounters stay staged; manual convert
//     still works
// Encounters are staged directly in the test DB under an athenahealth
// connection; the athena transport itself is stubbed to return zero new
// appointments (its shapes are covered by the athena-* suites).
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 4106;
const BASE = `http://localhost:${PORT}`;
const TMP = '/tmp/ehr-autopull-test';
const DB = path.join(TMP, 'test.db');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.DB_PATH = DB;

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stub ONLY athena traffic; the HTTP api() helper uses real fetch.
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.includes('athenahealth.com')) return realFetch(url, opts);
  const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (u.includes('/oauth2/')) return json({ access_token: 'tok', expires_in: 3600 });
  if (u.includes('/departments')) return json({ totalcount: 1, departments: [{ departmentid: 1 }] });
  if (u.includes('/appointments')) return json({ totalcount: 0, appointments: [] });
  return { ok: false, status: 404, text: async () => 'not found' };
};

let server;
async function api(method, p, body, token) {
  const res = await realFetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const { DatabaseSync } = require('node:sqlite');
function stage(orgId, connId, rows) {
  const w = new DatabaseSync(DB);
  w.exec('PRAGMA busy_timeout = 5000');
  const ins = w.prepare(`INSERT INTO ehr_encounters
    (org_id, connection_id, ehr_encounter_id, ehr_patient_id, patient_first, patient_last,
     patient_dob, payer_name, date_of_service, cpt_codes, icd_codes, rendering_provider, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`);
  for (const r of rows) ins.run(orgId, connId, ...r);
  w.close();
}
function connectAthena(orgId, { autoConvert } = {}) {
  const w = new DatabaseSync(DB);
  w.exec('PRAGMA busy_timeout = 5000');
  w.prepare("UPDATE orgs SET ehr_athena_client_id = 'cid', ehr_athena_client_secret = 'sec', ehr_athena_practice_id = '195900', ehr_athena_env = 'preview' WHERE id = ?").run(orgId);
  const cols = autoConvert === undefined
    ? `(org_id, provider, status, auth_mode, updated_at) VALUES (?, 'athenahealth', 'connected', '2legged', datetime('now'))`
    : `(org_id, provider, status, auth_mode, auto_convert, updated_at) VALUES (?, 'athenahealth', 'connected', '2legged', ${autoConvert}, datetime('now'))`;
  const id = Number(w.prepare(`INSERT INTO ehr_connections ${cols}`).run(orgId).lastInsertRowid);
  w.close();
  return id;
}

(async () => {
  server = spawn('node', ['src/index.js'], {
    cwd: path.join(__dirname, '..', 'server'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret', EHR_AUTOPULL: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 60; i++) {
    try { const r = await realFetch(BASE + '/api/health'); if (r.ok) break; } catch { /* wait */ }
    await sleep(500);
  }
  const { runSyncForOrg } = require('../server/src/routes/ehr');
  const { db } = require('../server/src/db');

  // ---- org 1: auto-pull ON by default -------------------------------------
  const s1 = await api('POST', '/api/auth/signup', { email: 'auto1@test.co', password: 'Test1234!', name: 'Auto One', orgName: 'Auto Org One' });
  check('org1 signup', s1.status === 201, JSON.stringify(s1.data));
  const t1 = s1.data.token;
  const org1 = db.prepare("SELECT id FROM orgs WHERE name = 'Auto Org One'").get().id;
  const user1 = db.prepare("SELECT id FROM users WHERE email = 'auto1@test.co'").get().id;
  const conn1 = connectAthena(org1); // auto_convert omitted -> column default
  const conns1 = await api('GET', '/api/ehr/connections', null, t1);
  const ath1 = (conns1.data.connections || []).find((c) => c.provider === 'athenahealth');
  check('athena connection listed', !!ath1, JSON.stringify(conns1.data).slice(0, 160));
  check('auto_convert defaults ON', !!ath1 && ath1.auto_convert === 1, JSON.stringify(ath1));

  const dos = new Date().toISOString().slice(0, 10);
  stage(org1, conn1, [
    ['AP-1', 'PT-1', 'Alice', 'A', '1985-03-12', 'Aetna', dos, '["99213"]', '["M54.5"]', 'Jane Provider'],
    ['AP-2', 'PT-2', 'Bob', 'B', '1980-06-20', 'Cigna', dos, '["99214"]', '["E11.9"]', 'Jane Provider'],
    ['AP-3', 'PT-3', 'Carol', 'C', '2012-03-15', 'Anthem', dos, '["99213"]', '["J06.9"]', 'Jane Provider'],
    ['AP-4', 'PT-4', 'Dan', 'D', '1975-01-30', 'Medicare', dos, '["99212"]', '["I10"]', 'Jane Provider'],
    ['AP-5', 'PT-5', 'Erin', 'E', '1990-11-05', 'Humana', dos, '["99213"]', '["Z00.00"]', 'Jane Provider'],
    ['AP-6', 'PT-6', 'Frank', 'F', '1968-08-25', 'UnitedHealthcare', dos, '["99214"]', '["M17.11"]', 'Jane Provider'],
  ]);
  const sync1 = await runSyncForOrg(org1, user1);
  const sum1 = (sync1.synced || [])[0] || {};
  check('sweep ran on the athena connection', sync1.synced.length === 1 && sum1.provider === 'athenahealth', JSON.stringify(sync1).slice(0, 200));
  check('every staged encounter auto-created a draft', sum1.auto_created === 6, JSON.stringify(sum1));
  check('no auto failures (Anthem resolved to Anthem BCBS)', (sum1.auto_failed || []).length === 0, JSON.stringify(sum1.auto_failed));
  const converted1 = await api('GET', '/api/ehr/encounters?status=converted', null, t1);
  check('converted inbox matches', converted1.data.length === 6, `got ${converted1.data.length}`);
  check('converted rows flagged auto_created', converted1.data.every((e) => e.auto_created === 1 && e.converted_claim_id));
  const claim = await api('GET', `/api/claims/${converted1.data[0].converted_claim_id}`, null, t1);
  check('draft claim exists with EHR- number', claim.status === 200 && String(claim.data.claim_number || '').startsWith('EHR-'), JSON.stringify(claim.data).slice(0, 200));
  const newAfter = await api('GET', '/api/ehr/encounters?status=new', null, t1);
  check('inbox new is empty after auto-pull', newAfter.data.length === 0, `got ${newAfter.data.length}`);

  // ---- held encounter: unknown payer, then payer added --------------------
  stage(org1, conn1, [
    ['bogus-enc-1', 'PT-9', 'Test', 'Hold', '1990-01-01', 'Bogus Payer LLC', dos, '["99213"]', '["I10"]', 'Jane Provider'],
  ]);
  check('bogus encounter staged', true);
  const sync2 = await runSyncForOrg(org1, user1);
  const sum2 = (sync2.synced || [])[0] || {};
  check('bogus held with reason in summary', (sum2.auto_failed || []).some((f) => /Bogus Payer LLC/.test(f.reason || '')), JSON.stringify(sum2));
  const heldList = await api('GET', '/api/ehr/encounters?status=new', null, t1);
  const held = heldList.data.find((e) => e.ehr_encounter_id === 'bogus-enc-1');
  check('held encounter carries convert_note', !!held && /Bogus Payer/.test(held.convert_note || ''), JSON.stringify(held));
  const addPayer = await api('POST', '/api/claims/meta/payers', { name: 'Bogus Payer LLC', type: 'Commercial' }, t1);
  check('payer added', addPayer.status === 201, JSON.stringify(addPayer.data));
  const sync3 = await runSyncForOrg(org1, user1);
  const sum3 = (sync3.synced || [])[0] || {};
  check('held encounter converts on retry run', sum3.auto_created >= 1, JSON.stringify(sum3));
  const convAfter = await api('GET', '/api/ehr/encounters?status=converted', null, t1);
  const bogusConv = convAfter.data.find((e) => e.ehr_encounter_id === 'bogus-enc-1');
  check('bogus now converted + note cleared', !!bogusConv && bogusConv.convert_note == null && bogusConv.auto_created === 1, JSON.stringify(bogusConv));

  // ---- org 2: auto-pull OFF ----------------------------------------------
  const s2 = await api('POST', '/api/auth/signup', { email: 'auto2@test.co', password: 'Test1234!', name: 'Auto Two', orgName: 'Auto Org Two' });
  const t2 = s2.data.token;
  const org2 = db.prepare("SELECT id FROM orgs WHERE name = 'Auto Org Two'").get().id;
  const user2 = db.prepare("SELECT id FROM users WHERE email = 'auto2@test.co'").get().id;
  const conn2 = connectAthena(org2, { autoConvert: 1 });
  const tog = await api('POST', '/api/ehr/auto-convert', { provider: 'athenahealth', enabled: false }, t2);
  check('toggle off', tog.status === 200 && tog.data.auto_convert === 0, JSON.stringify(tog.data));
  stage(org2, conn2, [
    ['BP-1', 'PT-1', 'Gail', 'G', '1988-02-14', 'Aetna', dos, '["99213"]', '["M54.5"]', 'Jane Provider'],
    ['BP-2', 'PT-2', 'Hank', 'H', '1979-09-09', 'Cigna', dos, '["99214"]', '["E11.9"]', 'Jane Provider'],
    ['BP-3', 'PT-3', 'Iris', 'I', '2001-12-01', 'Aetna', dos, '["99212"]', '["J06.9"]', 'Jane Provider'],
  ]);
  const syncOff = await runSyncForOrg(org2, user2);
  const sumOff = (syncOff.synced || [])[0] || {};
  check('no auto-create with auto-pull off', sumOff.auto_created === 0, JSON.stringify(sumOff));
  const staged = await api('GET', '/api/ehr/encounters?status=new', null, t2);
  check('encounters wait in inbox', staged.data.length === 3, `got ${staged.data.length}`);
  const manual = await api('POST', `/api/ehr/encounters/${staged.data[0].id}/convert`, null, t2);
  check('manual convert still works', manual.status === 201 && !!manual.data.claim_id, JSON.stringify(manual.data));
  const badToggle = await api('POST', '/api/ehr/auto-convert', { provider: 'nope', enabled: true }, t2);
  check('toggle rejects unknown provider', badToggle.status === 400);

  console.log(`\n${passed} passed, ${failed} failed`);
  server.kill();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); if (server) server.kill(); process.exit(1); });
