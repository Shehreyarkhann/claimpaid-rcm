// agent-phase3-test.cjs — Agent Phase 3 verification.
// Boots the real server against the scripted fake model transport plus a
// stub vendor/AI server. Verifies:
//   (unit) disposition recommender math on crafted CAS inputs; vendor
//          mode labeling (Stedi test key, Availity demo env); Stedi AAA
//          extraction.
//   (WS1) check_eligibility runs the real vendor path against a stub REST
//          vendor and stores the lookup; missing identifiers refuse
//          honestly. scrub_claim output matches the scrubber's direct
//          output. suggest_codes preserves an Abstain (no action), and a
//          good run proposes ONLY Valid codes; apply_codes approve ->
//          claim updated via the real path, reject -> unchanged, with
//          coding decisions recorded both ways.
//   (WS2) era_exceptions lists deterministic dispositions; resolve flows
//          (chat-proposed + endpoint-proposed) post through the existing
//          engine on approve and no-op on reject; unmatched lines refuse.
//   (WS3) insights shapes + figures; claim analysis predictions (overturn
//          from seeded stats, pay likelihood from seeded ERA lines, thin
//          data labeled); worklist items carry predictions.
//   (WS5) brief generation reconciles decided appeal outcomes into
//          agent_outcome_stats and plan items gain the prediction basis.
//   (gate) with the agent disabled, insights 403s and the worklist
//          response carries no prediction fields.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = '/tmp/agent-p3-test';
const FAKE = path.join(TMP, 'fake-transport.cjs');
const LINE_FILE = path.join(TMP, 'resolve-line.txt');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const GOOD_NOTE = 'Patient presents with lower back pain after lifting a heavy box at work. Examination reveals paraspinal muscle spasm and limited range of motion. Assessed as acute low back pain without sciatica. Plan: NSAIDs, heat therapy, activity modification, and follow up in two weeks if not improved.';
const ABSTAIN_NOTE = 'ABSTAIN case: brief telephone refill request. No examination performed and no symptoms documented. Administrative call only, duration three minutes, refill authorized by the covering provider.';

fs.writeFileSync(FAKE, `'use strict';
const fs = require('fs');
async function transport({ messages }) {
  const last = messages[messages.length - 1];
  const usage = { inputTokens: 50, outputTokens: 10 };
  if (last && last.toolResults) {
    const texts = [];
    for (const r of last.toolResults) {
      let data = {};
      try { data = JSON.parse(r.output); } catch {}
      if (data && data.error) texts.push('Tool said: ' + data.error);
      else if (data && data.coverage_active !== undefined) texts.push('Eligibility mode=' + data.mode + ' active=' + data.coverage_active + ' plan=' + data.plan_name);
      else if (data && data.band) texts.push('Scrub score=' + data.score + ' status=' + data.status + ' errors=' + data.errors.length + ' warnings=' + data.warnings.length);
      else if (data && data.assessment) texts.push('Assessment=' + data.assessment + ' valid=' + data.summary.valid + ' review=' + data.summary.review + ' action=' + data.action_id);
      else if (data && Array.isArray(data.exceptions)) texts.push('Exceptions=' + data.exceptions.map((e) => e.era_line_id + ':' + e.recommendation.disposition).join(','));
      else if (data && data.action_id && data.disposition) texts.push('Proposed action=' + data.action_id + ' disposition=' + data.disposition);
      else if (data && data.action_id) texts.push('Draft appeal created (action ' + data.action_id + ').');
    }
    return { text: texts.join(' | ') || 'Done.', toolCalls: [], stopReason: 'end_turn', usage };
  }
  const text = last && typeof last.content === 'string' ? last.content : '';
  if (text.includes('MORNING BRIEF NARRATIVE')) {
    return { text: 'A busy queue today — start with the filing deadline.', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 300, outputTokens: 40 } };
  }
  const cn = (text.match(/CLM-\\d+/) || [])[0];
  if (/eligibility/i.test(text)) return { text: '', toolCalls: [{ id: 't1', name: 'check_eligibility', input: { claim_number: cn } }], stopReason: 'tool_use', usage };
  if (/scrub/i.test(text)) return { text: '', toolCalls: [{ id: 't2', name: 'scrub_claim', input: { claim_number: cn } }], stopReason: 'tool_use', usage };
  if (/abstain/i.test(text)) return { text: '', toolCalls: [{ id: 't3', name: 'suggest_codes', input: { claim_number: cn, note: ${JSON.stringify(ABSTAIN_NOTE)} } }], stopReason: 'tool_use', usage };
  if (/codes/i.test(text)) return { text: '', toolCalls: [{ id: 't4', name: 'suggest_codes', input: { claim_number: cn, note: ${JSON.stringify(GOOD_NOTE)} } }], stopReason: 'tool_use', usage };
  if (/exceptions/i.test(text)) return { text: '', toolCalls: [{ id: 't5', name: 'era_exceptions', input: {} }], stopReason: 'tool_use', usage };
  if (/resolve/i.test(text)) {
    const lineId = parseInt(fs.readFileSync(${JSON.stringify(LINE_FILE)}, 'utf8').trim(), 10);
    return { text: '', toolCalls: [{ id: 't6', name: 'resolve_exception', input: { era_line_id: lineId } }], stopReason: 'tool_use', usage };
  }
  return { text: 'OK.', toolCalls: [], stopReason: 'end_turn', usage };
}
module.exports = transport;
module.exports.transport = transport;
module.exports.default = transport;
`);

