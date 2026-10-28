// agent-phase4-test.cjs — Agent Phase 4 verification.
// Boots the real server against the scripted fake model transport plus a
// stub vendor/AI server, and a child process for the watchdog (which
// needs a writable DB + a stubbed mailer in-process). Verifies:
//   (WS1) outcome stats gain the angle dimension; the best angle is
//         chosen + stated at n>=5 and absent below; predict prefers the
//         angle-conditioned rate; draft proposals (endpoint + chat)
//         carry the learned angle into the letter.
//   (WS2) watchdog items computed correctly per user; empty -> no send,
//         no log; stubbed-mailer send records the log and dedupe blocks
//         a second same-day run; outside the morning window nothing
//         sends; plans-only + item-less orgs skipped; failed sends are
//         logged as failed; the alerts endpoint mirrors the items.
//   (WS3) POST /api/agent/tools/run executes each read tool through the
//         shared runners (stub vendor / stub AI), enforces org scoping,
//         refuses non-runnable tools, 403s when disabled, and meters
//         each run as an agent turn.
//   (WS4 server half) insights carries recovered_via_agent_appeals with
//         dollars actually collected on overturned agent appeals.
'use strict';
const { spawn, spawnSync } = require('child_process');
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

const TMP = '/tmp/agent-p4-test';
const FAKE = path.join(TMP, 'fake-transport.cjs');
const WD_RUNNER = path.join(TMP, 'watchdog-runner.cjs');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const GOOD_NOTE = 'Patient presents with lower back pain after lifting a heavy box at work. Examination reveals paraspinal muscle spasm and limited range of motion. Assessed as acute low back pain without sciatica. Plan: NSAIDs, heat therapy, activity modification, and follow up in two weeks if not improved.';

fs.writeFileSync(FAKE, `'use strict';
async function transport({ messages }) {
  const last = messages[messages.length - 1];
  const usage = { inputTokens: 50, outputTokens: 10 };
  if (last && last.toolResults) {
    const texts = [];
    for (const r of last.toolResults) {
      let data = {};
      try { data = JSON.parse(r.output); } catch {}
      if (data && data.error) texts.push('Tool said: ' + data.error);
      else if (data && data.angle && data.angle.statement) texts.push('Drafted appeal. ' + data.angle.statement);
      else if (data && data.action_id) texts.push('Draft appeal created (action ' + data.action_id + ').');
    }
    return { text: texts.join(' | ') || 'Done.', toolCalls: [], stopReason: 'end_turn', usage };
  }
  const text = last && typeof last.content === 'string' ? last.content : '';
  if (text.includes('MORNING BRIEF NARRATIVE')) {
    return { text: 'A busy queue today — start with the filing deadline.', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 300, outputTokens: 40 } };
  }
  const cn = (text.match(/CLM-\\d+/) || [])[0];
  if (/draft/i.test(text) && cn) return { text: '', toolCalls: [{ id: 't1', name: 'draft_appeal', input: { claim_number: cn } }], stopReason: 'tool_use', usage };
  return { text: 'OK.', toolCalls: [], stopReason: 'end_turn', usage };
}
module.exports = transport;
module.exports.transport = transport;
module.exports.default = transport;
`);

