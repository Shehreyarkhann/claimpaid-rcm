// availity-outbox-test.cjs — deploy #46 (step 4) verification.
// Part A (unit, stubbed fetch): Availity eligibility adapter — token flow,
// coverages mapping, payer-map + credential guards, token caching.
// Part B (API): eligibility config persistence (secret never echoed) +
// transmission outbox lifecycle queued -> sent -> acknowledged/failed ->
// requeue releases the claim.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- Part A: adapter unit tests --------------------------------
async function partA() {
  console.log('Part A — Availity adapter (stubbed fetch)');
  const { runCheck } = require('../server/src/eligibility/vendors');
  let tokenCalls = 0;
  const calls = [];
  const realFetch = global.fetch;
  // The shape Availity's own API guide documents for Coverages responses:
  // transaction status on the coverage, coverage status + plan fields in plans[].
  const REAL_SHAPE = {
    totalCount: 1, count: 1,
    coverages: [{
      id: 'cov-1', status: 'Complete', statusCode: '4',
      payer: { name: 'HUMANA', payerId: 'HUMANA' },
      plans: [{
        status: 'Active Coverage', planName: 'Humana Gold Plus HMO', groupNumber: 'GRP-9',
        effectiveDate: '2026-01-01', expirationDate: '2026-12-31',
      }],
    }],
  };
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push(u);
    const json = (obj, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify(obj) });
    if (u.includes('/token')) {
      tokenCalls++;
      if ((opts.body || '').includes('bad-secret')) return json({ error: 'invalid_client' }, 401);
      if (u.includes('tst.api.availity.com') && u.includes('/token') && (opts.body || '').includes('cid-fb')) return json({ error: 'not_found' }, 404);
      return json({ access_token: 'tok-123', expires_in: 300 });
    }
    if (u.includes('/coverages')) {
      if (u.includes('memberId=REALSHAPE')) return json(REAL_SHAPE);
      if (!u.includes('payerID=AETNA')) return json({ message: 'unknown payer' }, 400);
      return json({
        coverages: [{
          status: 'Active', planName: 'Aetna Open Access PPO', planType: 'PPO', groupNumber: 'GRP-77',
          effectiveDate: '2026-01-01', expirationDate: '2026-12-31',
          deductibles: [{ level: 'Individual', total: 1000, remaining: 400 }],
          outOfPocket: [{ level: 'Individual', total: 5000 }],
          copays: [{ serviceType: 'Primary Care', amount: 20 }, { serviceType: 'Specialist', amount: 40 }],
        }],
      });
    }
    return { ok: false, status: 404, text: async () => 'nf' };
  };
  const cfg = {
    eligibility_availity_client_id: 'cid',
    eligibility_availity_client_secret: 'sec',
    eligibility_availity_payer_map: '{"Aetna":"AETNA"}',
    billing_npi: '1234567890',
  };
  const input = { patient_first: 'Jane', patient_last: 'Doe', dob: '1980-01-01', member_id: 'M12345', payer: 'Aetna', date_of_service: '2026-10-01' };
  try {
    const r = await runCheck('availity', cfg, input);
    check('coverage active mapped', r.coverage_active === 1, JSON.stringify(r).slice(0, 160));
    check('plan + group mapped', r.plan_name === 'Aetna Open Access PPO' && r.group_number === 'GRP-77');
    check('deductible mapped', r.deductible_individual === 1000 && r.deductible_remaining === 400);
    check('oop + copays mapped', r.oop_max === 5000 && r.copay_primary === 20 && r.copay_specialist === 40);
    check('raw response labeled real (demo:false)', r.raw_response.demo === false);
    const r2 = await runCheck('availity', cfg, input);
    check('token cached across checks', tokenCalls === 1 && r2.coverage_active === 1, `tokenCalls=${tokenCalls}`);
    let threw = '';
    try { await runCheck('availity', cfg, { ...input, payer: 'Cigna' }); } catch (e) { threw = e.message; }
    check('unmapped payer throws precise error', /No Availity payer ID is mapped for "Cigna"/.test(threw), threw);
    threw = '';
    try { await runCheck('availity', { ...cfg, eligibility_availity_client_id: 'cid-bad', eligibility_availity_client_secret: 'bad-secret' }, input); } catch (e) { threw = e.message; }
    check('bad credentials throw (never demo fallback)', /token request failed/.test(threw), threw);
    threw = '';
    try { await runCheck('availity', { ...cfg, billing_npi: '' }, input); } catch (e) { threw = e.message; }
    check('missing NPI throws precise error', /billing NPI/.test(threw), threw);

    // Real documented response shape: plans[] drives active + plan fields.
    const rs = await runCheck('availity', { ...cfg, eligibility_availity_client_id: 'cid-shape' }, { ...input, member_id: 'REALSHAPE' });
    check('real shape: Active Coverage in plans[] maps to active', rs.coverage_active === 1, JSON.stringify(rs).slice(0, 160));
    check('real shape: plan name/group/dates from plans[]', rs.plan_name === 'Humana Gold Plus HMO' && rs.group_number === 'GRP-9' && rs.effective_date === '2026-01-01' && rs.term_date === '2026-12-31', JSON.stringify(rs).slice(0, 200));

    // Demo environments route to Availity's documented demo hosts.
    calls.length = 0;
    const rd = await runCheck('availity', { ...cfg, eligibility_availity_client_id: 'cid-demo', eligibility_availity_env: 'demo-tst' }, input);
    check('demo-tst env: check succeeds', rd.coverage_active === 1, JSON.stringify(rd).slice(0, 120));
    check('demo-tst env: coverages called on tst host', calls.some((u) => u.startsWith('https://tst.api.availity.com/v1/coverages')), calls.join(' | ').slice(0, 200));
    calls.length = 0;
    const rl = await runCheck('availity', { ...cfg, eligibility_availity_client_id: 'cid-legacy', eligibility_availity_env: 'demo' }, input);
    check('legacy "demo" value aliases to the tst host', rl.coverage_active === 1 && calls.some((u) => u.startsWith('https://tst.api.availity.com/v1/coverages')), calls.join(' | ').slice(0, 160));
    calls.length = 0;
    const rq = await runCheck('availity', { ...cfg, eligibility_availity_client_id: 'cid-qua', eligibility_availity_env: 'demo-qua' }, input);
    check('demo-qua env: coverages called on qua host', rq.coverage_active === 1 && calls.some((u) => u.startsWith('https://qua.api.availity.com/availity/v1/coverages')), calls.join(' | ').slice(0, 200));

    // Demo token endpoint missing -> production token endpoint fallback.
    const rf = await runCheck('availity', { ...cfg, eligibility_availity_client_id: 'cid-fb', eligibility_availity_env: 'demo-tst' }, input);
    check('demo env: token fallback to production auth host works', rf.coverage_active === 1, JSON.stringify(rf).slice(0, 120));
  } finally {
    global.fetch = realFetch;
  }
}

