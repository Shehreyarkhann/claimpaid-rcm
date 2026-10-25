// import837-test.cjs — deploy #51 verification.
// Part A (unit): parse837 against a hand-built 837P fixture (subscriber
// patient + dependent patient, line-level and claim-level dates, undotted
// ICD-10) and a generate->parse round trip through the app's own 837
// generator.
// Part B (HTTP): upload -> claims land with codes/dates/payers, payers
// auto-created + reported, re-upload dedupes, junk rejected, org isolation.
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

const FIXTURE = [
  'ISA*00*          *00*          *ZZ*SUBMITTER       *ZZ*RECEIVER        *260925*1200*^*00501*000000001*0*P*:',
  'GS*HC*SUBMITTER*RECEIVER*20260925*1200*1*X*005010X222A1',
  'ST*837*0001*005010X222A1',
  'BHT*0019*00*1*20260925*1200*CH',
  'NM1*41*2*TEST BILLING*****46*123456789',
  'NM1*40*2*CLEARINGHOUSE*****46*RECEIVERID',
  'HL*1**20*1',
  'NM1*85*2*TEST PRACTICE*****XX*1234567893',
  // Claim 1: subscriber is the patient; dates on the lines.
  'HL*2*1*22*0',
  'SBR*P*18*GROUP123******CI',
  'NM1*IL*1*PATIENT*ALICE****MI*MBR-A123',
  'DMG*D8*19850312*F',
  'NM1*PR*2*AETNA*****PI*60054',
  'CLM*IMP-CLM-1*180***11:B:1*Y*A*Y*Y',
  'HI*ABK:M545*ABF:I10',
  'NM1*82*1*PROVIDER*JANE****XX*1234567890',
  'LX*1',
  'SV1*HC:99213*120*UN*1***1',
  'DTP*472*D8*20260801',
  'LX*2',
  'SV1*HC:97110*60*UN*2***1',
  'DTP*472*D8*20260801',
  // Claim 2: dependent patient under a different subscriber/payer.
  'HL*3*1*22*1',
  'SBR*P*01******CI',
  'NM1*IL*1*HOLDER*BOB****MI*MBR-B999',
  'DMG*D8*19800620*M',
  'NM1*PR*2*CIGNA*****PI*62308',
  'HL*4*3*23*0',
  'NM1*QC*1*PATIENT*CAROL',
  'DMG*D8*20120315*F',
  'CLM*IMP-CLM-2*95***11:B:1*Y*A*Y*Y',
  'DTP*472*D8*20260902',
  'HI*ABK:E119',
  'LX*1',
  'SV1*HC:99214*95*UN*1***1',
  'SE*38*0001',
  'GE*1*1',
  'IEA*1*000000001',
].join('~\n') + '~\n';

function partA() {
  console.log('Part A — parse837 (unit)');
  const { parse837 } = require('../server/src/edi/parse837');
  const { claims, errors } = parse837(FIXTURE);
  check('fixture parses 2 claims, no errors', claims.length === 2 && errors.length === 0, JSON.stringify({ n: claims.length, errors }));
  const [c1, c2] = claims;
  check('claim 1 identity (number, patient, member, dob)',
    c1.claim_number === 'IMP-CLM-1' && c1.patient_name === 'PATIENT, ALICE' && c1.member_id === 'MBR-A123' && c1.patient_dob === '1985-03-12',
    JSON.stringify(c1).slice(0, 200));
  check('claim 1 payer + billed + line-date service date',
    c1.payer_name === 'AETNA' && c1.billed_amount === 180 && c1.service_date === '2026-08-01', JSON.stringify(c1).slice(0, 160));
  check('claim 1 codes (CPT from lines, ICD dotted)',
    JSON.stringify(c1.cpt_codes) === '["99213","97110"]' && JSON.stringify(c1.icd_codes) === '["M54.5","I10"]',
    JSON.stringify({ cpt: c1.cpt_codes, icd: c1.icd_codes }));
  check('claim 1 rendering provider + NPI', c1.rendering_provider === 'PROVIDER, JANE' && c1.rendering_npi === '1234567890', JSON.stringify(c1).slice(0, 200));
  check('claim 2 is the DEPENDENT patient with the subscriber member id',
    c2.patient_name === 'PATIENT, CAROL' && c2.member_id === 'MBR-B999' && c2.patient_dob === '2012-03-15' && c2.payer_name === 'CIGNA',
    JSON.stringify(c2).slice(0, 200));
  check('claim 2 claim-level service date + dotted ICD',
    c2.service_date === '2026-09-02' && c2.billed_amount === 95 && JSON.stringify(c2.icd_codes) === '["E11.9"]',
    JSON.stringify(c2).slice(0, 160));

  const junk = parse837('this is not edi at all');
  check('junk file rejected with a reason', junk.claims.length === 0 && junk.errors.length > 0, JSON.stringify(junk));

  // Round trip: our own generator's output must parse back.
  const { generate837P } = require('../server/src/edi/generate837p');
  const org = { name: 'RT Practice', billing_npi: '1234567893', billing_tax_id: '123456789', billing_address: '1 Main St', billing_city: 'Bay Shore', billing_state: 'NY', billing_zip: '11706', billing_phone: '5555555555' };
  const src = [{
    id: 1, claim_number: 'RT-100', patient_name: 'Alice Patient', patient_dob: '1985-03-12',
    member_id: 'MBR-A123', payer_name: 'Aetna', service_date: '2026-08-01', billed_amount: 180,
    cpt_codes: '99213, 97110', icd_codes: 'M54.5, I10', rendering_npi: '1234567890', rendering_provider: 'Jane Provider',
  }];
  const text = generate837P(src, org, {}).ediText;
  const rt = parse837(text);
  check('generator round trip parses 1 claim', rt.claims.length === 1, JSON.stringify(rt.errors));
  if (rt.claims.length) {
    const r = rt.claims[0];
    // NB: our generator writes the internal claim id into CLM01 (patient
    // control number), so the round trip returns '1', not 'RT-100'.
    check('round trip keeps number/billed/member/payer',
      r.claim_number === '1' && r.billed_amount === 180 && r.member_id === 'MBR-A123' && /aetna/i.test(r.payer_name || ''), JSON.stringify(r).slice(0, 200));
    check('round trip keeps codes', r.cpt_codes.includes('99213') && r.icd_codes.includes('M54.5'), JSON.stringify({ cpt: r.cpt_codes, icd: r.icd_codes }));
  }
}

