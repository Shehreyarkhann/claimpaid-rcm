// deploy101-rhythm-test.cjs — Deploy #101 WS-D: first run + daily rhythm.
//   (D12) activation checklist: derived per step over HTTP (claims ->
//         audit -> brief -> first decision/manual appeal), hides when
//         complete, owner-only dismiss.
//   (D13) brief precompute (child runner, scheduler fn called
//         directly): org-local 06:00 gate, active-in-14d users only,
//         dedupe by precompute log + brief UNIQUE, quota-capped org
//         gets a brief WITHOUT the narrative (same degradation as the
//         lazy path).
//   (D14) notification watermark: unread counts derived items, POST
//         read zeroes it, new items re-light it; digest opt-out round
//         trip + the watchdog digest honoring the opt-out (child).
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
const TMP = '/tmp/deploy101-rhythm';
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const FAKE = path.join(TMP, 'fake-transport.cjs');
fs.writeFileSync(FAKE, `'use strict';
async function transport({ messages }) {
  const last = messages[messages.length - 1];
  const text = last && typeof last.content === 'string' ? last.content : '';
  if (text.includes('MORNING BRIEF NARRATIVE')) {
    return { text: 'NARRATIVE-TEXT: start with the oldest denial.', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 300, outputTokens: 40 } };
  }
  return { text: 'OK.', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
}
module.exports = transport; module.exports.transport = transport; module.exports.default = transport;
`);