// ---------------- Part B: API lifecycle --------------------------------------
const PORT = 4109;
const BASE = `http://localhost:${PORT}`;
const TMP = '/tmp/availity-outbox-test';
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

async function partB() {
  console.log('Part B — config + outbox lifecycle (HTTP)');
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
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
  const s = await api('POST', '/api/auth/signup', { orgName: 'Availity Org', name: 'Owner', email: 'av@test.co', password: 'Test1234!' });
  const t = s.data.token;
  check('signup', s.status === 201, JSON.stringify(s.data));

  // Availity eligibility config: persists, secret never echoed back.
  const put = await api('PUT', '/api/eligibility/config', {
    vendor: 'availity', availity_client_id: 'cid-1', availity_client_secret: 'sec-1',
    availity_payer_map: '{"Aetna":"AETNA"}',
  }, t);
  check('availity config saved', put.status === 200 && put.data.vendor === 'availity', JSON.stringify(put.data).slice(0, 200));
  const get = await api('GET', '/api/eligibility/config', null, t);
  check('config shows client id + secret_set, never the secret',
    get.data.availity_client_id === 'cid-1' && get.data.availity_client_secret_set === true
    && !JSON.stringify(get.data).includes('sec-1'), JSON.stringify(get.data).slice(0, 200));
  const badMap = await api('PUT', '/api/eligibility/config', { vendor: 'availity', availity_payer_map: 'not json' }, t);
  check('invalid payer map rejected', badMap.status === 400, `got ${badMap.status}`);

  // Org EDI identity + payer + two complete claims.
  await api('PUT', '/api/org/edi-settings', { billing_npi: '1234567890', billing_address: '1 Main St', billing_city: 'Farmingdale', billing_state: 'NY', billing_zip: '11735', billing_tax_id: '123456789' }, t);
  await api('POST', '/api/claims/meta/payers', { name: 'Aetna', type: 'Commercial' }, t);
  const mk = async (num) => (await api('POST', '/api/claims', {
    claim_number: num, patient_name: 'Jane Doe', payer: 'Aetna', service_date: '2026-10-01',
    billed_amount: 150, cpt_codes: '99213', icd_codes: 'M54.5', patient_dob: '1980-01-01', member_id: 'M12345',
  }, t)).data;
  const c1 = await mk('AV-1001');
  const c2 = await mk('AV-1002');
  check('claims created', !!c1.id && !!c2.id, JSON.stringify([c1, c2]).slice(0, 160));

  const scrub = await api('POST', '/api/scrub/run', { claim_ids: [c1.id, c2.id] }, t);
  check('claims scrubbed batchable', scrub.status === 200 && scrub.data.summary.failed === 0, JSON.stringify(scrub.data).slice(0, 200));

  const batch = await api('POST', '/api/transmission/batches', { claim_ids: [c1.id, c2.id] }, t);
  check('batch created', batch.status === 201 && !!batch.data.id, JSON.stringify(batch.data).slice(0, 160));
  const gen = await api('POST', `/api/transmission/batches/${batch.data.id}/generate`, null, t);
  check('837P generated', gen.status === 200, JSON.stringify(gen.data).slice(0, 160));

  let outbox = (await api('GET', '/api/transmission/outbox', null, t)).data.outbox || [];
  check('outbox queued both claims', outbox.length === 2 && outbox.every((o) => o.status === 'queued'), JSON.stringify(outbox).slice(0, 200));

  const tx = await api('POST', `/api/transmission/batches/${batch.data.id}/transmit`, { vendor: 'manual', confirmed: true }, t);
  check('manual transmit confirmed', tx.status === 200, JSON.stringify(tx.data).slice(0, 160));
  outbox = (await api('GET', '/api/transmission/outbox', null, t)).data.outbox || [];
  check('outbox sent with vendor + timestamp', outbox.length === 2 && outbox.every((o) => o.status === 'sent' && o.vendor === 'manual' && !!o.sent_at), JSON.stringify(outbox).slice(0, 200));

  // 277CA: claim 1 accepted (A1), claim 2 rejected (A3).
  const ackText = [
    'ISA*00*          *00*          *ZZ*AVAILITY       *ZZ*CLAIMPAID      *261024*1200*^*00501*000000001*0*T*:~',
    'GS*HN*AVAILITY*CLAIMPAID*20261024*1200*1*X*005010X214~',
    'ST*277*0001*005010X214~',
    'BHT*0085*08*1001*20261024*1200~',
    `TRN*1*${c1.id}*AETNA~`,
    'STC*A1:20:PR*20261024*WQ*150~',
    `TRN*1*${c2.id}*AETNA~`,
    'STC*A3:21:PR*20261024*WQ*150~',
    'SE*8*0001~', 'GE*1*1~', 'IEA*1*000000001~',
  ].join('\n');
  const fd = new FormData();
  fd.append('file', new Blob([ackText], { type: 'text/plain' }), 'ack.277');
  fd.append('type', '277ca');
  const ackRes = await fetch(`${BASE}/api/transmission/batches/${batch.data.id}/ack`, {
    method: 'POST', headers: { Authorization: `Bearer ${t}` }, body: fd,
  });
  const ackData = await ackRes.json().catch(() => ({}));
  check('277CA processed', ackRes.status === 200, JSON.stringify(ackData).slice(0, 200));
  outbox = (await api('GET', '/api/transmission/outbox', null, t)).data.outbox || [];
  const o1 = outbox.find((o) => o.claim_id === c1.id);
  const o2 = outbox.find((o) => o.claim_id === c2.id);
  check('accepted claim acknowledged', o1?.status === 'acknowledged' && !!o1?.ack_at, JSON.stringify(o1));
  check('rejected claim failed', o2?.status === 'failed', JSON.stringify(o2));

  const rq = await api('POST', `/api/transmission/outbox/${o2.id}/requeue`, null, t);
  check('requeue succeeds', rq.status === 200, JSON.stringify(rq.data));
  const transmittable = (await api('GET', '/api/transmission/transmittable', null, t)).data;
  const tRows = transmittable.claims || transmittable || [];
  check('requeued claim is batchable again', (Array.isArray(tRows) ? tRows : []).some((c) => c.id === c2.id), JSON.stringify(transmittable).slice(0, 200));
  const rq2 = await api('POST', `/api/transmission/outbox/${o1.id}/requeue`, null, t);
  check('acknowledged entry cannot be requeued', rq2.status === 400, `got ${rq2.status}`);
}

(async () => {
  await partA();
  await partB();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (server) server.kill();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); if (server) server.kill(); process.exit(1); });
