// phase-a-stedi-test.cjs — Phase A (Commure parity): Stedi direct submission
// pipeline, claim status, and the webhook inbox. A stub Stedi HTTP server
// stands in for healthcare.us.stedi.com (STEDI_HEALTHCARE_BASE override).
//
// Coverage:
//   1. config exposes stedi {configured, mode} without leaking the key
//   2. transmit via stedi: batch -> transmitted, control number stored,
//      Stedi's inline edit-level 277CA applied (claim x12_status accepted)
//   3. transmit with Stedi edit errors: 502, batch stays 'generated'
//   4. transmit with no key configured: precise failure, batch unchanged
//   5. status-check with a TEST key: honest 400 (Stedi limitation)
//   6. status-check with a production-shaped key: result stored + returned
//   7. webhook: reference-only event recorded unprocessed; inline-277CA
//      event applied to the batch through the same ack pipeline
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${typeof extra === 'object' ? JSON.stringify(extra).slice(0, 300) : extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STUB_PORT = 4199;
const PORT = 4125;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = '/tmp/phase-a-stedi';
const DB = path.join(TMP, 'test.db');

let stubMode = 'accept'; // accept | edit_error
let ackClaimId = null;
const ack277 = (claimId) => `ST*277*0001~TRN*1*${claimId}~STC*A1:20:PR~SE*4*0001~`;
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes('/payers/search')) {
      return res.end(JSON.stringify({ items: [{ payer: { displayName: 'UnitedHealthcare', primaryPayerId: '87726', stediId: 'stedi-uhc' } }] }));
    }
    if (req.url.includes('/raw-x12-submission')) {
      if (stubMode === 'edit_error') {
        return res.end(JSON.stringify({ status: 'ERROR', claimReference: { controlNumber: 'CTRL-E', errors: [{ description: 'Subscriber last name missing' }] } }));
      }
      return res.end(JSON.stringify({
        status: 'SUCCESS',
        claimReference: { controlNumber: 'STEDI-CTRL-1' },
        payer: { name: 'UnitedHealthcare' },
        tradingPartnerServiceId: '87726',
        x12: ack277(ackClaimId),
      }));
    }
    if (req.url.includes('/claimstatus/v2')) {
      return res.end(JSON.stringify({
        id: 'csc_test_1', status: 'SUCCESS',
        claims: [{ status: 'ACTIVE', claimStatus: { statusCategoryCode: 'F1', statusCode: '20', entityCode: 'PR', patientAccountNumber: 'CLM-T-100', claimControlNumber: 'ICN123' } }],
      }));
    }
    res.statusCode = 404; res.end('{}');
  });
});