// Watchdog child: fresh DB, stubbed mailer (fails for 'failorg' addresses),
// fixed clocks. Prints its own PASS/FAIL lines; exit code carries the verdict.
fs.writeFileSync(WD_RUNNER, `'use strict';
process.env.EMAIL_PROVIDER = 'console';
const path = require('path');
const REPO = process.env.REPO_DIR;
let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log('  PASS [watchdog] ' + name); }
  else { failed++; console.log('  FAIL [watchdog] ' + name + ' ' + extra); }
}
const emailMod = require(path.join(REPO, 'server/src/email.js'));
const mails = [];
emailMod.sendEmail = async ({ to, subject, text }) => {
  if (String(to).includes('failorg')) throw new Error('SMTP connection refused (stub)');
  mails.push({ to, subject, text });
  return { provider: 'stub', sent: true };
};
const { db, initSchema } = require(path.join(REPO, 'server/src/db.js'));
initSchema();
const watchdog = require(path.join(REPO, 'server/src/agent/watchdog.js'));

(async () => {
  try {
    const insOrg = db.prepare("INSERT INTO orgs (name, timezone) VALUES (?, 'America/New_York')");
    const org1 = Number(insOrg.run('Watch Org').lastInsertRowid);
    const org2 = Number(insOrg.run('Quiet Org').lastInsertRowid);
    const org3 = Number(insOrg.run('Fail Org').lastInsertRowid);
    const org4 = Number(insOrg.run('Plans Only Org').lastInsertRowid);
    db.prepare("UPDATE orgs SET plan_status = 'trialing', trial_ends_at = '2020-01-01 00:00:00' WHERE id = ?").run(org4);
    const insUser = db.prepare("INSERT INTO users (org_id, email, password_hash, name, role) VALUES (?, ?, 'x', ?, 'owner')");
    const insMember = db.prepare("INSERT INTO user_orgs (user_id, org_id, role) VALUES (?, ?, 'owner')");
    const mkUser = (orgId, email, name) => { const id = Number(insUser.run(orgId, email, name).lastInsertRowid); insMember.run(id, orgId); return id; };
    const user1 = mkUser(org1, 'wanda@watch.test', 'Wanda Owner');
    mkUser(org2, 'quiet@watch.test', 'Quinn Quiet');
    const user3 = mkUser(org3, 'fred@failorg.test', 'Fred Fail');
    const user4 = mkUser(org4, 'polly@plans.test', 'Polly Plans');

    const payer1 = Number(db.prepare("INSERT INTO payers (name, type, org_id) VALUES ('Aetna', 'commercial', ?)").run(org1).lastInsertRowid);
    db.prepare('INSERT INTO payer_filing_rules (org_id, payer_id, filing_days) VALUES (?, ?, 90)').run(org1, payer1);
    const insClaim = db.prepare(\`INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date, billed_amount, paid_amount, status, denial_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)\`);
    // Filing risk: DOS 2026-08-09 + 90d = deadline 2026-11-07; at 2026-10-28 -> 10 days left.
    const frClaim = Number(insClaim.run(org1, 'FR-1', 'Pat FR', payer1, '2026-08-09', 410, 0, 'pending', null).lastInsertRowid);
    const fuClaim = Number(insClaim.run(org1, 'FU-1', 'Pat FU', payer1, '2026-09-01', 200, 0, 'denied', 'CO-50').lastInsertRowid);
    db.prepare("INSERT INTO appeals (org_id, claim_id, assigned_to, status, priority, follow_up_date) VALUES (?, ?, ?, 'open', 'high', '2026-10-20')").run(org1, fuClaim, user1);
    const insAction = db.prepare("INSERT INTO agent_actions (org_id, user_id, kind, payload, preview, status) VALUES (?, ?, 'draft_appeal', ?, 'letter', 'pending')");
    insAction.run(org1, user1, JSON.stringify({ claim_id: fuClaim, claim_number: 'FU-1' }));
    insAction.run(org1, user1, JSON.stringify({ claim_id: frClaim, claim_number: 'FR-1' }));
    const eraId = Number(db.prepare("INSERT INTO era_remittances (org_id, payer_name, check_number, payment_amount, status) VALUES (?, 'Aetna', 'CHK-W', 0, 'received')").run(org1).lastInsertRowid);
    db.prepare(\`INSERT INTO era_claim_lines (era_id, org_id, clp_ref, patient_name, status_code, billed, paid, patient_resp, adjustments, flags, match_claim_id, post_status)
      VALUES (?, ?, 'FU-1', 'Pat FU', '1', 85, 0, 0, '[]', '["variance"]', ?, 'pending')\`).run(eraId, org1, fuClaim);
    insAction.run(org3, user3, JSON.stringify({ claim_id: fuClaim, claim_number: 'FU-1' }));
    insAction.run(org4, user4, JSON.stringify({ claim_id: fuClaim, claim_number: 'FU-1' }));

    const org1Row = db.prepare('SELECT * FROM orgs WHERE id = ?').get(org1);
    const items = watchdog.computeDigestItems(org1Row, { id: user1, role: 'owner' });
    check('items: pending approvals = 2', items.pending_approvals.count === 2, JSON.stringify(items.pending_approvals));
    check('items: follow-ups overdue = 1', items.followups_overdue.count === 1, JSON.stringify(items.followups_overdue));
    check('items: filing risk = 1 claim / $410', items.filing_risk.count === 1 && items.filing_risk.amount === 410, JSON.stringify(items.filing_risk));
    check('items: ERA exceptions = 1 / $85', items.era_exceptions.count === 1 && items.era_exceptions.amount === 85, JSON.stringify(items.era_exceptions));
    check('items: total = 5', items.total === 5, 'total=' + items.total);
    check('subject: top items in plain language', watchdog.subjectFor(items) === '2 approvals waiting, $410 at filing risk — ClaimPaid', watchdog.subjectFor(items));

    const logCount = () => db.prepare('SELECT COUNT(*) AS n FROM agent_digest_log').get().n;
    const nowOut = new Date('2026-10-28T03:00:00.000Z'); // 23:00 EDT Oct 27 — outside the window
    const s0 = await watchdog.runDigestOnce(nowOut);
    check('window: outside 6-10am local -> nothing sent, no log rows', s0.sent === 0 && mails.length === 0 && logCount() === 0, JSON.stringify(s0) + ' mails=' + mails.length + ' logs=' + logCount());

    const nowIn = new Date('2026-10-28T12:30:00.000Z'); // 08:30 EDT — inside the window
    const s1 = await watchdog.runDigestOnce(nowIn);
    check('send: exactly one digest sent (item-ful owner)', s1.sent === 1 && mails.length === 1, JSON.stringify(s1) + ' mails=' + mails.length);
    check('send: addressed to the owner with the plain-language subject', mails.length === 1 && mails[0].to === 'wanda@watch.test' && mails[0].subject === '2 approvals waiting, $410 at filing risk — ClaimPaid', JSON.stringify(mails[0] || {}));
    check('send: failing recipient counted, not fatal', s1.failed === 1, JSON.stringify(s1));
    const log1 = db.prepare('SELECT * FROM agent_digest_log WHERE org_id = ? AND user_id = ?').get(org1, user1);
    check('log: sent row recorded with item count + org-local date', !!log1 && log1.status === 'sent' && log1.items_count === 5 && log1.digest_date === '2026-10-28', JSON.stringify(log1 || {}));
    const log3 = db.prepare('SELECT * FROM agent_digest_log WHERE org_id = ? AND user_id = ?').get(org3, user3);
    check('log: failed send recorded as failed with the error', !!log3 && log3.status === 'failed' && !!log3.error, JSON.stringify(log3 || {}));
    check('skip: item-less org user got no email and no log row', !mails.some((m) => m.to === 'quiet@watch.test') && !db.prepare('SELECT id FROM agent_digest_log WHERE org_id = ?').get(org2));
    check('skip: plans-only org got no email and no log row', !mails.some((m) => m.to === 'polly@plans.test') && !db.prepare('SELECT id FROM agent_digest_log WHERE org_id = ?').get(org4));

    const s2 = await watchdog.runDigestOnce(nowIn);
    check('dedupe: second same-day run sends nothing new', s2.sent === 0 && mails.length === 1, JSON.stringify(s2) + ' mails=' + mails.length);
  } catch (e) {
    failed++;
    console.log('  FAIL [watchdog] runner error: ' + (e.stack || e.message));
  }
  console.log('[watchdog] ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
`);