// ---------------- Part B: HTTP ---------------------------------------------
const PORT = 4111;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = '/tmp/import837-api';
const DB = path.join(TMP, 'test.db');
let server;

async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function upload837(token, content, name = 'claims.837') {
  const fd = new FormData();
  fd.append('file', new Blob([content], { type: 'text/plain' }), name);
  const res = await fetch(BASE + '/api/claims/upload/837', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function partB() {
  console.log('Part B — import endpoint (HTTP)');
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
  const s = await api('POST', '/api/auth/signup', { orgName: 'Import Org', name: 'Owner', email: 'imp@test.co', password: 'Test1234!' });
  const t = s.data.token;
  check('signup', s.status === 201, JSON.stringify(s.data).slice(0, 120));

  const up = await upload837(t, FIXTURE);
  check('fixture imports 2 claims', up.status === 200 && up.data.inserted === 2 && up.data.total === 2, JSON.stringify(up.data).slice(0, 240));
  check('default payers matched by name, none created (AETNA->Aetna, CIGNA->Cigna)',
    Array.isArray(up.data.payers_created) && up.data.payers_created.length === 0, JSON.stringify(up.data.payers_created));
  const acme = await upload837(t, FIXTURE.replace('IMP-CLM-2', 'IMP-CLM-3').replace('CIGNA', 'ACME HEALTH'));
  check('unknown payer auto-created + reported, its claim inserted, known claim deduped',
    acme.status === 200 && acme.data.inserted === 1 && (acme.data.skipped || []).length === 1
    && (acme.data.payers_created || []).some((p) => /acme/i.test(p)), JSON.stringify(acme.data).slice(0, 240));

  const list = await api('GET', '/api/claims?limit=50', null, t);
  const rows = list.data.claims || list.data.rows || list.data || [];
  const r1 = rows.find((r) => r.claim_number === 'IMP-CLM-1');
  const r2 = rows.find((r) => r.claim_number === 'IMP-CLM-2');
  check('imported claims listed with amounts', !!r1 && Number(r1.billed_amount) === 180 && !!r2 && Number(r2.billed_amount) === 95, JSON.stringify(rows).slice(0, 200));
  if (r1) {
    const detail = await api('GET', `/api/claims/${r1.id}`, null, t);
    const c = detail.data.claim || detail.data;
    check('claim detail carries codes/member/dob', (c.cpt_codes || '').includes('99213') && (c.icd_codes || '').includes('M54.5') && c.member_id === 'MBR-A123' && c.patient_dob === '1985-03-12', JSON.stringify(c).slice(0, 240));
  }

  const again = await upload837(t, FIXTURE);
  check('re-import dedupes (0 inserted, 2 skipped)', again.status === 200 && again.data.inserted === 0 && (again.data.skipped || []).length === 2, JSON.stringify(again.data).slice(0, 200));

  const bad = await upload837(t, 'hello world, not edi');
  check('junk upload -> 400 with reason', bad.status === 400 && !!bad.data.error, `got ${bad.status}`);

  const s2 = await api('POST', '/api/auth/signup', { orgName: 'Import Org 2', name: 'Owner', email: 'imp2@test.co', password: 'Test1234!' });
  const up2 = await upload837(s2.data.token, FIXTURE);
  check('same file imports cleanly into another org (per-org dedupe)', up2.status === 200 && up2.data.inserted === 2, JSON.stringify(up2.data).slice(0, 160));
}

(async () => {
  try { partA(); } catch (e) { failed++; console.log('  FAIL Part A threw:', e.message); }
  try { await partB(); } catch (e) { failed++; console.log('  FAIL Part B threw:', e.message); }
  if (server) server.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