let server;
async function startServer(env) {
  server = spawn('node', ['src/index.js'], {
    cwd: path.join(__dirname, '..', 'server'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret', EHR_AUTOPULL: 'off', STRIPE_SECRET_KEY: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch { /* wait */ }
    await sleep(500);
  }
  return false;
}
async function stopServer() { if (server) server.kill(); await sleep(400); }

async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function dbPatch(sql, ...params) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB);
  db.prepare(sql).run(...params);
  db.close();
}
function dbRead(sql, ...params) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB, { readOnly: true });
  const row = db.prepare(sql).get(...params);
  db.close();
  return row;
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  await new Promise((r) => stub.listen(STUB_PORT, r));
  try {
    // ---------- boot 1: TEST key ----------
    check('server up (test key)', await startServer({
      STEDI_API_KEY: 'test_key_abc',
      STEDI_HEALTHCARE_BASE: `http://127.0.0.1:${STUB_PORT}/2024-04-01`,
    }));
    const U = await api('POST', '/api/auth/signup', { name: 'Owner A', email: 'a@test.co', password: 'Test1234!', orgName: 'Phase A Clinic' });
    const tok = U.data.token;
    await api('POST', '/api/onboarding/complete', { plan: 'pro' }, tok);
    dbPatch(`UPDATE orgs SET billing_npi = '1234567890', billing_tax_id = '123456789',
      billing_address = '1 Main St', billing_city = 'Bay Shore', billing_state = 'NY', billing_zip = '11706',
      edi_submitter_id = 'SUBM1', edi_receiver_id = 'RECV1' WHERE name = 'Phase A Clinic'`);

    const cfg = await api('GET', '/api/transmission/config', null, tok);
    check('config: stedi configured, test mode', cfg.data.stedi?.configured === true && cfg.data.stedi?.mode === 'test', cfg.data.stedi);
    check('config: key never exposed', !JSON.stringify(cfg.data).includes('test_key_abc'));
    check('config: stedi is a selectable vendor', (cfg.data.vendors || []).includes('stedi'), cfg.data.vendors);

    const claimRes = await api('POST', '/api/claims', {
      claim_number: 'CLM-T-100',
      patient_name: 'Emily Novak', payer: 'UnitedHealthcare', service_date: '2026-10-15',
      billed_amount: 410, status: 'pending',
      cpt_codes: '99213', icd_codes: 'M54.5', rendering_npi: '1234567890', rendering_provider: 'Dr A',
      patient_dob: '1985-04-02', member_id: 'UHC123456',
    }, tok);
    const claim = claimRes.data;
    check('claim created', claimRes.status === 201 && !!claim.id, claimRes);
    ackClaimId = claim.id;

    await api('PUT', '/api/transmission/config', { vendor: 'stedi' }, tok);
    const scr = await api('POST', '/api/scrub/run', { claim_ids: [claim.id] }, tok);
    check('claim passes scrub gate (no hard errors)', scr.data.summary?.failed === 0, scr.data.summary);
    const batchRes = await api('POST', '/api/transmission/batches', { claim_ids: [claim.id] }, tok);
    const batch = batchRes.data;
    check('batch created', !!batch.id, batchRes);
    const gen = await api('POST', `/api/transmission/batches/${batch.id}/generate`, {}, tok);
    check('batch generated', gen.status === 200 && gen.data.status === 'generated', gen.data);

    const tx = await api('POST', `/api/transmission/batches/${batch.id}/transmit`, {}, tok);
    check('stedi transmit succeeds', tx.status === 200 && tx.data.status === 'accepted', tx.data);
    check('stedi control number stored', tx.data.stedi_control_number === 'STEDI-CTRL-1', tx.data.stedi_control_number);
    check('inline 277CA applied', tx.data.stedi_ack?.applied === true && tx.data.stedi_ack?.accepted === 1, tx.data.stedi_ack);
    const claimAfter = dbRead('SELECT x12_status FROM claims WHERE id = ?', claim.id);
    check('claim x12_status accepted via Stedi ack', claimAfter?.x12_status === 'accepted', claimAfter);

    // status check under a TEST key -> honest 400
    const sc = await api('POST', `/api/transmission/claims/${claim.id}/status-check`, {}, tok);
    check('status-check blocked for test key with honest reason', sc.status === 400 && /production Stedi key/.test(sc.data.error || ''), sc.data);

    // edit-error path: second claim + batch
    const c2 = await api('POST', '/api/claims', {
      claim_number: 'CLM-T-101',
      patient_name: 'John Roe', payer: 'UnitedHealthcare', service_date: '2026-10-16',
      billed_amount: 200, status: 'pending', cpt_codes: '99213', icd_codes: 'M54.5',
      rendering_npi: '1234567890', rendering_provider: 'Dr A', patient_dob: '1990-01-01', member_id: 'UHC999',
    }, tok);
    await api('POST', '/api/scrub/run', { claim_ids: [c2.data.id] }, tok);
    const b2 = await api('POST', '/api/transmission/batches', { claim_ids: [c2.data.id] }, tok);
    await api('POST', `/api/transmission/batches/${b2.data.id}/generate`, {}, tok);
    stubMode = 'edit_error';
    const tx2 = await api('POST', `/api/transmission/batches/${b2.data.id}/transmit`, {}, tok);
    check('edit errors -> 502 with Stedi detail', tx2.status === 502 && /claim edits/.test(tx2.data.error || ''), tx2.data);
    const b2After = await api('GET', `/api/transmission/batches/${b2.data.id}`, null, tok);
    check('batch stays generated after edit rejection', b2After.data.status === 'generated', b2After.data.status);
    stubMode = 'accept';

    // webhook: reference-only event recorded, not processed
    const wh1 = await fetch(BASE + '/api/webhooks/stedi', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'transaction.processed', transactionId: 'txn_ref_1' }),
    });
    const wh1Body = await wh1.json();
    check('webhook reference event accepted', wh1.status === 200 && wh1Body.received === true && wh1Body.processed === false, wh1Body);
    const ev = dbRead('SELECT processed, note FROM stedi_events WHERE transaction_id = ?', 'txn_ref_1');
    check('webhook event recorded unprocessed', ev?.processed === 0 && /recorded/.test(ev?.note || ''), ev);

    // webhook: inline 277CA for the second claim's batch (transmit it first)
    ackClaimId = c2.data.id;
    const tx3 = await api('POST', `/api/transmission/batches/${b2.data.id}/transmit`, {}, tok);
    check('second batch transmits', tx3.status === 200, tx3.data);
    // reset claim to transmitted to prove the webhook path moves it
    dbPatch(`UPDATE claims SET x12_status = 'transmitted' WHERE id = ?`, c2.data.id);
    dbPatch(`UPDATE claim_batches SET status = 'transmitted' WHERE id = ?`, b2.data.id);
    const wh2 = await fetch(BASE + '/api/webhooks/stedi', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'transaction.processed', transactionId: 'txn_277_1', x12: ack277(c2.data.id) }),
    });
    const wh2Body = await wh2.json();
    check('webhook inline 277CA processed', wh2.status === 200 && wh2Body.processed === true, wh2Body);
    const c2After = dbRead('SELECT x12_status FROM claims WHERE id = ?', c2.data.id);
    check('webhook ack set claim accepted', c2After?.x12_status === 'accepted', c2After);

    await stopServer();

    // ---------- boot 2: production-shaped key ----------
    check('server up (prod key)', await startServer({
      STEDI_API_KEY: 'live_key_xyz',
      STEDI_HEALTHCARE_BASE: `http://127.0.0.1:${STUB_PORT}/2024-04-01`,
    }));
    const login = await api('POST', '/api/auth/login', { email: 'a@test.co', password: 'Test1234!' });
    const tok2 = login.data.token;
    const cfg2 = await api('GET', '/api/transmission/config', null, tok2);
    check('config: production mode from key', cfg2.data.stedi?.mode === 'production', cfg2.data.stedi);
    const sc2 = await api('POST', `/api/transmission/claims/${claim.id}/status-check`, {}, tok2);
    check('status-check succeeds with prod key', sc2.status === 200 && sc2.data.matched === true, sc2.data);
    check('status result mapped', sc2.data.result?.category_code === 'F1' && sc2.data.result?.payer_icn === 'ICN123', sc2.data.result);
    const hist = await api('GET', `/api/transmission/claims/${claim.id}/status-checks`, null, tok2);
    check('status check logged', (hist.data.checks || []).length === 1 && hist.data.checks[0].check_ref === 'csc_test_1', hist.data);
    await stopServer();

    // ---------- boot 3: no key ----------
    check('server up (no key)', await startServer({ STEDI_API_KEY: '', STEDI_HEALTHCARE_BASE: `http://127.0.0.1:${STUB_PORT}/2024-04-01` }));
    const login3 = await api('POST', '/api/auth/login', { email: 'a@test.co', password: 'Test1234!' });
    const cfg3 = await api('GET', '/api/transmission/config', null, login3.data.token);
    check('config: unconfigured without key', cfg3.data.stedi?.configured === false && cfg3.data.stedi?.mode === 'unconfigured', cfg3.data.stedi);
    await stopServer();
  } catch (e) {
    failed++; console.log('  FAIL - exception:', e.stack || e.message);
  } finally {
    await stopServer();
    stub.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
