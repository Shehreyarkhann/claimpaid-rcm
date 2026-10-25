// ehr-workflow-test.cjs — deploy #46 verification (reworked in #52 after the
// demo EHR provider was removed): the COMPLETE EHR workflow exactly as a
// user walks it. Encounters are staged directly in the test DB under an
// athenahealth connection (the athena transport itself is covered by the
// athena-* suites); everything downstream is exercised over HTTP:
//   inbox → manual convert → draft opens → manually complete the draft →
//   ignore → convert blocked → restore (un-ignore) → convert succeeds →
//   auto-convert converts the rest (production convertEncounter, auto mode)
//   → double-convert blocked.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 4108;
const BASE = `http://localhost:${PORT}`;
const TMP = '/tmp/ehr-workflow-test';
const DB = path.join(TMP, 'test.db');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server;
async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

(async () => {
  server = spawn('node', ['src/index.js'], {
    cwd: path.join(__dirname, '..', 'server'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret', EHR_AUTOPULL: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch { /* wait */ }
    await sleep(500);
  }

  const s = await api('POST', '/api/auth/signup', { orgName: 'Workflow Org', name: 'Owner', email: 'wf@test.co', password: 'Test1234!' });
  check('signup', s.status === 201, JSON.stringify(s.data));
  const t = s.data.token;

  // The org's payer list (staged encounters bill these names).
  for (const name of ['Aetna', 'Cigna', 'UnitedHealthcare', 'Anthem', 'Medicare', 'Humana']) {
    await api('POST', '/api/claims/meta/payers', { name, type: 'Commercial' }, t);
  }

  // Demo connect is gone (#52): the endpoint now refuses it.
  const connDemo = await api('POST', '/api/ehr/connect', { provider: 'demo' }, t);
  check('demo EHR connect refused', connDemo.status === 400, JSON.stringify(connDemo.data));

  // Stage an athenahealth connection + encounters directly in the test DB.
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(DB);
  raw.exec('PRAGMA busy_timeout = 5000');
  const orgRow = raw.prepare("SELECT id FROM orgs WHERE name = 'Workflow Org'").get();
  const orgId = orgRow.id;
  const connId = Number(raw.prepare(`INSERT INTO ehr_connections (org_id, provider, status, auth_mode, auto_convert, updated_at)
               VALUES (?, 'athenahealth', 'connected', '2legged', 0, datetime('now'))`).run(orgId).lastInsertRowid);
  const insEnc = raw.prepare(`INSERT INTO ehr_encounters
    (org_id, connection_id, ehr_encounter_id, ehr_patient_id, patient_first, patient_last,
     patient_dob, payer_name, date_of_service, cpt_codes, icd_codes, rendering_provider, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`);
  const visits = [
    ['ENC-1', 'PAT-1', 'Alice', 'Patient', '1985-03-12', 'Aetna', '2026-10-20', '99213', 'M54.5'],
    ['ENC-2', 'PAT-2', 'Bob', 'Holder', '1980-06-20', 'Cigna', '2026-10-21', '99214', 'E11.9'],
    ['ENC-3', 'PAT-3', 'Carol', 'Patient', '2012-03-15', 'Aetna', '2026-10-22', '99213', 'J06.9'],
    ['ENC-4', 'PAT-4', 'Dan', 'Smith', '1975-01-30', 'Humana', '2026-10-23', '99212', 'I10'],
  ];
  for (const v of visits) {
    insEnc.run(orgId, connId, v[0], v[1], v[2], v[3], v[4], v[5], v[6], JSON.stringify([v[7]]), JSON.stringify([v[8]]), 'Jane Provider');
  }
  check('staged 4 encounters in DB', raw.prepare('SELECT COUNT(*) AS n FROM ehr_encounters WHERE org_id = ?').get(orgId).n === 4);

  // Auto-pull toggle exists for the athena connection (starts OFF via insert).
  const off = await api('POST', '/api/ehr/auto-convert', { provider: 'athenahealth', enabled: false }, t);
  check('auto-pull off', off.status === 200 && off.data.auto_convert === 0, JSON.stringify(off.data));

  const listEncs = async (status) => {
    const d = (await api('GET', `/api/ehr/encounters?status=${status}`, null, t)).data;
    return Array.isArray(d) ? d : (d.encounters || []);
  };
  let encs = await listEncs('new');
  check('inbox lists staged encounters as new', encs.length > 0 && encs.every((e) => e.status === 'new'), `n=${encs.length}`);
  const enc = encs[0];

  // --- Manual convert ---
  const cv = await api('POST', `/api/ehr/encounters/${enc.id}/convert`, null, t);
  check('manual convert -> 201 with claim number', cv.status === 201 && /^EHR-/.test(cv.data.claim_number || ''), JSON.stringify(cv.data));
  const claimId = cv.data.claim_id;

  encs = await listEncs('converted');
  const encAfter = encs.find((e) => e.id === enc.id);
  check('encounter now converted + linked to claim', encAfter?.status === 'converted' && encAfter?.converted_claim_id === claimId, JSON.stringify(encAfter));

  // --- Draft opens with the visit's data ---
  const claims = (await api('GET', '/api/claims', null, t)).data.claims || (await api('GET', '/api/claims', null, t)).data || [];
  const claim = (Array.isArray(claims) ? claims : []).find((c) => c.id === claimId);
  check('draft visible in Claims with encounter data', !!claim
    && claim.patient_name === `${enc.patient_first} ${enc.patient_last}`
    && claim.service_date === enc.date_of_service
    && Number(claim.billed_amount) === 0,
    JSON.stringify(claim).slice(0, 200));

  // --- Manually complete the draft (the claim editor's update path) ---
  const upd = await api('PUT', `/api/claims/${claimId}`, { billed_amount: 185.5, cpt_codes: '99213', icd_codes: 'M545' }, t);
  check('manual completion saves (amount + codes)', upd.status === 200 && Number(upd.data.billed_amount) === 185.5 && upd.data.cpt_codes === '99213', JSON.stringify(upd.data).slice(0, 200));

  // --- Double-convert blocked ---
  const dup = await api('POST', `/api/ehr/encounters/${enc.id}/convert`, null, t);
  check('double convert blocked', dup.status === 400, `got ${dup.status}`);

  // --- Ignore → convert blocked → restore → convert works ---
  const enc2 = (await listEncs('new'))[0];
  check('a second staged encounter exists', !!enc2);
  const ig = await api('POST', `/api/ehr/encounters/${enc2.id}/ignore`, null, t);
  check('ignore works', ig.status === 200, JSON.stringify(ig.data));
  const blocked = await api('POST', `/api/ehr/encounters/${enc2.id}/convert`, null, t);
  check('convert of ignored is blocked with un-ignore guidance', blocked.status === 400 && /un-ignore/i.test(blocked.data.error || ''), JSON.stringify(blocked.data));
  const un = await api('POST', `/api/ehr/encounters/${enc2.id}/unignore`, null, t);
  check('un-ignore (Restore) works', un.status === 200, JSON.stringify(un.data));
  const cv2 = await api('POST', `/api/ehr/encounters/${enc2.id}/convert`, null, t);
  check('convert after restore succeeds', cv2.status === 201, JSON.stringify(cv2.data));

  // --- Auto-convert converts the rest (the sync path's production code) ---
  const on = await api('POST', '/api/ehr/auto-convert', { provider: 'athenahealth', enabled: true }, t);
  check('auto-pull back on', on.status === 200 && on.data.auto_convert === 1, JSON.stringify(on.data));
  process.env.DB_PATH = DB;
  const { db } = require('../server/src/db');
  const { convertEncounter } = require('../server/src/ehr/convert');
  const owner = db.prepare('SELECT id FROM users WHERE email = ?').get('wf@test.co');
  const staged = db.prepare("SELECT * FROM ehr_encounters WHERE org_id = ? AND status = 'new'").all(orgId);
  for (const e of staged) convertEncounter(orgId, owner.id, e, { auto: true });
  const stillNew = await listEncs('new');
  check('auto-convert left no convertible encounters behind', stillNew.length === 0, `still new: ${stillNew.length}`);
  const autoMade = (await listEncs('converted')).filter((e) => e.auto_created);
  check('auto-created drafts are flagged', autoMade.length > 0, `auto=${autoMade.length}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  server.kill();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); if (server) server.kill(); process.exit(1); });
