#!/usr/bin/env node
// API tests for the ERA auto-posting engine (deploy #41) — throwaway DB,
// real HTTP server. Usage: node era-api-test.cjs
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = '/home/hatch/workspace/portfolio/rcm-dashboard';
const DB = '/tmp/era-api-test.db';
const PORT = 4104;
const API = `http://127.0.0.1:${PORT}`;

try { fs.unlinkSync(DB); } catch {}

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name} ${extra}`); }
}

async function req(method, p, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) { payload = form; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(API + p, { method, headers, body: payload });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

const ERA_835 = [
  'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *261020*0800*^*00501*000000905*0*T*:~',
  'GS*HP*AETNA*RECEIVER*20261020*0800*905*X*005010X221A1~',
  'ST*835*0001~',
  'BPR*I*770*C*ACH*CCP*01*021000022*DA*123456789*1234567890*SUPP*01*021000022*DA*987654321*20261020~',
  'TRN*1*EFT123456*1234567890~',
  'DTM*405*20261020~',
  'N1*PR*AETNA~',
  'N1*PE*TEST CLINIC*XX*1234567893~',
  // A — clean paid in full
  'CLP*CLM-A*1*200*200*0**ICNA001~',
  'NM1*QC*1*PAID*ALICE****MI*MBR-A~',
  'DTM*232*20260901~',
  // B — partial: contractual write-off + copay, balanced
  'CLP*CLM-B*1*300*200*30**ICNB002~',
  'NM1*QC*1*PARTIAL*BOB****MI*MBR-B~',
  'CAS*CO*45*70~',
  'CAS*PR*3*30~',
  // C — denial, no auth (CO-197 for the full amount)
  'CLP*CLM-C*4*150*0*0**ICNC003~',
  'NM1*QC*1*DENIED*CAROL****MI*MBR-C~',
  'CAS*CO*197*150~',
  // D — variance: billed 100, paid 50, only 30 explained
  'CLP*CLM-D*1*100*50*0**ICND004~',
  'NM1*QC*1*VARIANCE*DAN****MI*MBR-D~',
  'CAS*CO*45*30~',
  // F — $0 payer payment, full amount to patient deductible (balanced)
  'CLP*CLM-F*1*80*0*80**ICNF006~',
  'NM1*QC*1*ZERO*FRANK****MI*MBR-F~',
  'CAS*PR*1*80~',
  // UNKNOWN — no such claim, but a suggested match exists (Eve Manual, $120)
  'CLP*CLP-UNKNOWN*1*120*120*0**ICNU007~',
  'NM1*QC*1*MANUAL*EVE****MI*MBR-U~',
  // G — reversal of A (same check) — must never auto-post
  'CLP*CLM-A*22*200*200*0**ICNA001~',
  'PLB*1234567893*20260930*CV:REFUND*-25~',
  'SE*24*0001~',
  'GE*1*905~',
  'IEA*1*000000905~',
].join('\n');

(async () => {
  const server = spawn('node', [path.join(REPO, 'server/src/index.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), EMAIL_PROVIDER: 'console', JWT_SECRET: 'test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  server.stdout.on('data', (d) => { stdout += d.toString(); });
  server.stderr.on('data', (d) => { stdout += d.toString(); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const kill = () => new Promise((res) => { server.on('exit', res); server.kill('SIGTERM'); setTimeout(res, 2000); });

  try {
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(API + '/api/health'); if (r.ok) break; } catch {}
      await sleep(250);
    }

    let r = await req('POST', '/api/auth/signup', { body: { orgName: 'ERA Test Org', name: 'Owner', email: 'owner@eratest.io', password: 'TestPass123!' } });
    ok('owner signup', [200, 201].includes(r.status) && !!r.json.token, `status=${r.status} ${JSON.stringify(r.json).slice(0, 150)}`);
    const token = r.json.token;

    const mkClaim = async (cn, patient, dos, billed) => {
      const cr = await req('POST', '/api/claims', { token, body: { claim_number: cn, patient_name: patient, payer: 'Aetna', service_date: dos, billed_amount: billed } });
      ok(`create ${cn}`, cr.status === 201, `status=${cr.status} ${JSON.stringify(cr.json).slice(0, 150)}`);
      return cr.json.id;
    };
    const idA = await mkClaim('CLM-A', 'Alice Paid', '2026-09-01', 200);
    const idB = await mkClaim('CLM-B', 'Bob Partial', '2026-09-02', 300);
    const idC = await mkClaim('CLM-C', 'Carol Denied', '2026-09-03', 150);
    const idD = await mkClaim('CLM-D', 'Dan Variance', '2026-09-04', 100);
    const idE = await mkClaim('CLM-E', 'Eve Manual', '2026-09-05', 120);
    const idF = await mkClaim('CLM-F', 'Frank Zero', '2026-09-06', 80);

    const fd = new FormData();
    fd.append('file', new Blob([ERA_835], { type: 'text/plain' }), 'aetna-835.txt');
    r = await req('POST', '/api/era/upload-835', { token, form: fd });
    ok('upload 835 succeeds', r.status === 200, `status=${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
    const s = r.json;
    ok('payer + check parsed', s.payer === 'AETNA' && s.checkNumber === 'EFT123456', JSON.stringify({ payer: s.payer, chk: s.checkNumber }));
    ok('pay date parsed', s.payDate === '2026-10-20', String(s.payDate));
    ok('matched = 6', s.matched === 6, `matched=${s.matched}`);
    ok('unmatched lists CLP-UNKNOWN', Array.isArray(s.unmatched) && s.unmatched.includes('CLP-UNKNOWN'), JSON.stringify(s.unmatched));
    ok('autoPosted = 4 (A,B,C,F)', s.autoPosted === 4, `autoPosted=${s.autoPosted}`);
    ok('exceptions = 3 (variance, unmatched, reversal)', s.exceptions === 3, `exceptions=${s.exceptions}`);
    ok('paid = 2, denied = 1, partial = 1', s.paid === 2 && s.denied === 1 && s.partial === 1, JSON.stringify({ paid: s.paid, denied: s.denied, partial: s.partial }));
    ok('totals: billed 1150 / paid 770 / plb -25', s.totals.billed === 1150 && s.totals.paid === 770 && s.totals.plb === -25, JSON.stringify(s.totals));
    const eraId = s.remittanceId;
    ok('remittance id returned', !!eraId);

    const claim = async (id) => (await req('GET', `/api/claims/${id}`, { token })).json;
    let c = await claim(idA);
    ok('CLM-A paid in full + ICN stored', c.status === 'paid' && c.paid_amount === 200 && c.payer_icn === 'ICNA001', JSON.stringify({ st: c.status, paid: c.paid_amount, icn: c.payer_icn }));
    c = await claim(idB);
    ok('CLM-B paid, allowed 230, adj 70, patient resp 30', c.status === 'paid' && c.paid_amount === 200 && c.allowed_amount === 230 && c.adjustment_amount === 70 && c.patient_resp_amount === 30,
      JSON.stringify({ st: c.status, paid: c.paid_amount, allowed: c.allowed_amount, adj: c.adjustment_amount, pr: c.patient_resp_amount }));
    c = await claim(idC);
    ok('CLM-C denied with reason', c.status === 'denied' && /197/.test(c.denial_reason || ''), JSON.stringify({ st: c.status, dr: c.denial_reason }));
    c = await claim(idF);
    ok('CLM-F in AR with $80 patient responsibility', c.status === 'in_ar' && c.patient_resp_amount === 80 && c.paid_amount === 0, JSON.stringify({ st: c.status, pr: c.patient_resp_amount }));
    c = await claim(idD);
    ok('CLM-D untouched (variance held)', c.status === 'pending' && c.paid_amount === 0, JSON.stringify({ st: c.status, paid: c.paid_amount }));

    r = await req('GET', '/api/era/remittances', { token });
    ok('remittance list: 1 row, partially_posted, 4 posted', r.json.remittances.length === 1
      && r.json.remittances[0].status === 'partially_posted' && r.json.remittances[0].posted_count === 4,
      JSON.stringify(r.json.remittances[0] || {}).slice(0, 200));

    r = await req('GET', `/api/era/remittances/${eraId}`, { token });
    const lines = r.json.lines || [];
    ok('detail returns 7 lines', lines.length === 7, `n=${lines.length}`);
    const lineD = lines.find((l) => l.clp_ref === 'CLM-D');
    const lineU = lines.find((l) => l.clp_ref === 'CLP-UNKNOWN');
    const lineG = lines.find((l) => l.status_code === '22');
    ok('variance line pending with variance flag + $20 variance', lineD.post_status === 'pending' && lineD.flags.includes('variance') && lineD.variance === 20,
      JSON.stringify(lineD || {}).slice(0, 200));
    ok('unmatched line has suggestion = CLM-E', lineU.post_status === 'pending' && lineU.flags.includes('unmatched') && lineU.suggested_claim_id === idE,
      JSON.stringify({ flags: lineU.flags, sug: lineU.suggested_claim_id, idE }));
    ok('reversal line held as exception', lineG.post_status === 'pending' && lineG.flags.includes('reversal'), JSON.stringify(lineG.flags || []));

    // Manual post of the variance line
    r = await req('POST', `/api/era/lines/${lineD.id}/post`, { token });
    ok('manual post variance line', r.status === 200 && r.json.ok, `status=${r.status} ${JSON.stringify(r.json).slice(0, 150)}`);
    c = await claim(idD);
    ok('CLM-D now in AR, $50 paid, $20 balance', c.status === 'in_ar' && c.paid_amount === 50 && c.adjustment_amount === 30,
      JSON.stringify({ st: c.status, paid: c.paid_amount, adj: c.adjustment_amount }));

    // Double-post protection
    r = await req('POST', `/api/era/lines/${lineD.id}/post`, { token });
    ok('double post rejected (409)', r.status === 409, `status=${r.status}`);

    // Manual match + post for the unmatched line
    r = await req('POST', `/api/era/lines/${lineU.id}/match`, { token, body: { claim_id: idE, post: true } });
    ok('manual match + post', r.status === 200 && r.json.posted === true, `status=${r.status} ${JSON.stringify(r.json).slice(0, 150)}`);
    c = await claim(idE);
    ok('CLM-E paid via manual match', c.status === 'paid' && c.paid_amount === 120, JSON.stringify({ st: c.status, paid: c.paid_amount }));

    // Ignore the reversal line
    r = await req('POST', `/api/era/lines/${lineG.id}/ignore`, { token });
    ok('ignore reversal line', r.status === 200 && r.json.ok, `status=${r.status}`);

    r = await req('GET', '/api/era/remittances', { token });
    ok('remittance fully posted after resolution', r.json.remittances[0].status === 'posted' && r.json.remittances[0].posted_count === 6,
      JSON.stringify({ st: r.json.remittances[0].status, pc: r.json.remittances[0].posted_count }));

    // Duplicate file guard
    const fd2 = new FormData();
    fd2.append('file', new Blob([ERA_835], { type: 'text/plain' }), 'aetna-835.txt');
    r = await req('POST', '/api/era/upload-835', { token, form: fd2 });
    ok('same file re-upload blocked (409)', r.status === 409, `status=${r.status}`);

    // Reconciliation
    r = await req('GET', '/api/era/reconciliation', { token });
    ok('reconciliation totals', r.json.totals.paid === 770 && Number(r.json.totals.posted_lines) === 6 && Number(r.json.totals.pending_lines) === 0,
      JSON.stringify(r.json.totals));
    ok('reconciliation by payer has AETNA', r.json.byPayer.length === 1 && r.json.byPayer[0].payer === 'AETNA', JSON.stringify(r.json.byPayer).slice(0, 150));
    ok('no open exceptions remain', r.json.exceptions.length === 0, `n=${r.json.exceptions.length}`);

    r = await req('GET', '/api/era/reconciliation.csv', { token });
    ok('CSV export', r.status === 200 && r.text.includes('AETNA') && r.text.includes('EFT123456'), `status=${r.status}`);

    // Digest still works (route preserved)
    r = await req('GET', '/api/era/digest', { token });
    ok('digest endpoint intact', r.status === 200 && !!r.json.date, `status=${r.status}`);

    // Match candidates search
    r = await req('GET', '/api/era/match-candidates?q=CLM-B', { token });
    ok('match candidates finds CLM-B', r.status === 200 && r.json.claims.some((x) => x.claim_number === 'CLM-B'), `status=${r.status}`);

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) console.log('\n--- server log tail ---\n' + stdout.slice(-1500));
  } finally {
    await kill();
  }
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); process.exit(1); });
