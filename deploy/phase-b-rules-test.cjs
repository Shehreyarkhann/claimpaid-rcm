// phase-b-rules-test.cjs — Phase B (Commure parity): Denial Copilot rules.
//   1. one-click rule from a denial (append_modifier), dedupe on repeat
//   2. scrub preview COMPUTES the fix but does not apply it
//   3. scrub run APPLIES the fix (cpt_codes rewritten), logs the
//      application, counts the hit
//   4. second scrub: modifier already present -> no duplicate fix
//   5. flag rules still flag (issue, hit counted, no application row)
//   6. toggle off -> rule stops matching
//   7. validation: bad modifier / append without CPT -> 400
//   8. agent propose_rule: approval creates the rule; rejection doesn't
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${typeof extra === 'object' ? JSON.stringify(extra).slice(0, 300) : extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 4126;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = '/tmp/phase-b-rules';
const DB = path.join(TMP, 'test.db');
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
function dbRead(sql, ...params) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB, { readOnly: true });
  const row = db.prepare(sql).get(...params);
  db.close();
  return row;
}
function dbExec(sql, ...params) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB);
  const r = db.prepare(sql).run(...params);
  db.close();
  return r;
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  try {
    server = spawn('node', ['src/index.js'], {
      cwd: path.join(__dirname, '..', 'server'),
      env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret', EHR_AUTOPULL: 'off', STRIPE_SECRET_KEY: '', AGENT_ENABLED: '1', ANTHROPIC_API_KEY: 'test-agent-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    let up = false;
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch { /* wait */ }
      await sleep(500);
    }
    check('server up', up);

    const U = await api('POST', '/api/auth/signup', { name: 'Owner B', email: 'b@test.co', password: 'Test1234!', orgName: 'Phase B Clinic' });
    const tok = U.data.token;
    await api('POST', '/api/onboarding/complete', { plan: 'pro' }, tok);

    const mkClaim = (over) => api('POST', '/api/claims', {
      claim_number: over.claim_number, patient_name: 'Pat One', payer: 'UnitedHealthcare',
      service_date: '2026-10-10', billed_amount: 300, status: 'pending',
      cpt_codes: '99214', icd_codes: 'M54.5', rendering_npi: '1234567890',
      rendering_provider: 'Dr B', patient_dob: '1980-01-01', member_id: 'MBR1', ...over,
    }, tok);

    // A denied claim with the classic missing-modifier pattern
    const denied = await mkClaim({ claim_number: 'CLM-B-1', status: 'denied', denial_reason: 'CO-97 — Included in another service' });
    check('denied claim created', denied.status === 201, denied);

    // 1. one-click rule from the denial
    const r1 = await api('POST', `/api/rules/from-denial/${denied.data.id}`, { action_type: 'append_modifier', action_value: '25' }, tok);
    check('rule created from denial', r1.status === 201 && !!r1.data.id, r1);
    const r2 = await api('POST', `/api/rules/from-denial/${denied.data.id}`, { action_type: 'append_modifier', action_value: '25' }, tok);
    check('repeat create dedupes', r2.status === 200 && r2.data.deduped === true && r2.data.id === r1.data.id, r2);
    const ruleRow = dbRead('SELECT * FROM custom_scrub_rules WHERE id = ?', r1.data.id);
    check('rule carries the action', ruleRow?.action_type === 'append_modifier' && ruleRow?.action_value === '25' && ruleRow?.cpt_code === '99214', ruleRow);

    // validation
    const bad1 = await api('POST', '/api/rules/custom', { name: 'X', severity: 'warning', message: 'm', cpt_code: '99213', action_type: 'append_modifier', action_value: '2' }, tok);
    check('bad modifier rejected', bad1.status === 400, bad1);
    const bad2 = await api('POST', '/api/rules/custom', { name: 'X', severity: 'warning', message: 'm', action_type: 'append_modifier', action_value: '25' }, tok);
    check('append without CPT rejected', bad2.status === 400, bad2);

    // 2. preview computes, does not apply
    const fresh = await mkClaim({ claim_number: 'CLM-B-2' });
    const prev = await api('POST', '/api/scrub/preview', { ...fresh.data }, tok);
    check('preview computes the fix', (prev.data.fixes || []).length === 1 && prev.data.fixes[0].after === '99214:25', prev.data.fixes);
    check('preview does not apply', dbRead('SELECT cpt_codes FROM claims WHERE id = ?', fresh.data.id)?.cpt_codes === '99214');

    // 3. run applies
    const run = await api('POST', '/api/scrub/run', { claim_ids: [fresh.data.id] }, tok);
    const runRes = (run.data.results || [])[0];
    check('run applies the fix', (runRes?.fixes_applied || []).length === 1, runRes);
    check('claim cpt_codes corrected', dbRead('SELECT cpt_codes FROM claims WHERE id = ?', fresh.data.id)?.cpt_codes === '99214:25');
    const apps = await api('GET', '/api/rules/applications', null, tok);
    check('application logged + listed', (apps.data || []).some((a) => a.claim_id === fresh.data.id && a.rule_id === r1.data.id), apps.data);
    check('hit counted', dbRead('SELECT hit_count FROM custom_scrub_rules WHERE id = ?', r1.data.id)?.hit_count >= 1);

    // 4. no double-append
    const run2 = await api('POST', '/api/scrub/run', { claim_ids: [fresh.data.id] }, tok);
    const run2Res = (run2.data.results || [])[0];
    check('no duplicate modifier on re-scrub', (run2Res?.fixes_applied || []).length === 0 && dbRead('SELECT cpt_codes FROM claims WHERE id = ?', fresh.data.id)?.cpt_codes === '99214:25', run2Res);

    // 5. flag rule
    const flag = await api('POST', '/api/rules/custom', { name: 'Check auth for 99215', severity: 'warning', cpt_code: '99215', message: 'Verify prior auth before submitting.', action_type: 'flag' }, tok);
    check('flag rule created', flag.status === 201, flag);
    const c3 = await mkClaim({ claim_number: 'CLM-B-3', cpt_codes: '99215' });
    const run3 = await api('POST', '/api/scrub/run', { claim_ids: [c3.data.id] }, tok);
    const run3Res = (run3.data.results || [])[0];
    check('flag rule fires as issue', (run3Res?.issues || []).some((i) => i.rule === 'CUSTOM' && /prior auth/.test(i.message)), run3Res);
    check('flag match counted, no application', dbRead('SELECT hit_count FROM custom_scrub_rules WHERE id = ?', flag.data.id)?.hit_count === 1
      && !dbRead('SELECT id FROM rule_applications WHERE rule_id = ? AND claim_id = ?', flag.data.id, c3.data.id));

    // 6. toggle off
    const tgl = await api('POST', `/api/rules/custom/${flag.data.id}/toggle`, {}, tok);
    check('toggle off works', tgl.status === 200 && tgl.data.is_active === 0, tgl);
    const run4 = await api('POST', '/api/scrub/run', { claim_ids: [c3.data.id] }, tok);
    const run4Res = (run4.data.results || [])[0];
    check('inactive rule does not fire', !(run4Res?.issues || []).some((i) => i.rule === 'CUSTOM'), run4Res);

    // 7. from-denial guards
    const notDenied = await api('POST', `/api/rules/from-denial/${fresh.data.id}`, { action_type: 'flag' }, tok);
    check('from-denial requires a denied claim', notDenied.status === 400, notDenied);

    // 8. agent propose_rule approval path (action row inserted as the
    // tool would; the decide route is the product surface under test)
    const org = dbRead('SELECT id FROM orgs WHERE name = ?', 'Phase B Clinic');
    const user = dbRead('SELECT id FROM users WHERE email = ?', 'b@test.co');
    const payload = JSON.stringify({ name: 'Denial pattern: CPT 99213 · UnitedHealthcare', message: 'CO-16 pattern — check the note before submitting.', payer_id: null, payer: 'UnitedHealthcare', cpt_code: '99213', action_type: 'flag', action_value: null });
    const ins = dbExec(`INSERT INTO agent_actions (org_id, user_id, kind, payload, preview, status) VALUES (?, ?, 'propose_rule', ?, 'preview', 'pending')`, org.id, user.id, payload);
    const approve = await api('POST', `/api/agent/actions/${ins.lastInsertRowid}/approve`, {}, tok);
    check('propose_rule approval executes', approve.status === 200, approve);
    const agentRule = dbRead(`SELECT * FROM custom_scrub_rules WHERE name LIKE 'Denial pattern: CPT 99213%'`);
    check('approved proposal created the rule', !!agentRule && agentRule.action_type === 'flag' && agentRule.is_active === 1, agentRule);
    const ins2 = dbExec(`INSERT INTO agent_actions (org_id, user_id, kind, payload, preview, status) VALUES (?, ?, 'propose_rule', ?, 'preview', 'pending')`, org.id, user.id, payload.replace('99213', '99212'));
    const reject = await api('POST', `/api/agent/actions/${ins2.lastInsertRowid}/reject`, {}, tok);
    check('rejection path responds', reject.status === 200, reject);
    check('rejected proposal creates nothing', !dbRead(`SELECT id FROM custom_scrub_rules WHERE cpt_code = '99212'`));
  } catch (e) {
    failed++; console.log('  FAIL - exception:', e.stack || e.message);
  } finally {
    if (server) server.kill();
    await sleep(300);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
