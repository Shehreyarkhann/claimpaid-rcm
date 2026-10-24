// ehr-autopull-test.cjs — deploy #42 verification: EHR auto-pull.
// Boots the server on a scratch DB and proves, through the public API:
//  1. demo EHR connects with auto_convert ON by default
//  2. sync auto-creates a claim draft for EVERY new encounter (incl. the
//     athena-style payer name "Anthem" resolving to org payer "Anthem BCBS")
//  3. an encounter with an unknown payer is HELD with a convert_note, and
//     converts automatically on the next sync once the payer is added
//  4. with auto-pull toggled OFF, sync only stages encounters; manual
//     convert still works
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = 4106;
const BASE = `http://localhost:${PORT}`;
const TMP = '/tmp/ehr-autopull-test';
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

  // ---- org 1: auto-pull ON by default -------------------------------------
  const s1 = await api('POST', '/api/auth/signup', { email: 'auto1@test.co', password: 'Test1234!', name: 'Auto One', orgName: 'Auto Org One' });
  check('org1 signup', s1.status === 201, JSON.stringify(s1.data));
  const t1 = s1.data.token;
  const c1 = await api('POST', '/api/ehr/connect', { provider: 'demo' }, t1);
  check('demo connect', c1.status === 200);
  const conns1 = await api('GET', '/api/ehr/connections', null, t1);
  const demo1 = (conns1.data.connections || []).find((c) => c.provider === 'demo');
  check('auto_convert defaults ON', demo1 && demo1.auto_convert === 1, JSON.stringify(demo1));

  const sync1 = await api('POST', '/api/ehr/sync', null, t1);
  const sum1 = (sync1.data.synced || [])[0] || {};
  check('sync pulled encounters', sync1.status === 200 && sum1.new_encounters >= 6, JSON.stringify(sync1.data));
  check('every encounter auto-created a draft', sum1.auto_created === sum1.new_encounters, JSON.stringify(sum1));
  check('no auto failures', (sum1.auto_failed || []).length === 0, JSON.stringify(sum1.auto_failed));
  const converted1 = await api('GET', '/api/ehr/encounters?status=converted', null, t1);
  check('converted inbox matches', converted1.data.length === sum1.auto_created, `got ${converted1.data.length}`);
  check('converted rows flagged auto_created', converted1.data.every((e) => e.auto_created === 1 && e.converted_claim_id));
  const claim = await api('GET', `/api/claims/${converted1.data[0].converted_claim_id}`, null, t1);
  check('draft claim exists with EHR- number', claim.status === 200 && String(claim.data.claim_number || '').startsWith('EHR-'), JSON.stringify(claim.data).slice(0, 200));
  const newAfter = await api('GET', '/api/ehr/encounters?status=new', null, t1);
  check('inbox new is empty after auto-pull', newAfter.data.length === 0, `got ${newAfter.data.length}`);

  // ---- held encounter: unknown payer, then payer added --------------------
  const orgId = demo1.org_id;
  const dos = new Date().toISOString().slice(0, 10);
  let inserted = false;
  for (let i = 0; i < 12 && !inserted; i++) {
    try {
      const w = new DatabaseSync(DB);
      w.prepare(`INSERT INTO ehr_encounters (org_id, connection_id, ehr_encounter_id, patient_first, patient_last, payer_name, date_of_service, cpt_codes, icd_codes)
        VALUES (?, ?, 'bogus-enc-1', 'Test', 'Hold', 'Bogus Payer LLC', ?, '["99213"]', '["I10"]')`).run(orgId, demo1.id, dos);
      w.close();
      inserted = true;
    } catch { await sleep(300); }
  }
  check('bogus encounter staged', inserted);
  const sync2 = await api('POST', '/api/ehr/sync', null, t1);
  const sum2 = (sync2.data.synced || [])[0] || {};
  check('bogus held with reason in summary', (sum2.auto_failed || []).some((f) => /Bogus Payer LLC/.test(f.reason || '')), JSON.stringify(sum2));
  const heldList = await api('GET', '/api/ehr/encounters?status=new', null, t1);
  const held = heldList.data.find((e) => e.ehr_encounter_id === 'bogus-enc-1');
  check('held encounter carries convert_note', !!held && /Bogus Payer/.test(held.convert_note || ''), JSON.stringify(held));
  const addPayer = await api('POST', '/api/claims/meta/payers', { name: 'Bogus Payer LLC', type: 'Commercial' }, t1);
  check('payer added', addPayer.status === 201, JSON.stringify(addPayer.data));
  const sync3 = await api('POST', '/api/ehr/sync', null, t1);
  const sum3 = (sync3.data.synced || [])[0] || {};
  check('held encounter converts on retry sync', sum3.auto_created >= 1, JSON.stringify(sum3));
  const convAfter = await api('GET', '/api/ehr/encounters?status=converted', null, t1);
  const bogusConv = convAfter.data.find((e) => e.ehr_encounter_id === 'bogus-enc-1');
  check('bogus now converted + note cleared', !!bogusConv && bogusConv.convert_note == null && bogusConv.auto_created === 1, JSON.stringify(bogusConv));

  // ---- org 2: auto-pull OFF ----------------------------------------------
  const s2 = await api('POST', '/api/auth/signup', { email: 'auto2@test.co', password: 'Test1234!', name: 'Auto Two', orgName: 'Auto Org Two' });
  const t2 = s2.data.token;
  await api('POST', '/api/ehr/connect', { provider: 'demo' }, t2);
  const tog = await api('POST', '/api/ehr/auto-convert', { provider: 'demo', enabled: false }, t2);
  check('toggle off', tog.status === 200 && tog.data.auto_convert === 0, JSON.stringify(tog.data));
  const syncOff = await api('POST', '/api/ehr/sync', null, t2);
  const sumOff = (syncOff.data.synced || [])[0] || {};
  check('sync stages encounters with auto-pull off', sumOff.new_encounters >= 6 && sumOff.auto_created === 0, JSON.stringify(sumOff));
  const staged = await api('GET', '/api/ehr/encounters?status=new', null, t2);
  check('encounters wait in inbox', staged.data.length === sumOff.new_encounters, `got ${staged.data.length}`);
  const manual = await api('POST', `/api/ehr/encounters/${staged.data[0].id}/convert`, null, t2);
  check('manual convert still works', manual.status === 201 && !!manual.data.claim_id, JSON.stringify(manual.data));
  const badToggle = await api('POST', '/api/ehr/auto-convert', { provider: 'nope', enabled: true }, t2);
  check('toggle rejects unknown provider', badToggle.status === 400);

  console.log(`\n${passed} passed, ${failed} failed`);
  server.kill();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); if (server) server.kill(); process.exit(1); });
