// Prior-auth automation suite (#106 Phase F): requirement checks from
// workspace rules + history only, 278 prep (JSON + X12), honest test-mode
// submit, status-check logging, stale follow-ups in stats. The spawned
// server has NO STEDI_API_KEY -> vendor mode 'unconfigured', same
// no-network posture as eligibility/claims in that state.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const PORT = 4134;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-f-authz-'));
const DB = path.join(TMP, 'test.db');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 320) : ''); }
}
async function api(method, p, body, tok) {
  const r = await fetch(BASE + p, {
    method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: r.status, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = spawn(process.execPath, ['server/src/index.js'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'phase-f-test', STATEMENT_REMINDERS: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { const r = await fetch(`${BASE}/api/health`); up = r.ok; } catch { await sleep(250); }
  }
  check('server up', up);
  if (!up) { server.kill(); process.exit(1); }

  try {
    const su = await api('POST', '/api/auth/signup', { email: 'owner@phasef.example', password: 'Test1234!', name: 'Owner F', orgName: 'Phase F Clinic' });
    const tok = su.data.token;
    await api('POST', '/api/onboarding/complete', { plan: 'pro', billing_cycle: 'monthly', seats: 3 }, tok);

    // Signup seeds the standard payer set; read the ids from the list.
    const payerList = await api('GET', '/api/claims/meta/payers', null, tok);
    const pA = payerList.data.find((p) => p.name === 'Aetna')?.id;
    const pB = payerList.data.find((p) => p.name === 'Cigna')?.id;
    check('seeded payers readable', Number.isInteger(pA) && Number.isInteger(pB) && pA !== pB, payerList.data);

    const mkAuth = async (over) => (await api('POST', '/api/authz', {
      patient_name: 'Pat F', provider: 'Dr F', units_requested: 6, ...over,
    }, tok)).data;

    // 1. Rule: Aetna + 99214 requires auth.
    const rule = await api('POST', '/api/authz/pa-rules', { payer_id: pA, cpt_code: '99214', requires_auth: true, notes: 'Portal confirmed' }, tok);
    check('rule created', rule.status === 201 && rule.data.requires_auth === 1, rule.data);
    const dup = await api('POST', '/api/authz/pa-rules', { payer_id: pA, cpt_code: '99214', requires_auth: true }, tok);
    check('rule dedupe: same pair updates in place', dup.data.id === rule.data.id, dup.data);
    const noScope = await api('POST', '/api/authz/pa-rules', { requires_auth: true }, tok);
    check('rule without payer or CPT refused', noScope.status === 400, noScope.data);

    const a1 = await mkAuth({ payer_id: pA, cpt_codes: '99214', icd_codes: 'M54.5' });
    const chk1 = await api('POST', `/api/authz/${a1.id}/check-requirement`, {}, tok);
    check('check via rule: required, source=rule, recorded on record',
      chk1.data.required === 1 && chk1.data.source === 'rule' && chk1.data.auth.pa_required === 1
      && /Workspace rule/.test(chk1.data.basis), chk1.data);

    // 2. CPT-only rule: 97110 never needs auth (any payer).
    await api('POST', '/api/authz/pa-rules', { cpt_code: '97110', requires_auth: false }, tok);
    const a2 = await mkAuth({ payer_id: pB, cpt_codes: '97110' });
    const chk2 = await api('POST', `/api/authz/${a2.id}/check-requirement`, {}, tok);
    check('check via CPT-only rule: not required', chk2.data.required === 0 && chk2.data.source === 'rule', chk2.data);

    // 3. Unknown stays unknown — no invented payer policy.
    const a3 = await mkAuth({ payer_id: pB, cpt_codes: '70551' });
    const chk3 = await api('POST', `/api/authz/${a3.id}/check-requirement`, {}, tok);
    check('unknown requirement: null + honest basis',
      chk3.data.required === null && chk3.data.source === 'unknown' && /Unknown/.test(chk3.data.basis), chk3.data);

    // 4. History inference: an earlier approved auth WITH a payer auth
    //    number for the same payer + CPT makes the pair required.
    const aHist = await mkAuth({ payer_id: pB, cpt_codes: '70551' });
    await api('PUT', `/api/authz/${aHist.id}`, { status: 'submitted' }, tok);
    await api('PUT', `/api/authz/${aHist.id}`, { status: 'approved', auth_number: 'CGN-99887', valid_from: '2026-10-01', valid_to: '2027-01-01' }, tok);
    const a4 = await mkAuth({ payer_id: pB, cpt_codes: '70551' });
    const chk4 = await api('POST', `/api/authz/${a4.id}/check-requirement`, {}, tok);
    check('check via history: required, cites the earlier auth number',
      chk4.data.required === 1 && chk4.data.source === 'history' && /CGN-99887/.test(chk4.data.basis), chk4.data);

    // 5. 278 prep: structured payload + X12, stored on the record.
    const prep = await api('POST', `/api/authz/${a1.id}/prepare-278`, {}, tok);
    check('278 payload shape',
      prep.data.payload.transaction === '278' && prep.data.payload.review.services[0].cpt === '99214'
      && prep.data.payload.subscriber.patient_name === 'Pat F', prep.data.payload);
    check('278 X12 has the 278 envelope + UM segment',
      /ST\*278/.test(prep.data.x12) && /UM\*HS\*I/.test(prep.data.x12) && /ISA/.test(prep.data.x12), prep.data.x12?.slice(0, 200));
    const det1 = await api('GET', `/api/authz/${a1.id}`, null, tok);
    check('payload stored on the record', typeof det1.data.pa_payload === 'string' && det1.data.pa_payload.includes('"278"'), det1.data.pa_payload?.slice(0, 80));

    // 6. Submit in unconfigured mode: honest, no transmit, no status move.
    const sub = await api('POST', `/api/authz/${a1.id}/submit-278`, {}, tok);
    check('submit (unconfigured): transmitted=false, mode labeled',
      sub.status === 200 && sub.data.transmitted === false && sub.data.mode === 'unconfigured'
      && /not configured/.test(sub.data.note), sub.data);
    check('submit (unconfigured): draft status untouched, prep recorded',
      sub.data.auth.status === 'draft' && sub.data.auth.pa_submitted_via === 'stedi_test_prep', sub.data.auth);

    // 7. Status check: logged, honest note, history readable.
    const sc = await api('POST', `/api/authz/${a1.id}/status-check`, {}, tok);
    check('status check recorded with mode + note',
      sc.status === 200 && sc.data.mode === 'unconfigured' && sc.data.checks.length === 1
      && /TEST MODE/.test(sc.data.note), sc.data);
    const scList = await api('GET', `/api/authz/${a1.id}/status-checks`, null, tok);
    check('status-check history endpoint', scList.data.checks.length === 1, scList.data);

    // 8. Stale follow-ups: age a submitted auth past 14 days (direct DB
    //    write on the temp DB, the harness owns it).
    const aStale = await mkAuth({ payer_id: pA, cpt_codes: '99214' });
    await api('PUT', `/api/authz/${aStale.id}`, { status: 'submitted' }, tok);
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(DB);
    raw.exec('PRAGMA busy_timeout = 5000');
    raw.prepare("UPDATE auth_requests SET requested_date = date('now', '-30 days') WHERE id = ?").run(aStale.id);
    raw.close();
    const stats = await api('GET', '/api/authz/stats', null, tok);
    check('stats surface the stale submitted auth',
      stats.data.staleCount >= 1 && stats.data.staleSubmitted.some((s) => s.id === aStale.id && s.days_waiting >= 29), stats.data.staleSubmitted);

    // 9. Rules list + delete.
    const rules = await api('GET', '/api/authz/pa-rules', null, tok);
    check('rules list', rules.data.rules.length === 2, rules.data);
    const delRule = await api('DELETE', `/api/authz/pa-rules/${rule.data.id}`, null, tok);
    check('rule delete', delRule.data.deleted === true, delRule.data);
    const chkAfter = await api('POST', `/api/authz/${a1.id}/check-requirement`, {}, tok);
    check('after rule delete, check falls back honestly (no rule, no history)',
      chkAfter.data.required === null || chkAfter.data.source !== 'rule' || !/rule #/.test(chkAfter.data.basis), chkAfter.data);
  } finally {
    server.kill();
  }

  console.log(`\nphase-f-authz: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
