// deploy101-loop-test.cjs — Deploy #101 WS-A: the status-driven core loop.
// Boots the real server and verifies:
//   (A1) mark-submitted defaults the follow-up to submitted_at + the
//        payer's TYPICAL response window (default 30; per-payer override
//        via Filing Rules), and an explicit date still wins.
//   (A2) ERA feedback: posted lines settle claims with submitted
//        appeals — full pay -> WON (+ learning stats), partial -> PARTIAL,
//        denial -> RE-DENIED (claim back to denied with the ERA reason,
//        appeal reopened, activity logged, brief/alert surfaces carry it).
//        Claims without appeals post exactly as before.
//   (A3) Silence: submitted appeals past their window with no ERA
//        movement appear as payer-silent in awaiting-payer + watchdog
//        items + notifications; inside the window they do not.
//   (A4) Awaiting-payer board rows carry days waiting vs window.
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = '/tmp/deploy101-loop';
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const FAKE = path.join(TMP, 'fake-transport.cjs');
fs.writeFileSync(FAKE, `'use strict';
async function transport() { return { text: 'OK.', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } }; }
module.exports = transport; module.exports.transport = transport; module.exports.default = transport;
`);

const servers = [];
async function boot(port, env) {
  const dbPath = path.join(TMP, `test-${port}.db`);
  const server = spawn('node', ['src/index.js'], {
    cwd: path.join(REPO, 'server'),
    env: {
      ...process.env, PORT: String(port), DB_PATH: dbPath, JWT_SECRET: 'test-secret',
      EHR_AUTOPULL: 'off', AGENT_WATCHDOG: 'off', STRIPE_SECRET_KEY: '',
      AGENT_ENABLED: '', ANTHROPIC_API_KEY: '', AGENT_TRANSPORT_MODULE: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server:${port}] ${d}`));
  servers.push(server);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) return { server, base, dbPath }; } catch { /* wait */ }
    await sleep(400);
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
async function upload(base, p, fileName, text, token) {
  const fd = new FormData();
  fd.append('file', new Blob([text], { type: 'text/plain' }), fileName);
  const res = await fetch(base + p, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const isoDaysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const isoDaysAhead = (n) => isoDaysAgo(-n);

const ERA_835 = [
  'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *261020*0800*^*00501*000000905*0*T*:~',
  'GS*HP*AETNA*RECEIVER*20261020*0800*905*X*005010X221A1~',
  'ST*835*0001~',
  'BPR*I*350*C*ACH*CCP*01*021000022*DA*123456789*1234567890*SUPP*01*021000022*DA*987654321*20261020~',
  'TRN*1*EFT-LOOP1*1234567890~',
  'DTM*405*20261020~',
  'N1*PR*AETNA~',
  'N1*PE*LOOP CLINIC*XX*1234567893~',
  // WIN — full payment on a claim whose appeal is submitted
  'CLP*CLM-WIN*1*200*200*0**ICNW001~',
  'NM1*QC*1*WINNER*WENDY****MI*MBR-W~',
  'DTM*232*20260901~',
  // PART — $150 paid, $100 write-off, $50 unexplained (variance -> held,
  // resolved manually below): balance of $50 remains after posting
  'CLP*CLM-PART*1*300*150*0**ICNP002~',
  'NM1*QC*1*PARTIAL*PAUL****MI*MBR-P~',
  'CAS*CO*45*100~',
  // RED — outright denial of a claim whose appeal is submitted
  'CLP*CLM-RED*4*400*0*0**ICNR003~',
  'NM1*QC*1*REDENIED*RITA****MI*MBR-R~',
  'CAS*CO*50*400~',
  // PLAIN — payment on a claim with NO appeal: posts exactly as today
  'CLP*CLM-PLAIN*1*120*120*0**ICNL004~',
  'NM1*QC*1*PLAIN*PETE****MI*MBR-L~',
  'SE*20*0001~',
  'GE*1*905~',
  'IEA*1*000000905~',
].join('\n');

async function main() {
  console.log('— deploy 101 WS-A: core loop —');
  const { base, dbPath } = await boot(4261, {
    AGENT_ENABLED: '1', ANTHROPIC_API_KEY: 'test-key-not-real', AGENT_TRANSPORT_MODULE: FAKE,
  });
  const s = await api(base, 'POST', '/api/auth/signup', { orgName: 'Loop Org', name: 'Lena Owner', email: 'lena@loop.test', password: 'Test1234!' });
  const tok = s.data.token;
  const orgId = s.data.user.org_id;
  const ownerId = s.data.user.id;
  check('signup', s.status === 201 && !!tok, JSON.stringify(s.data).slice(0, 150));

  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(dbPath);
  const payer = Number(raw.prepare("INSERT INTO payers (name, type, org_id) VALUES ('Aetna', 'commercial', ?)").run(orgId).lastInsertRowid);
  raw.prepare('INSERT INTO payer_filing_rules (org_id, payer_id, filing_days) VALUES (?, ?, 90)').run(orgId, payer);
  const insClaim = raw.prepare(`INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date, billed_amount, paid_amount, status, denial_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const mkClaim = (cn, patient, billed, status, reason) =>
    Number(insClaim.run(orgId, cn, patient, payer, '2026-09-01', billed, 0, status, reason).lastInsertRowid);
  const insAppeal = raw.prepare(`INSERT INTO appeals (org_id, claim_id, assigned_to, status, priority, letter, submitted_at, submitted_via)
    VALUES (?, ?, ?, ?, 'high', ?, ?, ?)`);
  const mkSubmittedAppeal = (claimId, submittedAt) =>
    Number(insAppeal.run(orgId, claimId, ownerId, 'submitted', 'Appeal letter body.', submittedAt, 'payer_portal').lastInsertRowid);

  // ---------- A2 fixtures: three claims with submitted appeals ----------
  const cWin = mkClaim('CLM-WIN', 'Wendy Winner', 200, 'denied', 'CO-97 - duplicate');
  const aWin = mkSubmittedAppeal(cWin, isoDaysAgo(3));
  const cPart = mkClaim('CLM-PART', 'Paul Partial', 300, 'denied', 'CO-50 - non-covered');
  const aPart = mkSubmittedAppeal(cPart, isoDaysAgo(3));
  const cRed = mkClaim('CLM-RED', 'Rita Redenied', 400, 'denied', 'CO-97 - duplicate');
  const aRed = mkSubmittedAppeal(cRed, isoDaysAgo(3));
  const cPlain = mkClaim('CLM-PLAIN', 'Pete Plain', 120, 'in_ar', null);
  // The WIN appeal was drafted by the agent (executed draft_appeal
  // action) — the learning rebuild keys on those, exactly as it does
  // for manually recorded outcomes on agent appeals.
  raw.prepare(`INSERT INTO agent_actions (org_id, user_id, kind, payload, preview, status, result, decided_at)
    VALUES (?, ?, 'draft_appeal', ?, 'letter', 'executed', ?, datetime('now'))`)
    .run(orgId, ownerId, JSON.stringify({ claim_id: cWin, claim_number: 'CLM-WIN' }), JSON.stringify({ appeal_id: aWin }));

  const up = await upload(base, '/api/era/upload-835', 'loop-835.txt', ERA_835, tok);
  check('835 upload ok', up.status === 200, `status=${up.status} ${JSON.stringify(up.data).slice(0, 200)}`);

  let row = raw.prepare('SELECT * FROM appeals WHERE id = ?').get(aWin);
  let claim = raw.prepare('SELECT * FROM claims WHERE id = ?').get(cWin);
  check('A2 win: appeal status won + outcome won (era)', row.status === 'won' && row.outcome === 'won' && row.outcome_source === 'era',
    JSON.stringify({ status: row.status, outcome: row.outcome, src: row.outcome_source }));
  check('A2 win: claim paid', claim.status === 'paid' && Number(claim.paid_amount) === 200, JSON.stringify({ s: claim.status, p: claim.paid_amount }));
  const winAct = raw.prepare("SELECT * FROM claim_activity WHERE claim_id = ? AND action = 'appeal_won'").get(cWin);
  check('A2 win: activity logged as system/agent-originated', !!winAct && winAct.user_id == null && String(winAct.detail).includes('ERA'),
    JSON.stringify(winAct || {}).slice(0, 200));
  const stats = raw.prepare('SELECT * FROM agent_outcome_stats WHERE org_id = ?').all(orgId);
  check('A2 win: learning stats recorded a decision', stats.some((st) => Number(st.appeals) >= 1 && Number(st.overturned) >= 1),
    JSON.stringify(stats));

  claim = raw.prepare('SELECT * FROM claims WHERE id = ?').get(cPlain);
  check('A2 plain: claim without appeal posts exactly as today', claim.status === 'paid' && Number(claim.paid_amount) === 120,
    JSON.stringify({ s: claim.status, p: claim.paid_amount }));

  // PART line is a held variance exception — resolve it (post) and the
  // loop must record PARTIAL.
  row = raw.prepare('SELECT * FROM appeals WHERE id = ?').get(aPart);
  check('A2 part: appeal untouched while line held', row.status === 'submitted' && !row.outcome, JSON.stringify({ s: row.status, o: row.outcome }));
  const partLine = raw.prepare("SELECT * FROM era_claim_lines WHERE org_id = ? AND clp_ref = 'CLM-PART'").get(orgId);
  check('A2 part: line held as pending exception', !!partLine && partLine.post_status === 'pending', JSON.stringify(partLine || {}).slice(0, 150));
  const resPart = await api(base, 'POST', `/api/era/lines/${partLine.id}/post`, {}, tok);
  check('A2 part: manual post ok', resPart.status === 200, `status=${resPart.status} ${JSON.stringify(resPart.data).slice(0, 200)}`);
  row = raw.prepare('SELECT * FROM appeals WHERE id = ?').get(aPart);
  check('A2 part: outcome partial, appeal still submitted (money still owed)', row.outcome === 'partial' && row.status === 'submitted',
    JSON.stringify({ s: row.status, o: row.outcome }));

  // RED: a clean denial line auto-posts at upload (existing ERA
  // behavior) — the loop must have re-denied at that moment: appeal
  // reopened with outcome re_denied, claim denied with the ERA's
  // reason, follow-up = today.
  row = raw.prepare('SELECT * FROM appeals WHERE id = ?').get(aRed);
  claim = raw.prepare('SELECT * FROM claims WHERE id = ?').get(cRed);
  check('A2 red: appeal reopened with outcome re_denied (era)', row.status === 'open' && row.outcome === 're_denied' && row.outcome_source === 'era',
    JSON.stringify({ s: row.status, o: row.outcome, src: row.outcome_source }));
  check('A2 red: claim back to denied with the ERA denial reason', claim.status === 'denied' && /^50 —/.test(claim.denial_reason || ''),
    JSON.stringify({ s: claim.status, r: claim.denial_reason }));
  check('A2 red: follow-up reset to today for the response', row.follow_up_date === isoDaysAgo(0), String(row.follow_up_date));
  const redAct = raw.prepare("SELECT * FROM claim_activity WHERE claim_id = ? AND action = 'appeal_re_denied'").get(cRed);
  check('A2 red: re-denial activity logged (system)', !!redAct && redAct.user_id == null, JSON.stringify(redAct || {}).slice(0, 150));

  // The re-denied appeal surfaces in agent alerts + notifications.
  const notif = await api(base, 'GET', '/api/agent/notifications', null, tok);
  check('A2 red: notification center carries the re-denied item',
    notif.status === 200 && (notif.data.items || []).some((i) => i.category === 'followup' || i.title.includes('re-denied')),
    JSON.stringify(notif.data).slice(0, 300));

  // ---------- A1: mark-submitted follow-up = payer window ----------
  const cMs = mkClaim('CLM-MS', 'Molly Submit', 500, 'denied', 'CO-50 - non-covered');
  const aMs = Number(raw.prepare("INSERT INTO appeals (org_id, claim_id, assigned_to, status, priority, letter) VALUES (?, ?, ?, 'open', 'high', 'Letter.')")
    .run(orgId, cMs, ownerId).lastInsertRowid);
  const ms1 = await api(base, 'POST', `/api/appeals/${aMs}/mark-submitted`, { via: 'fax' }, tok);
  check('A1: mark-submitted ok', ms1.status === 200, `status=${ms1.status} ${JSON.stringify(ms1.data).slice(0, 200)}`);
  check('A1: default window 30d sets follow-up', ms1.data.follow_up_date === isoDaysAhead(30),
    `got ${ms1.data.follow_up_date} want ${isoDaysAhead(30)}`);

  // Per-payer override: 10-day typical window.
  const put = await api(base, 'PUT', `/api/filing/rules/${payer}`, { filing_days: 90, response_days: 10 }, tok);
  check('A1: filing rule accepts response_days', put.status === 200 && put.data.response_days === 10,
    `status=${put.status} ${JSON.stringify(put.data).slice(0, 200)}`);
  const rules = await api(base, 'GET', '/api/filing/rules', null, tok);
  const ruleRow = (Array.isArray(rules.data) ? rules.data : []).find((r) => r.payer_id === payer);
  check('A1: rules list carries the window + default flag', !!ruleRow && ruleRow.response_days === 10 && ruleRow.response_is_default === false,
    JSON.stringify(ruleRow || {}));

  const cMs2 = mkClaim('CLM-MS2', 'Manny Submit', 500, 'denied', 'CO-50 - non-covered');
  const aMs2 = Number(raw.prepare("INSERT INTO appeals (org_id, claim_id, assigned_to, status, priority, letter) VALUES (?, ?, ?, 'open', 'high', 'Letter.')")
    .run(orgId, cMs2, ownerId).lastInsertRowid);
  const ms2 = await api(base, 'POST', `/api/appeals/${aMs2}/mark-submitted`, { via: 'payer_portal' }, tok);
  check('A1: override window 10d sets follow-up', ms2.data.follow_up_date === isoDaysAhead(10),
    `got ${ms2.data.follow_up_date} want ${isoDaysAhead(10)}`);
  const cMs3 = mkClaim('CLM-MS3', 'Mira Submit', 500, 'denied', 'CO-50 - non-covered');
  const aMs3 = Number(raw.prepare("INSERT INTO appeals (org_id, claim_id, assigned_to, status, priority, letter) VALUES (?, ?, ?, 'open', 'high', 'Letter.')")
    .run(orgId, cMs3, ownerId).lastInsertRowid);
  const ms3 = await api(base, 'POST', `/api/appeals/${aMs3}/mark-submitted`, { via: 'mail', follow_up_date: '2027-01-15' }, tok);
  check('A1: explicit follow-up date still wins', ms3.data.follow_up_date === '2027-01-15', String(ms3.data.follow_up_date));
  // Reset the window to the default for the silence fixtures.
  await api(base, 'PUT', `/api/filing/rules/${payer}`, { filing_days: 90, response_days: null }, tok);
  const rules2 = await api(base, 'GET', '/api/filing/rules', null, tok);
  const ruleRow2 = (Array.isArray(rules2.data) ? rules2.data : []).find((r) => r.payer_id === payer);
  check('A1: clearing the override returns to the 30d default', !!ruleRow2 && ruleRow2.response_days === 30 && ruleRow2.response_is_default === true,
    JSON.stringify(ruleRow2 || {}));

  // ---------- A3/A4: silence + awaiting board ----------
  const cOld = mkClaim('CLM-OLD', 'Olga Old', 700, 'denied', 'CO-50 - non-covered');
  const aOld = mkSubmittedAppeal(cOld, isoDaysAgo(40)); // 40d > 30d window
  const cNew = mkClaim('CLM-NEW', 'Ned New', 700, 'denied', 'CO-50 - non-covered');
  const aNew = mkSubmittedAppeal(cNew, isoDaysAgo(2)); // inside window

  const board = await api(base, 'GET', '/api/appeals/awaiting-payer', null, tok);
  check('A4: board returns 200 with rows', board.status === 200 && Array.isArray(board.data.awaiting), `status=${board.status}`);
  const bOld = (board.data.awaiting || []).find((r) => r.appeal_id === aOld);
  const bNew = (board.data.awaiting || []).find((r) => r.appeal_id === aNew);
  check('A4: silent appeal flagged, days vs window shown', !!bOld && bOld.silent === true && bOld.days_waiting >= 40 && bOld.response_days === 30,
    JSON.stringify(bOld || {}));
  check('A4: in-window appeal not flagged', !!bNew && bNew.silent === false && bNew.days_waiting <= 3, JSON.stringify(bNew || {}));
  check('A4: silent rows sort first', board.data.awaiting[0] && board.data.awaiting[0].appeal_id === aOld,
    JSON.stringify((board.data.awaiting || []).map((r) => r.appeal_id)));

  const notif2 = await api(base, 'GET', '/api/agent/notifications', null, tok);
  check('A3: notifications carry the payer-silent item only for the past-window appeal',
    (notif2.data.items || []).some((i) => i.category === 'payer_silent' && i.id === `silent-${aOld}`)
    && !(notif2.data.items || []).some((i) => i.category === 'payer_silent' && i.id === `silent-${aNew}`),
    JSON.stringify((notif2.data.items || []).filter((i) => i.category === 'payer_silent')));

  raw.close();
  console.log(`deploy101-loop: ${passed} passed, ${failed} failed`);
  for (const srv of servers) srv.kill('SIGTERM');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); for (const srv of servers) srv.kill('SIGTERM'); process.exit(1); });