const servers = [];
async function boot(port, env) {
  const dbPath = path.join(TMP, `test-${port}.db`);
  const server = spawn('node', ['src/index.js'], {
    cwd: path.join(REPO, 'server'),
    env: {
      ...process.env, PORT: String(port), DB_PATH: dbPath, JWT_SECRET: 'test-secret',
      EHR_AUTOPULL: 'off', AGENT_WATCHDOG: 'off', STRIPE_SECRET_KEY: '',
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
        res.end(JSON.stringify({
          model: 'stub-model',
          suggestions: [
            { code: '99213', type: 'CPT', confidence: 0.92, evidence: 'lower back pain', rationale: 'Established patient office visit documented' },
            { code: 'M54.5', type: 'ICD10', confidence: 0.9, evidence: 'lower back pain', rationale: 'Low back pain diagnosis' },
          ],
        }));
      } else { res.writeHead(404); res.end(); }
    });
  });
  await new Promise((r) => stub.listen(4399, '127.0.0.1', r));

  try {
    console.log('— http: boot A (phase 4) —');
    const { base, dbPath } = await boot(4253, {
      AGENT_ENABLED: '1', ANTHROPIC_API_KEY: 'test-key-not-real', AGENT_TRANSPORT_MODULE: FAKE,
      AI_SERVICE_URL: 'http://127.0.0.1:4399',
    });
    const sA = await api(base, 'POST', '/api/auth/signup', { orgName: 'P4 Org A', name: 'Ann Owner', email: 'a@p4.test', password: 'Test1234!' });
    const tokA = sA.data.token;
    check('org A signup', sA.status === 201 && !!tokA, JSON.stringify(sA.data).slice(0, 150));
    const sB = await api(base, 'POST', '/api/auth/signup', { orgName: 'P4 Org B', name: 'Bob Owner', email: 'b@p4.test', password: 'Test1234!' });
    const tokB = sB.data.token;
    check('org B signup', sB.status === 201 && !!tokB);

    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(dbPath);
    const orgA = raw.prepare("SELECT id FROM orgs WHERE name = 'P4 Org A'").get().id;
    const orgB = raw.prepare("SELECT id FROM orgs WHERE name = 'P4 Org B'").get().id;
    const payerA = raw.prepare("SELECT id FROM payers WHERE org_id = ? AND name = 'Aetna'").get(orgA).id;
    const userA = raw.prepare("SELECT id FROM users WHERE email = 'a@p4.test'").get().id;

    const insClaim = raw.prepare(`INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date,
      billed_amount, paid_amount, status, denial_reason, cpt_codes, icd_codes, rendering_npi, patient_dob, member_id)
      VALUES (?, ?, ?, ?, date('now', '-5 days'), ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const C = {};
    const addClaim = (num, over = {}) => {
      const v = { billed: 300, paid: 0, status: 'denied', denial: 'CO-50', cpt: null, icd: null, npi: null, dob: null, member: null, ...over };
      C[num] = Number(insClaim.run(orgA, num, 'Pat ' + num, payerA, v.billed, v.paid, v.status, v.denial, v.cpt, v.icd, v.npi, v.dob, v.member).lastInsertRowid);
      return C[num];
    };
    const insAppeal = raw.prepare("INSERT INTO appeals (org_id, claim_id, assigned_to, status, priority) VALUES (?, ?, NULL, ?, 'medium')");
    const insOutcomeAction = raw.prepare(`INSERT INTO agent_actions (org_id, user_id, convo_id, kind, status, payload, preview, result, decided_at, executed_at)
      VALUES (?, ?, NULL, 'draft_appeal', 'executed', ?, 'letter', ?, datetime('now'), datetime('now'))`);
    const seedOutcome = (num, reason, angle, appealStatus, claimStatus = 'denied', paidAmt = 0) => {
      const cid = addClaim(num, { denial: reason, status: claimStatus, paid: paidAmt });
      const apId = Number(insAppeal.run(orgA, cid, appealStatus).lastInsertRowid);
      insOutcomeAction.run(orgA, userA,
        JSON.stringify({ claim_id: cid, claim_number: num, category: angle }),
        JSON.stringify({ appeal_id: apId }));
      return cid;
    };

    // ---------------- WS1: winning-argument learning ----------------
    console.log('— WS1: angle stats + learned drafts —');
    // (Aetna, CO-50): medical_necessity 5/6 wins; general 1/6; coding 4/4
    // but n=4 is below the steering threshold. (Aetna, CO-97): general 4/4,
    // also below threshold -> no guidance for that pair at all.
    for (let i = 1; i <= 6; i++) seedOutcome(`CLM-410${i}`, 'CO-50', 'medical_necessity', i <= 5 ? 'won' : 'lost');
    for (let i = 1; i <= 6; i++) seedOutcome(`CLM-411${i}`, 'CO-50', 'general', i === 1 ? 'won' : 'lost');
    for (let i = 1; i <= 4; i++) seedOutcome(`CLM-412${i}`, 'CO-50', 'coding', 'won');
    for (let i = 1; i <= 4; i++) seedOutcome(`CLM-413${i}`, 'CO-97', 'general', 'won');
    // Recovered dollars: an approved agent appeal whose claim then paid.
    seedOutcome('CLM-4141', 'CO-11', 'general', 'open', 'paid', 275);

    const brief = await api(base, 'GET', '/api/agent/brief', null, tokA);
    check('brief: generates (reconciliation runs inside)', brief.status === 200 && !!brief.data.brief, JSON.stringify(brief.data).slice(0, 160));
    const statRows = raw.prepare("SELECT * FROM agent_outcome_stats WHERE org_id = ? AND payer_id = ? AND denial_reason = 'CO-50' ORDER BY angle").all(orgA, payerA);
    const byAngle = Object.fromEntries(statRows.map((r) => [r.angle, r]));
    check('stats: angle dimension present (3 angles for CO-50)', statRows.length === 3 && !!byAngle.medical_necessity && !!byAngle.general && !!byAngle.coding, JSON.stringify(statRows));
    check('stats: medical_necessity 6 decided / 5 overturned', byAngle.medical_necessity && byAngle.medical_necessity.appeals === 6 && byAngle.medical_necessity.overturned === 5, JSON.stringify(byAngle.medical_necessity || {}));
    check('stats: general 6 decided / 1 overturned', byAngle.general && byAngle.general.appeals === 6 && byAngle.general.overturned === 1, JSON.stringify(byAngle.general || {}));
    check('stats: coding 4 decided / 4 overturned', byAngle.coding && byAngle.coding.appeals === 4 && byAngle.coding.overturned === 4, JSON.stringify(byAngle.coding || {}));

    const anCO50 = await api(base, 'GET', `/api/agent/claims/${C['CLM-4101']}/analysis`, null, tokA);
    check('predict: prefers the angle-conditioned rate (0.833, n=6, angle named)',
      anCO50.data.appeal_overturn && anCO50.data.appeal_overturn.value === 0.833 && anCO50.data.appeal_overturn.sampleSize === 6
      && anCO50.data.appeal_overturn.basis === 'payer + denial reason + angle' && anCO50.data.appeal_overturn.angle === 'medical_necessity',
      JSON.stringify(anCO50.data.appeal_overturn || {}));
    const anCO97 = await api(base, 'GET', `/api/agent/claims/${C['CLM-4131']}/analysis`, null, tokA);
    check('predict: below-threshold pair falls back to the pair rate (1.0, n=4, no angle claim)',
      anCO97.data.appeal_overturn && anCO97.data.appeal_overturn.value === 1 && anCO97.data.appeal_overturn.sampleSize === 4
      && anCO97.data.appeal_overturn.basis === 'payer + denial reason' && !anCO97.data.appeal_overturn.angle,
      JSON.stringify(anCO97.data.appeal_overturn || {}));

    // In-process units against the same stats (reads only).
    process.env.DB_PATH = dbPath;
    const predict = require(path.join(REPO, 'server/src/agent/predict.js'));
    const best = predict.bestAngle(orgA, payerA, 'CO-50');
    check('unit bestAngle: medical_necessity at 0.833 (n=6) beats coding 1.0 (n=4, below threshold)',
      !!best && best.angle === 'medical_necessity' && best.value === 0.833 && best.sampleSize === 6, JSON.stringify(best || {}));
    check('unit bestAngle: CO-97 pair has no qualifying angle', predict.bestAngle(orgA, payerA, 'CO-97') === null);
    const explicit = predict.appealOverturn(orgA, payerA, 'CO-50', 'general');
    check('unit appealOverturn(explicit angle): general rate 0.167 with angle basis',
      explicit.value === 0.167 && explicit.basis === 'payer + denial reason + angle' && explicit.angle === 'general', JSON.stringify(explicit));

    addClaim('CLM-4001', { denial: 'CO-50' });
    addClaim('CLM-4002', { denial: 'CO-97' });
    addClaim('CLM-4003', { denial: 'CO-50' });
    const prop1 = await api(base, 'POST', '/api/agent/actions/propose', { kind: 'draft_appeal', claim_id: C['CLM-4001'] }, tokA);
    check('propose: learned angle reaches the letter (category = medical_necessity)',
      prop1.status === 201 && prop1.data.action.payload.category === 'medical_necessity', JSON.stringify(prop1.data).slice(0, 220));
    check('propose: angle provenance + stat ride the action',
      prop1.data.action.payload.angle_source === 'learned' && prop1.data.action.payload.angle_stat
      && prop1.data.action.payload.angle_stat.value === 0.833 && prop1.data.action.payload.angle_stat.sampleSize === 6,
      JSON.stringify(prop1.data.action.payload || {}));
    check('propose: the stat is stated at the top of the card preview',
      typeof prop1.data.action.preview === 'string' && prop1.data.action.preview.startsWith('Angle: Medical necessity — overturns 83% here (n=6).'),
      (prop1.data.action.preview || '').slice(0, 90));
    const prop2 = await api(base, 'POST', '/api/agent/actions/propose', { kind: 'draft_appeal', claim_id: C['CLM-4002'] }, tokA);
    check('propose: below-threshold pair gets the default angle and NO stat claim',
      prop2.status === 201 && prop2.data.action.payload.angle_source === 'default' && !prop2.data.action.payload.angle_stat
      && !(prop2.data.action.preview || '').startsWith('Angle:'),
      JSON.stringify(prop2.data.action.payload || {}) + ' preview=' + (prop2.data.action.preview || '').slice(0, 60));

    const chat = await api(base, 'POST', '/api/agent/chat', { message: 'Draft an appeal for CLM-4003' }, tokA);
    check('chat: the reply states the learned-angle stat exactly',
      chat.status === 200 && String(chat.data.reply || '').includes('Angle: Medical necessity — overturns 83% here (n=6).'),
      JSON.stringify(chat.data).slice(0, 220));
    check('chat: the created action carries the learned angle',
      Array.isArray(chat.data.actions) && chat.data.actions.length === 1 && chat.data.actions[0].payload.category === 'medical_necessity',
      JSON.stringify(chat.data.actions || []).slice(0, 200));

    // ---------------- WS3: tools/run ----------------
    console.log('— WS3: tools/run endpoint —');
    raw.prepare("UPDATE orgs SET eligibility_vendor = 'rest', eligibility_endpoint = 'http://127.0.0.1:4399/check' WHERE id = ?").run(orgA);
    addClaim('CLM-4201', { status: 'pending', denial: null, cpt: '99213', icd: 'M54.5', npi: '1234567890', dob: '1980-05-01', member: 'MEM12345', billed: 200 });
    raw.prepare("UPDATE claims SET patient_name = 'Elig Patient' WHERE id = ?").run(C['CLM-4201']);
    addClaim('CLM-4202', { status: 'pending', denial: null, billed: 150 });
    raw.prepare(`INSERT INTO coding_jobs (org_id, claim_id, note_text, created_by, status, result_json)
      VALUES (?, ?, ?, ?, 'complete', '{}')`).run(orgA, C['CLM-4202'], GOOD_NOTE, userA);
    const turnsNow = () => {
      const m = new Date().toISOString().slice(0, 7);
      const row = raw.prepare('SELECT turns FROM agent_usage WHERE org_id = ? AND month = ?').get(orgA, m);
      return row ? row.turns : 0;
    };
    const turnsBefore = turnsNow();

    const runScrub = await api(base, 'POST', '/api/agent/tools/run', { tool: 'scrub_claim', claim_id: C['CLM-4201'] }, tokA);
    check('tools/run scrub_claim: 200 with the scrubber output shape',
      runScrub.status === 200 && runScrub.data.is_error === false && typeof runScrub.data.output.score === 'number'
      && Array.isArray(runScrub.data.output.errors) && runScrub.data.event && runScrub.data.event.tool === 'scrub_claim',
      JSON.stringify(runScrub.data).slice(0, 200));
    const lookupsBefore = raw.prepare('SELECT COUNT(*) AS n FROM eligibility_lookups WHERE org_id = ?').get(orgA).n;
    const runElig = await api(base, 'POST', '/api/agent/tools/run', { tool: 'check_eligibility', claim_id: C['CLM-4201'] }, tokA);
    check('tools/run check_eligibility: live-mode coverage through the stub vendor',
      runElig.status === 200 && runElig.data.is_error === false && runElig.data.output.coverage_active === true && runElig.data.output.mode === 'live',
      JSON.stringify(runElig.data).slice(0, 220));
    check('tools/run check_eligibility: the lookup is stored like a tab check',
      raw.prepare('SELECT COUNT(*) AS n FROM eligibility_lookups WHERE org_id = ?').get(orgA).n === lookupsBefore + 1);
    const runCodes = await api(base, 'POST', '/api/agent/tools/run', { tool: 'suggest_codes', claim_id: C['CLM-4202'] }, tokA);
    check('tools/run suggest_codes: verdicts returned + apply_codes proposal created',
      runCodes.status === 200 && runCodes.data.is_error === false && !!runCodes.data.output.assessment
      && !!runCodes.data.action && runCodes.data.action.kind === 'apply_codes' && runCodes.data.action.status === 'pending',
      JSON.stringify(runCodes.data).slice(0, 220));
    const runCross = await api(base, 'POST', '/api/agent/tools/run', { tool: 'scrub_claim', claim_id: C['CLM-4201'] }, tokB);
    check('tools/run: org B cannot run tools on org A claims (honest not-found)',
      runCross.status === 200 && runCross.data.is_error === true && /not found/i.test(String(runCross.data.output.error || '')),
      JSON.stringify(runCross.data).slice(0, 200));
    const runBad = await api(base, 'POST', '/api/agent/tools/run', { tool: 'draft_appeal', claim_id: C['CLM-4201'] }, tokA);
    check('tools/run: non-runnable tool refused (400)', runBad.status === 400, `got ${runBad.status}`);
    check('tools/run: every run meters one agent turn against the CALLER org (3 on A; the cross-org run lands on B)',
      turnsNow() - turnsBefore === 3
      && (raw.prepare('SELECT turns FROM agent_usage WHERE org_id = ?').get(orgB) || { turns: 0 }).turns === 1,
      `deltaA=${turnsNow() - turnsBefore}`);

    // ---------------- WS2 (HTTP half): alerts endpoint ----------------
    console.log('— WS2: alerts endpoint —');
    raw.prepare("INSERT INTO agent_actions (org_id, user_id, kind, payload, preview, status) VALUES (?, ?, 'draft_appeal', '{}', 'letter', 'pending')").run(orgA, userA);
    const alerts = await api(base, 'GET', '/api/agent/alerts', null, tokA);
    const it = alerts.data.items || {};
    check('alerts: 200 with the computed item set for this user',
      alerts.status === 200 && it.pending_approvals && it.pending_approvals.count >= 1
      && typeof it.followups_overdue.count === 'number' && typeof it.filing_risk.count === 'number'
      && typeof it.era_exceptions.count === 'number',
      JSON.stringify(alerts.data).slice(0, 220));
    check('alerts: total is the sum of its parts',
      it.total === it.pending_approvals.count + it.followups_overdue.count + it.filing_risk.count + it.era_exceptions.count,
      JSON.stringify(it).slice(0, 200));
    const alertsB = await api(base, 'GET', '/api/agent/alerts', null, tokB);
    check('alerts: org B sees only its own (empty) item set',
      alertsB.status === 200 && alertsB.data.items && alertsB.data.items.total === 0, JSON.stringify(alertsB.data).slice(0, 160));

    // ---------------- WS4 (server half): recovered dollars ----------------
    console.log('— WS4: recovered via agent-assisted appeals —');
    const ins = await api(base, 'GET', '/api/agent/insights', null, tokA);
    check('insights: recovered = $275 collected across all 15 overturned agent appeals (14 won at $0 paid + 1 paid-after-appeal)',
      ins.status === 200 && ins.data.recovered_via_agent_appeals && ins.data.recovered_via_agent_appeals.amount === 275
      && ins.data.recovered_via_agent_appeals.appeals === 15,
      JSON.stringify(ins.data.recovered_via_agent_appeals || {}));
    const insB = await api(base, 'GET', '/api/agent/insights', null, tokB);
    check('insights: org B recovered is $0 / 0 appeals (no fanfare, no leakage)',
      insB.status === 200 && insB.data.recovered_via_agent_appeals && insB.data.recovered_via_agent_appeals.amount === 0
      && insB.data.recovered_via_agent_appeals.appeals === 0,
      JSON.stringify(insB.data.recovered_via_agent_appeals || {}));
    raw.close();

    // ---------------- WS2 (engine): watchdog child process ----------------
    console.log('— WS2: watchdog engine (child process) —');
    const wdDb = path.join(TMP, 'watchdog.db');
    const wd = spawnSync('node', [WD_RUNNER], {
      env: {
        ...process.env, REPO_DIR: REPO, DB_PATH: wdDb, JWT_SECRET: 'test-secret',
        AGENT_ENABLED: '1', ANTHROPIC_API_KEY: 'test-key-not-real',
        EHR_AUTOPULL: 'off', AGENT_WATCHDOG: 'off',
      },
      encoding: 'utf8', timeout: 120000,
    });
    process.stdout.write(wd.stdout || '');
    if (wd.stderr) process.stderr.write(wd.stderr);
    check('watchdog child suite: all engine checks pass', wd.status === 0, `exit=${wd.status}`);

    // ---------------- Gate: agent disabled ----------------
    console.log('— http: boot B (agent disabled) —');
    const bootB = await boot(4254, {});
    const sD = await api(bootB.base, 'POST', '/api/auth/signup', { orgName: 'P4 Org D', name: 'Dee Owner', email: 'd@p4.test', password: 'Test1234!' });
    const runD = await api(bootB.base, 'POST', '/api/agent/tools/run', { tool: 'scrub_claim', claim_id: 1 }, sD.data.token);
    check('disabled: tools/run 403 AGENT_DISABLED', runD.status === 403 && runD.data.code === 'AGENT_DISABLED', `got ${runD.status}`);
    const alertsD = await api(bootB.base, 'GET', '/api/agent/alerts', null, sD.data.token);
    check('disabled: alerts 403 AGENT_DISABLED', alertsD.status === 403 && alertsD.data.code === 'AGENT_DISABLED', `got ${alertsD.status}`);
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