const servers = [];
async function boot(port, env) {
  const dbPath = path.join(TMP, `test-${port}.db`);
  const server = spawn('node', ['src/index.js'], {
    cwd: path.join(REPO, 'server'),
    env: {
      ...process.env, PORT: String(port), DB_PATH: dbPath, JWT_SECRET: 'test-secret',
      EHR_AUTOPULL: 'off', STRIPE_SECRET_KEY: '',
      AGENT_ENABLED: '', ANTHROPIC_API_KEY: '', AGENT_API_KEY: '', AGENT_BASE_URL: '', AGENT_TRANSPORT_MODULE: '', AGENT_MODEL: '',
      AI_DB_PATH: '', AI_SERVICE_URL: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server:${port}] ${d}`));
  servers.push(server);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) return { server, base, dbPath }; } catch { /* wait */ }
    await sleep(500);
  }
  throw new Error(`server on ${port} never became healthy`);
}

async function api(base, method, p, body, token) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  // One stub server: REST eligibility vendor (/check) + AI code-assist.
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/check') {
        res.end(JSON.stringify({
          coverage_active: true, plan_name: 'Stub PPO Gold', plan_type: 'PPO', group_number: 'G123',
          copay_primary: 25, deductible_individual: 1500, deductible_remaining: 900,
        }));
      } else if (req.url === '/api/v1/code-assist') {
        let note = '';
        try { note = JSON.parse(body).note_text || ''; } catch { /* ignore */ }
        if (note.includes('ABSTAIN')) { res.end(JSON.stringify({ suggestions: [], model: 'stub-model' })); return; }
        res.end(JSON.stringify({
          model: 'stub-model',
          suggestions: [
            { code: '99213', type: 'CPT', confidence: 0.92, evidence: 'lower back pain', rationale: 'Established patient office visit documented' },
            { code: 'M54.5', type: 'ICD10', confidence: 0.9, evidence: 'lower back pain', rationale: 'Low back pain diagnosis' },
            { code: '97010', type: 'CPT', confidence: 0.4, evidence: 'applied hot packs', rationale: 'Hot pack therapy' },
          ],
        }));
      } else { res.writeHead(404); res.end(); }
    });
  });
  await new Promise((r) => stub.listen(4299, '127.0.0.1', r));

  try {
    console.log('— http: boot A (phase 3) —');
    const { base, dbPath } = await boot(4243, {
      AGENT_ENABLED: '1', ANTHROPIC_API_KEY: 'test-key-not-real', AGENT_TRANSPORT_MODULE: FAKE,
      AI_SERVICE_URL: 'http://127.0.0.1:4299',
    });
    const sA = await api(base, 'POST', '/api/auth/signup', { orgName: 'P3 Org A', name: 'Ann Owner', email: 'a@p3.test', password: 'Test1234!' });
    const tokA = sA.data.token;
    check('org A signup', sA.status === 201 && !!tokA, JSON.stringify(sA.data).slice(0, 150));
    const sB = await api(base, 'POST', '/api/auth/signup', { orgName: 'P3 Org B', name: 'Bob Owner', email: 'b@p3.test', password: 'Test1234!' });
    const tokB = sB.data.token;
    check('org B signup', sB.status === 201 && !!tokB);

    // In-process units against the same DB file (reads only).
    process.env.DB_PATH = dbPath;
    const eraResolve = require(path.join(REPO, 'server/src/agent/eraResolve.js'));
    const eligRoute = require(path.join(REPO, 'server/src/routes/eligibility.js'));
    const vendors = require(path.join(REPO, 'server/src/eligibility/vendors.js'));
    const { scrubClaim: directScrub } = require(path.join(REPO, 'server/src/scrub.js'));

    console.log('— unit: recommender + vendor modes + AAA —');
    {
      const mk = (over) => ({ billed: 0, paid: 0, patient_resp: 0, adjustments: '[]', flags: '[]', status_code: '1', denial_reason: null, match_claim_id: 5, ...over });
      const pr = eraResolve.recommendDisposition(mk({ billed: 200, paid: 80, patient_resp: 20, adjustments: JSON.stringify([{ group: 'CO', code: '45', amount: 100 }, { group: 'PR', code: '1', amount: 20 }]), flags: '["variance"]' }));
      check('recommender: PR case -> patient_responsibility, balanced math', pr.disposition === 'patient_responsibility' && pr.can_resolve && pr.arithmetic.residual === 0 && pr.arithmetic.contractual === 100, JSON.stringify(pr));
      const co = eraResolve.recommendDisposition(mk({ billed: 150, paid: 60, adjustments: JSON.stringify([{ group: 'CO', code: '45', amount: 90 }]), flags: '["variance"]' }));
      check('recommender: CO case -> contractual_adjustment', co.disposition === 'contractual_adjustment' && co.arithmetic.residual === 0, JSON.stringify(co));
      const den = eraResolve.recommendDisposition(mk({ billed: 100, paid: 0, adjustments: JSON.stringify([{ group: 'CO', code: '50', amount: 100 }]), flags: '["denial"]', denial_reason: 'CO-50' }));
      check('recommender: denial case -> rebill_or_appeal', den.disposition === 'rebill_or_appeal' && den.can_resolve, JSON.stringify(den));
      const wo = eraResolve.recommendDisposition(mk({ billed: 100, paid: 0, adjustments: JSON.stringify([{ group: 'OA', code: '23', amount: 100 }]), flags: '["variance"]' }));
      check('recommender: OA zero-pay case -> write_off', wo.disposition === 'write_off' && wo.arithmetic.residual === 0, JSON.stringify(wo));
      const un = eraResolve.recommendDisposition(mk({ billed: 75, paid: 0, match_claim_id: null, flags: '["unmatched"]' }));
      check('recommender: unmatched -> manual_match, cannot resolve', un.disposition === 'manual_match' && un.can_resolve === false, JSON.stringify(un));

      check('mode: Stedi test_ key -> test', eligRoute.eligibilityMode({ vendor: 'stedi' }, { raw_response: { test_mode: true } }) === 'test');
      check('mode: Stedi live key -> live', eligRoute.eligibilityMode({ vendor: 'stedi' }, { raw_response: { test_mode: false } }) === 'live');
      check('mode: Availity demo env -> test', eligRoute.eligibilityMode({ vendor: 'availity', availity_env: 'demo-tst' }, { raw_response: {} }) === 'test');
      check('mode: Availity production -> live', eligRoute.eligibilityMode({ vendor: 'availity', availity_env: 'production' }, { raw_response: {} }) === 'live');
      check('mode: REST vendor -> live', eligRoute.eligibilityMode({ vendor: 'rest' }, { raw_response: {} }) === 'live');
      const aaa = vendors.collectStediAaaErrors({ subscriber: { aaaErrors: [{ code: '71', description: 'DOB mismatch' }] }, errors: [{ code: '75', description: 'Not in group' }] });
      check('stedi AAA extraction across levels', aaa.length === 2 && aaa.some((e) => e.code === '71') && aaa.some((e) => e.code === '75'), JSON.stringify(aaa));
    }

    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(dbPath);
    const orgA = raw.prepare("SELECT id FROM orgs WHERE name = 'P3 Org A'").get().id;
    const orgB = raw.prepare("SELECT id FROM orgs WHERE name = 'P3 Org B'").get().id;
    const payerA = raw.prepare("SELECT id FROM payers WHERE org_id = ? AND name = 'Aetna'").get(orgA).id;

    // Org A uses the stub REST eligibility vendor.
    raw.prepare("UPDATE orgs SET eligibility_vendor = 'rest', eligibility_endpoint = 'http://127.0.0.1:4299/check' WHERE id = ?").run(orgA);
    raw.prepare('INSERT INTO payer_filing_rules (org_id, payer_id, filing_days) VALUES (?, ?, 90) ON CONFLICT(org_id, payer_id) DO UPDATE SET filing_days = 90').run(orgA, payerA);

    const insClaim = raw.prepare(`INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date,
      billed_amount, paid_amount, status, denial_reason, cpt_codes, icd_codes, rendering_npi, patient_dob, member_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`);
    const C = {};
    const addClaim = (num, over = {}) => {
      const v = {
        patient: 'Pat ' + num, dos: "date('now', '-5 days')", billed: 100, paid: 0, status: 'pending',
        denial: null, cpt: null, icd: null, npi: null, dob: null, member: null, created: null, ...over,
      };
      // service_date is inserted as a SQL expression only for the default; handle explicitly:
      const info = raw.prepare(`INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date,
        billed_amount, paid_amount, status, denial_reason, cpt_codes, icd_codes, rendering_npi, patient_dob, member_id, created_at)
        VALUES (?, ?, ?, ?, ${v.dosSql || "date('now', '-5 days')"}, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`)
        .run(orgA, num, v.patient, payerA, v.billed, v.paid, v.status, v.denial, v.cpt, v.icd, v.npi, v.dob, v.member, v.created);
      C[num] = Number(info.lastInsertRowid);
      return C[num];
    };
    addClaim('CLM-3001', { patient: 'Elig Patient', cpt: '99213', icd: 'M54.5', npi: '1234567890', dob: '1980-05-01', member: 'MEM12345', billed: 200 });
    addClaim('CLM-3002', { billed: 150 });
    addClaim('CLM-3003', { status: 'in_ar', billed: 200, cpt: '99213', icd: 'M54.5' });
    addClaim('CLM-3004', { status: 'in_ar', billed: 150 });
    addClaim('CLM-3005', { billed: 100 });
    addClaim('CLM-3006', { status: 'in_ar', billed: 100 });
    addClaim('CLM-3007', { billed: 120 });
    addClaim('CLM-3008', { billed: 90 });
    addClaim('CLM-3009', { billed: 100 });
    addClaim('CLM-3018', { billed: 1000, dosSql: "date('now', '-80 days')", cpt: '99213', icd: 'M54.5' });
    addClaim('CLM-3019', { status: 'in_ar', billed: 50 });
    addClaim('CLM-3020', { status: 'denied', denial: 'CO-50', billed: 5000 });
    addClaim('CLM-3025', { status: 'denied', denial: 'CO-97', billed: 250 });
    // Posted-line host claims (ERA paid-rate pool): 3 of 4 paid.
    addClaim('CLM-3014', { status: 'paid', billed: 100, paid: 100, cpt: '99213', icd: 'M54.5' });
    addClaim('CLM-3015', { status: 'paid', billed: 90, paid: 90, cpt: '99213', icd: 'M54.5' });
    addClaim('CLM-3016', { status: 'paid', billed: 110, paid: 110, cpt: '99213', icd: 'M54.5' });
    addClaim('CLM-3017', { status: 'paid', billed: 80, paid: 0, cpt: '99213', icd: 'M54.5' });
    // Denial-trend prior window: 4 paid claims 45 days ago.
    for (const n of ['CLM-3101', 'CLM-3102', 'CLM-3103', 'CLM-3104']) {
      addClaim(n, { status: 'paid', billed: 100, paid: 100, created: "2026-09-13 10:00:00", dosSql: "date('now', '-45 days')" });
      raw.prepare('UPDATE claims SET created_at = datetime(\'now\', \'-45 days\') WHERE id = ?').run(C[n]);
    }

    const eraId = Number(raw.prepare("INSERT INTO era_remittances (org_id, payer_name, check_number, payment_amount, status) VALUES (?, 'Aetna', 'CHK-P3', 0, 'received')").run(orgA).lastInsertRowid);
    const insLine = raw.prepare(`INSERT INTO era_claim_lines (era_id, org_id, clp_ref, patient_name, status_code,
      billed, paid, patient_resp, adjustments, denial_reason, flags, match_claim_id, post_status, posted_at)
      VALUES (?, ?, ?, ?, '1', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const L = {};
    const addLine = (key, clp, claimId, billed, paid, pr, adj, flags, denial = null, postStatus = 'pending') => {
      L[key] = Number(insLine.run(eraId, orgA, clp, 'Pat ' + clp, billed, paid, pr,
        JSON.stringify(adj), denial, JSON.stringify(flags), claimId, postStatus,
        postStatus === 'posted' ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null).lastInsertRowid);
    };
    addLine('PR', 'CLM-3003', C['CLM-3003'], 200, 80, 20, [{ group: 'CO', code: '45', amount: 100 }, { group: 'PR', code: '1', amount: 20 }], ['variance']);
    addLine('CO', 'CLM-3004', C['CLM-3004'], 150, 60, 0, [{ group: 'CO', code: '45', amount: 90 }], ['variance']);
    addLine('DEN', 'CLM-3005', C['CLM-3005'], 100, 0, 0, [{ group: 'CO', code: '50', amount: 100 }], ['denial'], 'CO-50 — Non-covered service');
    addLine('WO', 'CLM-3006', C['CLM-3006'], 100, 0, 0, [{ group: 'OA', code: '23', amount: 100 }], ['variance']);
    addLine('UN', 'EXT-999', null, 75, 0, 0, [], ['unmatched']);
    addLine('RJ', 'CLM-3019', C['CLM-3019'], 50, 20, 0, [{ group: 'CO', code: '45', amount: 30 }], ['variance']);
    addLine('P1', 'CLM-3014', C['CLM-3014'], 100, 100, 0, [], [], null, 'posted');
    addLine('P2', 'CLM-3015', C['CLM-3015'], 90, 90, 0, [], [], null, 'posted');
    addLine('P3', 'CLM-3016', C['CLM-3016'], 110, 110, 0, [], [], null, 'posted');
    addLine('P4', 'CLM-3017', C['CLM-3017'], 80, 0, 0, [], [], null, 'posted');

    // ---------------- WS1: eligibility ----------------
    console.log('— WS1: eligibility + scrub + codes —');
    const e1 = await api(base, 'POST', '/api/agent/chat', { message: 'Check eligibility for CLM-3001' }, tokA);
    check('eligibility: chat 200', e1.status === 200, JSON.stringify(e1.data).slice(0, 200));
    check('eligibility: reply reports live mode + active + plan', typeof e1.data.reply === 'string' && e1.data.reply.includes('mode=live') && e1.data.reply.includes('active=true') && e1.data.reply.includes('Stub PPO Gold'), e1.data.reply);
    check('eligibility: chip label', Array.isArray(e1.data.tool_events) && e1.data.tool_events[0] && e1.data.tool_events[0].label.startsWith('Checked eligibility'), JSON.stringify(e1.data.tool_events || []));
    const lookupRow = raw.prepare("SELECT * FROM eligibility_lookups WHERE org_id = ? AND payer = 'Aetna'").get(orgA);
    check('eligibility: lookup stored like a tab-run check', !!lookupRow && lookupRow.coverage_active === 1 && lookupRow.vendor === 'rest', JSON.stringify(lookupRow || {}).slice(0, 160));

    const e2 = await api(base, 'POST', '/api/agent/chat', { message: 'Check eligibility for CLM-3008' }, tokA);
    check('eligibility: missing identifiers refused honestly', e2.status === 200 && typeof e2.data.reply === 'string' && e2.data.reply.includes('missing') && e2.data.reply.includes('date of birth'), e2.data.reply);

    // ---------------- WS1: scrub passthrough ----------------
    const claim3009 = raw.prepare('SELECT * FROM claims WHERE id = ?').get(C['CLM-3009']);
    const expectedScrub = directScrub(claim3009);
    const sc = await api(base, 'POST', '/api/agent/chat', { message: 'Scrub CLM-3009' }, tokA);
    check('scrub: chat 200', sc.status === 200, JSON.stringify(sc.data).slice(0, 160));
    check('scrub: tool output matches the scrubber exactly',
      typeof sc.data.reply === 'string'
      && sc.data.reply.includes(`score=${expectedScrub.score}`)
      && sc.data.reply.includes(`errors=${expectedScrub.errors}`)
      && sc.data.reply.includes(`warnings=${expectedScrub.warnings}`),
      `${sc.data.reply} vs score=${expectedScrub.score} errors=${expectedScrub.errors} warnings=${expectedScrub.warnings}`);
    check('scrub: chip label', Array.isArray(sc.data.tool_events) && sc.data.tool_events[0] && sc.data.tool_events[0].label.startsWith('Scrubbed claim'), JSON.stringify(sc.data.tool_events || []));

    // ---------------- WS1: suggest_codes + apply_codes ----------------
    const c1 = await api(base, 'POST', '/api/agent/chat', { message: 'Suggest codes for CLM-3002' }, tokA);
    check('codes: chat 200 with ready assessment', c1.status === 200 && typeof c1.data.reply === 'string' && c1.data.reply.includes('Assessment=ready'), JSON.stringify(c1.data).slice(0, 220));
    check('codes: 2 valid + 1 review verdicts', c1.data.reply.includes('valid=2') && c1.data.reply.includes('review=1'), c1.data.reply);
    const applyAction = (c1.data.actions || [])[0];
    check('codes: apply_codes action proposed', !!applyAction && applyAction.kind === 'apply_codes' && applyAction.status === 'pending', JSON.stringify(c1.data.actions || []).slice(0, 200));
    check('codes: action carries ONLY the Valid codes', JSON.stringify((applyAction.payload.codes || []).map((x) => x.code).sort()) === JSON.stringify(['99213', 'M54.5']), JSON.stringify(applyAction.payload || {}));
    const ap1 = await api(base, 'POST', `/api/agent/actions/${applyAction.id}/approve`, {}, tokA);
    check('codes: approve executes', ap1.status === 200 && ap1.data.action.status === 'executed', JSON.stringify(ap1.data).slice(0, 200));
    const claim3002 = raw.prepare('SELECT cpt_codes, icd_codes FROM claims WHERE id = ?').get(C['CLM-3002']);
    check('codes: claim updated via the real path', (claim3002.cpt_codes || '').includes('99213') && (claim3002.icd_codes || '').includes('M54.5'), JSON.stringify(claim3002));
    const job1 = raw.prepare("SELECT id FROM coding_jobs WHERE org_id = ? AND claim_id = ? ORDER BY id DESC LIMIT 1").get(orgA, C['CLM-3002']);
    const decAccepted = raw.prepare("SELECT COUNT(*) AS n FROM coding_decisions WHERE job_id = ? AND decision = 'accepted'").get(job1.id).n;
    check('codes: accepted decisions recorded', decAccepted === 2, `n=${decAccepted}`);

    const c2 = await api(base, 'POST', '/api/agent/chat', { message: 'Suggest codes for CLM-3007' }, tokA);
    const rejectAction = (c2.data.actions || [])[0];
    check('codes: second proposal created', !!rejectAction && rejectAction.kind === 'apply_codes', JSON.stringify(c2.data).slice(0, 160));
    const rj = await api(base, 'POST', `/api/agent/actions/${rejectAction.id}/reject`, {}, tokA);
    check('codes: reject recorded', rj.status === 200 && rj.data.action.status === 'rejected');
    const claim3007 = raw.prepare('SELECT cpt_codes, icd_codes FROM claims WHERE id = ?').get(C['CLM-3007']);
    check('codes: reject leaves the claim unchanged', !claim3007.cpt_codes && !claim3007.icd_codes, JSON.stringify(claim3007));
    const job2 = raw.prepare("SELECT id FROM coding_jobs WHERE org_id = ? AND claim_id = ? ORDER BY id DESC LIMIT 1").get(orgA, C['CLM-3007']);
    const decRejected = raw.prepare("SELECT COUNT(*) AS n FROM coding_decisions WHERE job_id = ? AND decision = 'rejected'").get(job2.id).n;
    check('codes: rejected decisions recorded', decRejected === 2, `n=${decRejected}`);

    const c3 = await api(base, 'POST', '/api/agent/chat', { message: 'Suggest codes abstain case for CLM-3002' }, tokA);
    check('codes: abstention preserved verbatim', c3.status === 200 && typeof c3.data.reply === 'string' && c3.data.reply.includes('Assessment=abstain') && c3.data.reply.includes('action=null'), c3.data.reply);
    check('codes: abstention creates no action', (c3.data.actions || []).length === 0, JSON.stringify(c3.data.actions || []));

    // ---------------- WS3: insights + pay likelihood (before resolutions change the pool) ----------------
    console.log('— WS3: insights + analysis —');
    const ins = await api(base, 'GET', '/api/agent/insights', null, tokA);
    check('insights: 200 with all sections', ins.status === 200 && !!ins.data.filing_risk_14d && !!ins.data.expected_collections_30d && Array.isArray(ins.data.denial_trend_watch) && !!ins.data.exception_backlog, JSON.stringify(ins.data).slice(0, 200));
    check('insights: filing risk is the $1,000 claim only', ins.data.filing_risk_14d.claims === 1 && ins.data.filing_risk_14d.amount === 1000, JSON.stringify(ins.data.filing_risk_14d));
    check('insights: exception backlog = 6 lines / $675', ins.data.exception_backlog.count === 6 && ins.data.exception_backlog.amount === 675, JSON.stringify(ins.data.exception_backlog));
    check('insights: expected collections covers all open claims at the 75% ERA rate', ins.data.expected_collections_30d.claims_with_estimate === ins.data.expected_collections_30d.open_claims && ins.data.expected_collections_30d.amount > 0, JSON.stringify(ins.data.expected_collections_30d));
    check('insights: expected collections labeled early estimate (n=4)', ins.data.expected_collections_30d.label === 'early estimate' && ins.data.expected_collections_30d.sample_size === 4, JSON.stringify(ins.data.expected_collections_30d));
    const watch = ins.data.denial_trend_watch.find((w) => w.payer === 'Aetna');
    check('insights: Aetna on the denial watch with a rising rate', !!watch && watch.delta_points >= 5 && watch.current_rate > watch.prior_rate, JSON.stringify(ins.data.denial_trend_watch));

    const an3018 = await api(base, 'GET', `/api/agent/claims/${C['CLM-3018']}/analysis`, null, tokA);
    check('analysis: pay likelihood from ERA family pool (0.75, n=4)', an3018.status === 200 && an3018.data.pay_likelihood && an3018.data.pay_likelihood.value === 0.75 && an3018.data.pay_likelihood.sampleSize === 4 && an3018.data.pay_likelihood.basis.includes('procedure family') && an3018.data.pay_likelihood.label === 'early estimate', JSON.stringify(an3018.data.pay_likelihood || {}));
    check('analysis: filing risk critical at ~10 days left', an3018.data.filing_risk && an3018.data.filing_risk.state === 'critical' && an3018.data.filing_risk.days_left >= 8 && an3018.data.filing_risk.days_left <= 10, JSON.stringify(an3018.data.filing_risk || {}));
    check('analysis: scrub summary shape', !!an3018.data.scrub && typeof an3018.data.scrub.score === 'number' && Array.isArray(an3018.data.recommendations), JSON.stringify(an3018.data).slice(0, 200));

    const an3025 = await api(base, 'GET', `/api/agent/claims/${C['CLM-3025']}/analysis`, null, tokA);
    const rec3025 = (an3025.data.recommendations || []).find((r) => r.kind === 'draft_appeal');
    check('analysis: denied claim recommends a spawnable appeal draft', !!rec3025 && rec3025.spawnable === true, JSON.stringify(an3025.data.recommendations || []));
    check('analysis: no outcome stats yet -> overturn is null, honestly', an3025.data.appeal_overturn && an3025.data.appeal_overturn.value === null && an3025.data.appeal_overturn.basis === 'none', JSON.stringify(an3025.data.appeal_overturn || {}));

    // ---------------- WS2: exceptions + resolutions ----------------
    console.log('— WS2: era exceptions + resolve —');
    const ex = await api(base, 'POST', '/api/agent/chat', { message: 'List the ERA exceptions' }, tokA);
    check('exceptions: chat lists all six with dispositions', ex.status === 200 && typeof ex.data.reply === 'string'
      && ex.data.reply.includes(`${L.PR}:patient_responsibility`)
      && ex.data.reply.includes(`${L.CO}:contractual_adjustment`)
      && ex.data.reply.includes(`${L.DEN}:rebill_or_appeal`)
      && ex.data.reply.includes(`${L.WO}:write_off`)
      && ex.data.reply.includes(`${L.UN}:manual_match`), ex.data.reply);

    fs.writeFileSync(LINE_FILE, String(L.PR));
    const rp = await api(base, 'POST', '/api/agent/chat', { message: 'Resolve that exception' }, tokA);
    const prAction = (rp.data.actions || [])[0];
    check('resolve: chat proposes a resolve_exception card', !!prAction && prAction.kind === 'resolve_exception' && prAction.payload.disposition === 'patient_responsibility', JSON.stringify(rp.data).slice(0, 240));
    const apPr = await api(base, 'POST', `/api/agent/actions/${prAction.id}/approve`, {}, tokA);
    check('resolve: approve executes the posting', apPr.status === 200 && apPr.data.action.status === 'executed' && apPr.data.action.result.posted === true, JSON.stringify(apPr.data).slice(0, 220));
    const claim3003 = raw.prepare('SELECT paid_amount, adjustment_amount, patient_resp_amount, status FROM claims WHERE id = ?').get(C['CLM-3003']);
    check('resolve: claim shows payment + contractual + patient resp, status paid',
      claim3003.paid_amount === 80 && claim3003.adjustment_amount === 100 && claim3003.patient_resp_amount === 20 && claim3003.status === 'paid', JSON.stringify(claim3003));
    const linePr = raw.prepare('SELECT post_status FROM era_claim_lines WHERE id = ?').get(L.PR);
    check('resolve: line marked posted', linePr.post_status === 'posted');

    const propCo = await api(base, 'POST', '/api/agent/actions/propose', { kind: 'resolve_exception', era_line_id: L.CO }, tokA);
    check('propose: resolve_exception via endpoint', propCo.status === 201 && propCo.data.action.kind === 'resolve_exception', JSON.stringify(propCo.data).slice(0, 160));
    await api(base, 'POST', `/api/agent/actions/${propCo.data.action.id}/approve`, {}, tokA);
    const claim3004 = raw.prepare('SELECT paid_amount, adjustment_amount, status FROM claims WHERE id = ?').get(C['CLM-3004']);
    check('propose+approve: contractual line posted', claim3004.paid_amount === 60 && claim3004.adjustment_amount === 90 && claim3004.status === 'paid', JSON.stringify(claim3004));

    const propDen = await api(base, 'POST', '/api/agent/actions/propose', { kind: 'resolve_exception', era_line_id: L.DEN }, tokA);
    await api(base, 'POST', `/api/agent/actions/${propDen.data.action.id}/approve`, {}, tokA);
    const claim3005 = raw.prepare('SELECT status, denial_reason FROM claims WHERE id = ?').get(C['CLM-3005']);
    check('resolve denial: claim enters the denial workflow', claim3005.status === 'denied' && (claim3005.denial_reason || '').includes('CO-50'), JSON.stringify(claim3005));

    const propWo = await api(base, 'POST', '/api/agent/actions/propose', { kind: 'resolve_exception', era_line_id: L.WO }, tokA);
    await api(base, 'POST', `/api/agent/actions/${propWo.data.action.id}/approve`, {}, tokA);
    const lineWo = raw.prepare('SELECT post_status FROM era_claim_lines WHERE id = ?').get(L.WO);
    const claim3006 = raw.prepare('SELECT paid_amount, status FROM claims WHERE id = ?').get(C['CLM-3006']);
    check('resolve write-off: line ignored, claim untouched', lineWo.post_status === 'ignored' && claim3006.paid_amount === 0 && claim3006.status === 'in_ar', `${lineWo.post_status} ${JSON.stringify(claim3006)}`);

    const propRj = await api(base, 'POST', '/api/agent/actions/propose', { kind: 'resolve_exception', era_line_id: L.RJ }, tokA);
    await api(base, 'POST', `/api/agent/actions/${propRj.data.action.id}/reject`, {}, tokA);
    const lineRj = raw.prepare('SELECT post_status FROM era_claim_lines WHERE id = ?').get(L.RJ);
    const claim3019 = raw.prepare('SELECT paid_amount FROM claims WHERE id = ?').get(C['CLM-3019']);
    check('resolve reject: line stays pending, claim unchanged', lineRj.post_status === 'pending' && claim3019.paid_amount === 0, `${lineRj.post_status}`);

    const propUn = await api(base, 'POST', '/api/agent/actions/propose', { kind: 'resolve_exception', era_line_id: L.UN }, tokA);
    check('propose: unmatched line refuses (400)', propUn.status === 400, `got ${propUn.status}`);
    const propBad = await api(base, 'POST', '/api/agent/actions/propose', { kind: 'apply_codes', claim_id: C['CLM-3009'] }, tokA);
    check('propose: apply_codes without a coding run refuses (400)', propBad.status === 400, `got ${propBad.status}`);
    const propDraft = await api(base, 'POST', '/api/agent/actions/propose', { kind: 'draft_appeal', claim_id: C['CLM-3025'] }, tokA);
    check('propose: draft_appeal via endpoint', propDraft.status === 201 && propDraft.data.action.kind === 'draft_appeal' && propDraft.data.action.status === 'pending', JSON.stringify(propDraft.data).slice(0, 160));
    // Clean up the proposed 3025 draft so the brief test below sees its own.
    await api(base, 'POST', `/api/agent/actions/${propDraft.data.action.id}/reject`, {}, tokA);

    // ---------------- WS5: outcomes -> stats -> predictions ----------------
    console.log('— WS5: outcome reconciliation —');
    const insAppeal = raw.prepare("INSERT INTO appeals (org_id, claim_id, assigned_to, status, priority) VALUES (?, ?, NULL, ?, 'medium')");
    const insOutcomeAction = raw.prepare(`INSERT INTO agent_actions (org_id, user_id, convo_id, kind, status, payload, preview, result, decided_at, executed_at)
      VALUES (?, ?, NULL, 'draft_appeal', 'executed', ?, 'letter', ?, datetime('now'), datetime('now'))`);
    const userA = raw.prepare("SELECT id FROM users WHERE email = 'a@p3.test'").get().id;
    const outcomeSeeds = [
      ['CLM-3031', 'won', 'denied', 0],
      ['CLM-3032', 'won', 'denied', 0],
      ['CLM-3033', 'lost', 'denied', 0],
      ['CLM-3034', 'open', 'paid', 300],
    ];
    for (const [num, appealStatus, claimStatus, paidAmt] of outcomeSeeds) {
      const cid = addClaim(num, { status: claimStatus, denial: 'CO-50', billed: 300, paid: paidAmt });
      const apId = Number(insAppeal.run(orgA, cid, appealStatus).lastInsertRowid);
      insOutcomeAction.run(orgA, userA, JSON.stringify({ claim_id: cid, claim_number: num }), JSON.stringify({ appeal_id: apId }));
    }
    const brief = await api(base, 'GET', '/api/agent/brief', null, tokA);
    check('brief: generates (reconciliation runs inside)', brief.status === 200 && !!brief.data.brief, JSON.stringify(brief.data).slice(0, 160));
    const stats = raw.prepare("SELECT * FROM agent_outcome_stats WHERE org_id = ? AND payer_id = ? AND denial_reason = 'CO-50'").get(orgA, payerA);
    check('outcomes: stats rebuilt — 4 decided, 3 overturned (2 won + 1 paid-after-appeal)', !!stats && stats.appeals === 4 && stats.overturned === 3, JSON.stringify(stats || {}));
    const planItem = (brief.data.brief.plan || []).find((p) => p.claim_id === C['CLM-3020']);
    check('brief: plan item for the big denial carries the prediction', !!planItem && !!planItem.prediction && planItem.prediction.value === 0.75 && planItem.prediction.sampleSize === 4, JSON.stringify(planItem || {}).slice(0, 260));
    check('brief: reason line carries the basis text', !!planItem && planItem.reason.includes('overturn 75%'), planItem ? planItem.reason : 'no plan item');

    const an3020 = await api(base, 'GET', `/api/agent/claims/${C['CLM-3020']}/analysis`, null, tokA);
    check('analysis: overturn from stats (0.75, n=4, payer + denial reason, early estimate)',
      an3020.data.appeal_overturn && an3020.data.appeal_overturn.value === 0.75 && an3020.data.appeal_overturn.sampleSize === 4
      && an3020.data.appeal_overturn.basis === 'payer + denial reason' && an3020.data.appeal_overturn.label === 'early estimate',
      JSON.stringify(an3020.data.appeal_overturn || {}));
    const rec3020 = (an3020.data.recommendations || []).find((r) => r.kind === 'draft_appeal');
    check('analysis: brief-proposed draft flips the recommendation to not-spawnable', !!rec3020 && rec3020.spawnable === false, JSON.stringify(an3020.data.recommendations || []));

    const wl = await api(base, 'GET', '/api/worklist?scope=all', null, tokA);
    const wl3020 = (wl.data.items || []).find((i) => i.claim_id === C['CLM-3020']);
    check('worklist: denial item carries the overturn prediction', !!wl3020 && !!wl3020.prediction && wl3020.prediction.kind === 'appeal_overturn' && wl3020.prediction.value === 0.75 && wl3020.prediction.sampleSize === 4, JSON.stringify(wl3020 || {}).slice(0, 260));
    const wl3018 = (wl.data.items || []).find((i) => i.claim_id === C['CLM-3018']);
    check('worklist: filing item carries a pay prediction', !!wl3018 && !!wl3018.prediction && wl3018.prediction.kind === 'pay_likelihood', JSON.stringify(wl3018 || {}).slice(0, 200));

    // ---------------- Cross-org isolation ----------------
    console.log('— isolation —');
    const insB = await api(base, 'GET', '/api/agent/insights', null, tokB);
    check('isolation: org B insights are zeros', insB.status === 200 && insB.data.filing_risk_14d.claims === 0 && insB.data.exception_backlog.count === 0 && insB.data.expected_collections_30d.amount === 0, JSON.stringify(insB.data).slice(0, 200));
    const anCross = await api(base, 'GET', `/api/agent/claims/${C['CLM-3020']}/analysis`, null, tokB);
    check('isolation: org B cannot analyze org A claim (404)', anCross.status === 404, `got ${anCross.status}`);
    raw.close();

    // ---------------- Gate: agent disabled ----------------
    console.log('— http: boot B (agent disabled) —');
    const bootB = await boot(4244, {});
    const sD = await api(bootB.base, 'POST', '/api/auth/signup', { orgName: 'P3 Org D', name: 'Dee Owner', email: 'd@p3.test', password: 'Test1234!' });
    const insD = await api(bootB.base, 'GET', '/api/agent/insights', null, sD.data.token);
    check('disabled: insights 403 AGENT_DISABLED', insD.status === 403 && insD.data.code === 'AGENT_DISABLED', `got ${insD.status} ${JSON.stringify(insD.data).slice(0, 120)}`);
    const rawD = new DatabaseSync(bootB.dbPath);
    const orgD = rawD.prepare("SELECT id FROM orgs WHERE name = 'P3 Org D'").get().id;
    const payerD = rawD.prepare('SELECT id FROM payers WHERE org_id = ? LIMIT 1').get(orgD).id;
    rawD.prepare(`INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date, billed_amount, status)
      VALUES (?, 'CLM-D1', 'Pat D', ?, date('now', '-5 days'), 100, 'denied')`).run(orgD, payerD);
    rawD.close();
    const wlD = await api(bootB.base, 'GET', '/api/worklist?scope=all', null, sD.data.token);
    const itemD = (wlD.data.items || []).find((i) => i.claim_number === 'CLM-D1' || (i.title || '').includes('CLM-D1'));
    check('disabled: worklist works, items carry NO prediction field', wlD.status === 200 && !!itemD && !('prediction' in itemD), JSON.stringify(itemD || {}).slice(0, 200));
  } catch (e) {
    failed++;
    console.log(`  FAIL suite error: ${e.stack || e.message}`);
  } finally {
    stub.close();
    for (const s of servers) { try { s.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
