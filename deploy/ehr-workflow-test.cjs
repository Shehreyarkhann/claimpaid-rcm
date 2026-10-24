// ehr-workflow-test.cjs — deploy #46 verification: the COMPLETE EHR workflow
// exactly as a user walks it:
//   connect demo EHR → sync → inbox → manual convert → draft opens →
//   manually complete the draft (amounts/codes via the claim editor's API) →
//   ignore → convert blocked → restore (un-ignore) → convert succeeds →
//   auto-pull converts the rest → double-convert blocked.
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

  // The org's payer list (demo encounters bill these names).
  for (const name of ['Aetna', 'Cigna', 'UnitedHealthcare', 'Anthem', 'Medicare', 'Humana']) {
    await api('POST', '/api/claims/meta/payers', { name, type: 'Commercial' }, t);
  }

  const conn = await api('POST', '/api/ehr/connect', { provider: 'demo' }, t);
  check('demo EHR connected', conn.status === 200, JSON.stringify(conn.data));

  // Auto-pull OFF first: stage only, so we can walk the manual path.
  const off = await api('POST', '/api/ehr/auto-convert', { provider: 'demo', enabled: false }, t);
  check('auto-pull off', off.status === 200 && off.data.auto_convert === 0, JSON.stringify(off.data));

  const sync1 = await api('POST', '/api/ehr/sync', null, t);
  const sx = (sync1.data.synced || [])[0] || {};
  check('sync staged encounters, none auto-created', sync1.status === 200 && sx.new_encounters > 0 && !sx.auto_created, JSON.stringify(sync1.data).slice(0, 200));

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

  // --- Auto-pull converts the rest on the next sync ---
  const on = await api('POST', '/api/ehr/auto-convert', { provider: 'demo', enabled: true }, t);
  check('auto-pull back on', on.status === 200 && on.data.auto_convert === 1, JSON.stringify(on.data));
  const sync2 = await api('POST', '/api/ehr/sync', null, t);
  const sx2 = (sync2.data.synced || [])[0] || {};
  const stillNew = await listEncs('new');
  check('auto-pull left no convertible encounters behind', stillNew.length === 0, `still new: ${stillNew.length}, sync=${JSON.stringify(sx2).slice(0, 160)}`);
  const autoMade = (await listEncs('converted')).filter((e) => e.auto_created);
  check('auto-created drafts are flagged', autoMade.length > 0, `auto=${autoMade.length}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  server.kill();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); if (server) server.kill(); process.exit(1); });