// ---- precompute + digest-opt-out runner (child) ----
const RUNNER = path.join(TMP, 'rhythm-runner.cjs');
fs.writeFileSync(RUNNER, `'use strict';
process.env.EMAIL_PROVIDER = 'console';
const path = require('path');
const REPO = process.env.REPO_DIR;
let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log('  PASS [rhythm] ' + name); }
  else { failed++; console.log('  FAIL [rhythm] ' + name + ' ' + extra); }
}
const emailMod = require(path.join(REPO, 'server/src/email.js'));
const mails = [];
emailMod.sendEmail = async ({ to, subject, text }) => { mails.push({ to, subject, text }); return { provider: 'stub', sent: true }; };
const { db, initSchema } = require(path.join(REPO, 'server/src/db.js'));
initSchema();
const precompute = require(path.join(REPO, 'server/src/agent/precompute.js'));
const watchdog = require(path.join(REPO, 'server/src/agent/watchdog.js'));

(async () => {
  const insOrg = db.prepare("INSERT INTO orgs (name, timezone) VALUES (?, 'America/New_York')");
  const orgA = Number(insOrg.run('Rhythm A').lastInsertRowid);
  const orgB = Number(insOrg.run('Rhythm B (quota capped)').lastInsertRowid);
  // Real workspaces carry their chosen plan (a trial rides on it):
  // Starter's AI cap is 100/mo, which org B's seeded usage blows past.
  db.prepare("UPDATE orgs SET plan = 'pro' WHERE id = ?").run(orgA);
  db.prepare("UPDATE orgs SET plan = 'starter' WHERE id = ?").run(orgB);
  const insUser = db.prepare("INSERT INTO users (org_id, email, password_hash, name, role) VALUES (?, ?, 'x', ?, 'owner')");
  const insMember = db.prepare("INSERT INTO user_orgs (user_id, org_id, role) VALUES (?, ?, 'owner')");
  const mkUser = (orgId, email, name) => { const id = Number(insUser.run(orgId, email, name).lastInsertRowid); insMember.run(id, orgId); return id; };
  const userA = mkUser(orgA, 'amy@rhythm.test', 'Amy Active');
  const userAIdle = mkUser(orgA, 'ivan@rhythm.test', 'Ivan Idle');
  const userB = mkUser(orgB, 'bob@rhythm.test', 'Bob Capped');
  // Activity signals (last 14 days): a conversation for Amy and Bob.
  const insConvo = db.prepare("INSERT INTO agent_conversations (org_id, user_id, title) VALUES (?, ?, 'chat')");
  insConvo.run(orgA, userA);
  insConvo.run(orgB, userB);
  // Something for the briefs to summarize: a denied claim each.
  const payerA = Number(db.prepare("INSERT INTO payers (name, type, org_id) VALUES ('Aetna', 'commercial', ?)").run(orgA).lastInsertRowid);
  const payerB = Number(db.prepare("INSERT INTO payers (name, type, org_id) VALUES ('Aetna', 'commercial', ?)").run(orgB).lastInsertRowid);
  db.prepare("INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date, billed_amount, paid_amount, status, denial_reason) VALUES (?, 'RA-1', 'Pat A', ?, '2026-01-01', 900, 0, 'denied', 'CO-50')").run(orgA, payerA);
  db.prepare("INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date, billed_amount, paid_amount, status, denial_reason) VALUES (?, 'RB-1', 'Pat B', ?, '2026-01-01', 900, 0, 'denied', 'CO-50')").run(orgB, payerB);
  // Org B's AI pool is exhausted for the CURRENT month (the quota gate
  // reads real-clock usage, like the lazy path).
  const month = new Date().toISOString().slice(0, 7);
  db.prepare('INSERT INTO agent_usage (org_id, month, turns, input_tokens, output_tokens) VALUES (?, ?, 100000, 0, 0)').run(orgB, month);

  const at0730 = new Date('2026-01-15T12:30:00.000Z'); // 07:30 EST — outside the 06:00 hour
  const s0 = await precompute.runBriefPrecompute(at0730);
  check('hour gate: 07:30 local generates nothing', s0.generated === 0, JSON.stringify(s0));
  const at0630 = new Date('2026-01-15T11:30:00.000Z'); // 06:30 EST — inside
  const s1 = await precompute.runBriefPrecompute(at0630);
  check('precompute: both active users got briefs', s1.generated === 2, JSON.stringify(s1));
  const briefs = db.prepare('SELECT * FROM agent_briefs').all();
  check('precompute: exactly 2 briefs (idle user skipped)', briefs.length === 2 && !briefs.some((b) => b.user_id === userAIdle), JSON.stringify(briefs.map((b) => b.user_id)));
  const briefA = briefs.find((b) => b.org_id === orgA);
  const briefB = briefs.find((b) => b.org_id === orgB);
  const sumA = briefA ? (JSON.parse(briefA.content || '{}').summary || '') : '';
  const sumB = briefB ? (JSON.parse(briefB.content || '{}').summary || '') : '';
  check('precompute: under-quota brief carries the narrative', sumA.includes('NARRATIVE-TEXT'), String(sumA).slice(0, 80));
  check('precompute: quota-capped brief assembles WITHOUT the narrative', !!briefB && !sumB, String(sumB).slice(0, 80));
  const logs = db.prepare('SELECT * FROM agent_brief_precompute_log').all();
  check('precompute: attempt log rows recorded as generated', logs.length === 2 && logs.every((l) => l.status === 'generated'), JSON.stringify(logs));
  const s2 = await precompute.runBriefPrecompute(at0630);
  check('dedupe: second sweep same morning generates nothing new', s2.generated === 0 && db.prepare('SELECT COUNT(*) AS n FROM agent_briefs').get().n === 2, JSON.stringify(s2));
  const stamp = db.prepare("SELECT * FROM agent_scheduler_log WHERE job = 'brief_precompute'").get();
  check('precompute: scheduler stamp written', !!stamp && !!stamp.last_run_at, JSON.stringify(stamp || {}));

  // Digest opt-out: Amy (not opted out) and Ivan (opted out) both have
  // a pending approval in org A; only Amy may receive the digest.
  db.prepare('UPDATE users SET digest_opt_out = 1 WHERE id = ?').run(userAIdle);
  const insAction = db.prepare("INSERT INTO agent_actions (org_id, user_id, kind, payload, preview, status) VALUES (?, ?, 'draft_appeal', '{}', 'letter', 'pending')");
  insAction.run(orgA, userA);
  insAction.run(orgA, userAIdle);
  const digestNow = new Date('2026-10-28T12:30:00.000Z'); // 08:30 EDT window
  const ds = await watchdog.runDigestOnce(digestNow);
  check('digest: sent to the non-opted-out owner', mails.some((m) => m.to === 'amy@rhythm.test'), JSON.stringify(mails.map((m) => m.to)) + ' ' + JSON.stringify(ds));
  check('digest: opted-out user receives nothing', !mails.some((m) => m.to === 'ivan@rhythm.test'), JSON.stringify(mails.map((m) => m.to)));
  console.log('[rhythm] ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('  FAIL [rhythm] runner error: ' + (e.stack || e.message)); process.exit(1); });
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
const stepMap = (data) => Object.fromEntries((data.steps || []).map((s) => [s.key, s.done]));

async function main() {
  console.log('— deploy 101 WS-D: rhythm —');
  const { base, dbPath } = await boot(4264, {
    AGENT_ENABLED: '1', ANTHROPIC_API_KEY: 'test-key-not-real', AGENT_TRANSPORT_MODULE: FAKE,
  });
  const s = await api(base, 'POST', '/api/auth/signup', { orgName: 'Rhythm Org', name: 'Rita Owner', email: 'rita@rhythm.test', password: 'Test1234!' });
  const tok = s.data.token;
  const orgId = s.data.user.org_id;
  check('signup', s.status === 201 && !!tok, JSON.stringify(s.data).slice(0, 150));

  // ---------- D12: checklist derivation ----------
  let cl = await api(base, 'GET', '/api/agent/checklist', null, tok);
  check('D12: fresh org — nothing done, not complete', cl.status === 200 && cl.data.complete === false
    && Object.values(stepMap(cl.data)).every((v) => v === false), JSON.stringify(cl.data).slice(0, 300));

  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(dbPath);
  const payer = Number(raw.prepare("INSERT INTO payers (name, type, org_id) VALUES ('Aetna', 'commercial', ?)").run(orgId).lastInsertRowid);
  const claimId = Number(raw.prepare(`INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date, billed_amount, paid_amount, status, denial_reason)
    VALUES (?, 'RC-1', 'Pat C', ?, '2026-09-01', 400, 0, 'denied', 'CO-50 - Non-covered')`).run(orgId, payer).lastInsertRowid);
  cl = await api(base, 'GET', '/api/agent/checklist', null, tok);
  check('D12: claims step flips when a claim exists', stepMap(cl.data).claims === true && stepMap(cl.data).audit === false,
    JSON.stringify(stepMap(cl.data)));

  const aud = await api(base, 'POST', '/api/agent/audit/run', { source: 'workspace' }, tok);
  check('D12: audit run ok', aud.status === 201, `status=${aud.status} ${JSON.stringify(aud.data).slice(0, 150)}`);
  cl = await api(base, 'GET', '/api/agent/checklist', null, tok);
  check('D12: audit step flips after an audit ran', stepMap(cl.data).audit === true, JSON.stringify(stepMap(cl.data)));

  const brief = await api(base, 'GET', '/api/agent/brief', null, tok);
  check('D12: brief generates (lazy path)', brief.status === 200 && !!brief.data.brief, `status=${brief.status}`);
  cl = await api(base, 'GET', '/api/agent/checklist', null, tok);
  check('D12: brief step flips once a brief exists', stepMap(cl.data).brief === true && stepMap(cl.data).appeal === false,
    JSON.stringify(stepMap(cl.data)));

  const appeal = await api(base, 'POST', '/api/appeals', { claim_id: claimId, notes: 'Manual appeal to get started' }, tok);
  check('D12: manual appeal creates', [200, 201].includes(appeal.status), `status=${appeal.status} ${JSON.stringify(appeal.data).slice(0, 150)}`);
  cl = await api(base, 'GET', '/api/agent/checklist', null, tok);
  check('D12: decision step flips via manual appeal; checklist completes', stepMap(cl.data).appeal === true && cl.data.complete === true,
    JSON.stringify(stepMap(cl.data)) + ' complete=' + cl.data.complete);

  // Dismiss: a second org, owner-only.
  const s2 = await api(base, 'POST', '/api/auth/signup', { orgName: 'Dismiss Org', name: 'Dan Owner', email: 'dan@rhythm.test', password: 'Test1234!' });
  const tok2 = s2.data.token;
  const dis = await api(base, 'PUT', '/api/agent/checklist/dismiss', {}, tok2);
  check('D12: owner dismiss works', dis.status === 200 && dis.data.dismissed === true, `status=${dis.status}`);
  const cl2 = await api(base, 'GET', '/api/agent/checklist', null, tok2);
  check('D12: dismissed flag reads back', cl2.data.dismissed === true, JSON.stringify(cl2.data).slice(0, 150));

  // ---------- D14: notification watermark ----------
  const prop = await api(base, 'POST', '/api/agent/actions/propose', { kind: 'draft_appeal', claim_id: claimId }, tok);
  check('D14: propose creates a pending approval', prop.status === 201 && prop.data.action.status === 'pending',
    JSON.stringify(prop.data).slice(0, 200));
  let n = await api(base, 'GET', '/api/agent/notifications', null, tok);
  check('D14: unread counts the pending approval', n.status === 200 && n.data.unread_count >= 1
    && (n.data.items || []).some((i) => i.category === 'approval'), JSON.stringify(n.data).slice(0, 300));
  const rd = await api(base, 'POST', '/api/agent/notifications/read', {}, tok);
  check('D14: marking read zeroes the unread count', rd.status === 200 && rd.data.unread_count === 0, JSON.stringify(rd.data).slice(0, 150));
  n = await api(base, 'GET', '/api/agent/notifications', null, tok);
  check('D14: unread stays 0 on re-read', n.data.unread_count === 0, JSON.stringify(n.data).slice(0, 150));
  const claim2 = Number(raw.prepare(`INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date, billed_amount, paid_amount, status, denial_reason)
    VALUES (?, 'RC-2', 'Pat D', ?, '2026-09-02', 400, 0, 'denied', 'CO-50 - Non-covered')`).run(orgId, payer).lastInsertRowid);
  await sleep(1100); // watermark + created_at are second-grain — step past the read second
  await api(base, 'POST', '/api/agent/actions/propose', { kind: 'draft_appeal', claim_id: claim2 }, tok);
  n = await api(base, 'GET', '/api/agent/notifications', null, tok);
  check('D14: a new item re-lights the badge', n.data.unread_count >= 1, `unread=${n.data.unread_count}`);
  const dp = await api(base, 'PUT', '/api/agent/notifications/digest-pref', { opt_out: true }, tok);
  check('D14: digest opt-out persists', dp.status === 200 && dp.data.digest_opt_out === true, JSON.stringify(dp.data).slice(0, 150));
  const dp2 = await api(base, 'PUT', '/api/agent/notifications/digest-pref', { opt_out: false }, tok);
  check('D14: digest opt-in restores', dp2.status === 200 && dp2.data.digest_opt_out === false, JSON.stringify(dp2.data).slice(0, 150));
  raw.close();

  console.log('— D13 + digest opt-out: runner (child) —');
  const run = spawnSync('node', [RUNNER], {
    env: {
      ...process.env, REPO_DIR: REPO, DB_PATH: path.join(TMP, 'runner.db'), JWT_SECRET: 'test-secret',
      AGENT_ENABLED: '1', ANTHROPIC_API_KEY: 'test-key-not-real', AGENT_TRANSPORT_MODULE: FAKE,
      EHR_AUTOPULL: 'off', AGENT_WATCHDOG: 'off', EMAIL_PROVIDER: 'console',
    },
    encoding: 'utf8', timeout: 180000,
  });
  process.stdout.write(run.stdout || '');
  if (run.stderr) process.stderr.write(run.stderr);
  check('D13: precompute + opt-out runner suite passes', run.status === 0, `exit=${run.status}`);

  console.log(`deploy101-rhythm: ${passed} passed, ${failed} failed`);
  for (const srv of servers) srv.kill('SIGTERM');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); for (const srv of servers) srv.kill('SIGTERM'); process.exit(1); });
