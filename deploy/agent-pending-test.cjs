// agent-pending-test.cjs — Deploy #97 verification: the Agent tab's
// approvals surface can no longer orphan a pending draft.
// Boots the real server against the scripted fake model transport and
// seeds the exact live-bug shape: two CONVERSATION-LESS pending drafts
// (Rescue-wizard style, created on a "previous day"), one decided action,
// and one pending action in another org. Verifies:
//   (pending) GET /api/agent/actions/pending returns the org's pending
//             actions oldest-first, excludes decided + other orgs, 401s
//             unauthenticated, and reflects a decision immediately.
//   (brief)   GET /api/agent/brief dedupes (proposes nothing new for the
//             already-drafted claims) while every plan item carries
//             explicit claim_id + appeal_id — follow-up items resolve
//             their claim through the appeal.
//   (alerts)  GET /api/agent/alerts highlights carry claim ids: filing
//             risk (with claim status), overdue follow-ups, and ERA
//             exception highlights keyed by line + remittance + matched
//             claim — the fields the expandable panel wires buttons to.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = '/tmp/agent-pending-test';
const FAKE = path.join(TMP, 'fake-transport.cjs');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

fs.writeFileSync(FAKE, `'use strict';
async function transport({ messages }) {
  const last = messages[messages.length - 1];
  const usage = { inputTokens: 50, outputTokens: 10 };
  if (last && last.toolResults) {
    return { text: 'Done.', toolCalls: [], stopReason: 'end_turn', usage };
  }
  const text = last && typeof last.content === 'string' ? last.content : '';
  if (text.includes('MORNING BRIEF NARRATIVE')) {
    return { text: 'A busy queue today — start with the filing deadline.', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 300, outputTokens: 40 } };
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
  console.log('— http: boot (pending approvals + brief ids + alerts ids) —');
  const { base, dbPath } = await boot(4151, {
    AGENT_ENABLED: '1', ANTHROPIC_API_KEY: 'test-key-not-real', AGENT_TRANSPORT_MODULE: FAKE,
  });
  const sA = await api(base, 'POST', '/api/auth/signup', { orgName: 'Pending Org A', name: 'Ann Owner', email: 'a@pending.test', password: 'Test1234!' });
  const tokA = sA.data.token;
  check('org A signup', sA.status === 201 && !!tokA, JSON.stringify(sA.data).slice(0, 150));
  const sB = await api(base, 'POST', '/api/auth/signup', { orgName: 'Pending Org B', name: 'Bob Owner', email: 'b@pending.test', password: 'Test1234!' });
  const tokB = sB.data.token;
  check('org B signup', sB.status === 201 && !!tokB);

  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(dbPath);
  const orgA = raw.prepare("SELECT id FROM orgs WHERE name = 'Pending Org A'").get().id;
  const orgB = raw.prepare("SELECT id FROM orgs WHERE name = 'Pending Org B'").get().id;
  const userA = raw.prepare("SELECT id FROM users WHERE email = 'a@pending.test'").get().id;
  const userB = raw.prepare("SELECT id FROM users WHERE email = 'b@pending.test'").get().id;
  const payerA = raw.prepare("SELECT id FROM payers WHERE org_id = ? AND name = 'Aetna'").get(orgA).id;
  const payerB = raw.prepare("SELECT id FROM payers WHERE org_id = ? AND name = 'Aetna'").get(orgB).id;
  // Signup seeds a default rule per payer; pin Aetna to 90 days so the
  // filing math below is exact.
  raw.prepare('UPDATE payer_filing_rules SET filing_days = 90 WHERE org_id = ? AND payer_id = ?').run(orgA, payerA);

  const insClaim = raw.prepare(`INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date,
    billed_amount, paid_amount, status, denial_reason) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`);
  // W-1 / W-2: plain denials carrying the orphaned wizard drafts.
  const w1 = Number(insClaim.run(orgA, 'W-1', 'Pat W1', payerA, new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10), 500, 'denied', 'CO-50').lastInsertRowid);
  const w2 = Number(insClaim.run(orgA, 'W-2', 'Pat W2', payerA, new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10), 700, 'denied', 'CO-97').lastInsertRowid);
  // FU-1: denied, open appeal assigned to the owner, follow-up yesterday.
  const fu1 = Number(insClaim.run(orgA, 'FU-1', 'Pat FU', payerA, new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10), 900, 'denied', 'CO-50').lastInsertRowid);
  const fuAppeal = Number(raw.prepare(`INSERT INTO appeals (org_id, claim_id, assigned_to, status, priority, follow_up_date)
    VALUES (?, ?, ?, 'open', 'high', date('now', '-1 day'))`).run(orgA, fu1, userA).lastInsertRowid);
  // FR-1: pending, DOS 80 days ago against a 90-day rule -> ~10 days left.
  const fr1 = Number(insClaim.run(orgA, 'FR-1', 'Pat FR', payerA, new Date(Date.now() - 80 * 864e5).toISOString().slice(0, 10), 410, 'pending', null).lastInsertRowid);
  // Org B claim (target of org B's own pending action).
  const bClaim = Number(insClaim.run(orgB, 'B-1', 'Pat B', payerB, new Date(Date.now() - 5 * 864e5).toISOString().slice(0, 10), 300, 'denied', 'CO-50').lastInsertRowid);

  // ERA exception: a held line matched to W-1.
  const eraId = Number(raw.prepare("INSERT INTO era_remittances (org_id, payer_name, check_number, payment_amount, status) VALUES (?, 'Aetna', 'CHK-P', 0, 'received')").run(orgA).lastInsertRowid);
  const eraLine = Number(raw.prepare(`INSERT INTO era_claim_lines (era_id, org_id, clp_ref, patient_name, billed, paid, flags, match_claim_id, post_status)
    VALUES (?, ?, 'W-1', 'Pat W1', 85, 0, '["variance"]', ?, 'pending')`).run(eraId, orgA, w1).lastInsertRowid);

  // The actions: two conversation-less pendings (oldest = W-1), one
  // already-decided, one in org B. Explicit created_at pins the order.
  const insAction = raw.prepare(`INSERT INTO agent_actions (org_id, user_id, convo_id, kind, status, payload, preview, created_at)
    VALUES (?, ?, NULL, 'draft_appeal', ?, ?, ?, ?)`);
  const actOld = Number(insAction.run(orgA, userA, 'pending',
    JSON.stringify({ claim_id: w1, claim_number: 'W-1', letter: 'Dear Aetna — formal appeal of W-1.' }),
    'Wizard draft letter for W-1', '2026-01-01 09:00:00').lastInsertRowid);
  const actNew = Number(insAction.run(orgA, userA, 'pending',
    JSON.stringify({ claim_id: w2, claim_number: 'W-2' }),
    'Wizard draft letter for W-2', '2026-01-02 09:00:00').lastInsertRowid);
  insAction.run(orgA, userA, 'executed',
    JSON.stringify({ claim_id: w2, claim_number: 'W-2' }),
    'Decided long ago', '2025-12-31 09:00:00');
  const actB = Number(insAction.run(orgB, userB, 'pending',
    JSON.stringify({ claim_id: bClaim, claim_number: 'B-1' }),
    'Org B draft', '2026-01-01 10:00:00').lastInsertRowid);
  raw.close();

  // ---- (pending) the endpoint itself ----
  console.log('— GET /api/agent/actions/pending —');
  const noTok = await api(base, 'GET', '/api/agent/actions/pending', null, null);
  check('pending: unauthenticated -> 401', noTok.status === 401, `status=${noTok.status}`);
  const p1 = await api(base, 'GET', '/api/agent/actions/pending', null, tokA);
  check('pending: 200 for org A', p1.status === 200, JSON.stringify(p1.data).slice(0, 200));
  const list = p1.data.actions || [];
  check('pending: exactly the 2 pending org-A actions', list.length === 2, `n=${list.length} ids=${list.map((a) => a.id)}`);
  check('pending: oldest first (wizard draft W-1 before W-2)',
    list.length === 2 && list[0].id === actOld && list[1].id === actNew,
    JSON.stringify(list.map((a) => a.id)));
  check('pending: conversation-less wizard draft is present with its title',
    list.length > 0 && /W-1/.test(list[0].title || '') && list[0].status === 'pending',
    JSON.stringify(list[0] || {}).slice(0, 200));
  check('pending: serialized payload carries claim_id',
    list.length === 2 && list[0].payload.claim_id === w1 && list[1].payload.claim_id === w2,
    JSON.stringify(list.map((a) => a.payload)));
  const pB = await api(base, 'GET', '/api/agent/actions/pending', null, tokB);
  check('pending: org B sees only its own action',
    (pB.data.actions || []).length === 1 && pB.data.actions[0].id === actB,
    JSON.stringify(pB.data).slice(0, 200));

  // ---- (brief) dedupe held; plan items carry ids ----
  console.log('— GET /api/agent/brief plan ids —');
  const b1 = await api(base, 'GET', '/api/agent/brief', null, tokA);
  check('brief: 200', b1.status === 200, JSON.stringify(b1.data).slice(0, 200));
  const brief = b1.data.brief || {};
  check('brief: dedupe held — no new drafts proposed for drafted/appealed claims',
    Array.isArray(brief.proposed_draft_action_ids) && brief.proposed_draft_action_ids.length === 0,
    JSON.stringify(brief.proposed_draft_action_ids));
  const plan = brief.plan || [];
  check('brief: plan is non-empty', plan.length >= 3, `n=${plan.length} keys=${plan.map((p) => p.key)}`);
  check('brief: every plan item carries explicit claim_id + appeal_id keys',
    plan.every((p) => Object.prototype.hasOwnProperty.call(p, 'claim_id') && Object.prototype.hasOwnProperty.call(p, 'appeal_id')),
    JSON.stringify(plan).slice(0, 300));
  const fuItem = plan.find((p) => p.key === `followup-${fuAppeal}`);
  check('brief: follow-up item resolves claim_id through its appeal',
    !!fuItem && fuItem.claim_id === fu1 && fuItem.appeal_id === fuAppeal,
    JSON.stringify(fuItem || {}));
  const w1Item = plan.find((p) => p.key === `denial-${w1}`);
  check('brief: denial item carries its claim_id', !!w1Item && w1Item.claim_id === w1, JSON.stringify(w1Item || {}));

  // ---- (alerts) highlights carry the ids the panel wires to ----
  console.log('— GET /api/agent/alerts highlight ids —');
  const a1 = await api(base, 'GET', '/api/agent/alerts', null, tokA);
  check('alerts: 200', a1.status === 200, JSON.stringify(a1.data).slice(0, 200));
  const items = a1.data.items || {};
  check('alerts: pending approvals counted (2)', items.pending_approvals && items.pending_approvals.count === 2,
    JSON.stringify(items.pending_approvals || {}));
  const fuH = (items.followups_overdue && items.followups_overdue.highlights || [])[0] || {};
  check('alerts: follow-up highlight carries claim_id + appeal_id',
    items.followups_overdue.count === 1 && fuH.claim_id === fu1 && fuH.appeal_id === fuAppeal && fuH.claim_number === 'FU-1',
    JSON.stringify(items.followups_overdue || {}));
  const frH = (items.filing_risk && items.filing_risk.highlights || [])[0] || {};
  check('alerts: filing-risk highlight carries claim_id + status',
    items.filing_risk.count === 1 && frH.claim_id === fr1 && frH.status === 'pending' && frH.days_left != null && frH.days_left <= 14,
    JSON.stringify(items.filing_risk || {}));
  const eraH = (items.era_exceptions && items.era_exceptions.highlights || [])[0] || {};
  check('alerts: ERA exception highlight keyed by line + remittance + matched claim',
    items.era_exceptions.count === 1 && eraH.era_line_id === eraLine && eraH.remittance_id === eraId
      && eraH.claim_id === w1 && eraH.claim_number === 'W-1',
    JSON.stringify(items.era_exceptions || {}));
  check('alerts: total = 2 + 1 + 1 + 1', items.total === 5, `total=${items.total}`);

  // ---- decisions still flow through the gated routes, list reflects them ----
  console.log('— decide -> pending reflects it —');
  const ap = await api(base, 'POST', `/api/agent/actions/${actOld}/approve`, {}, tokA);
  check('approve: owner decision executes the draft', ap.status === 200 && ap.data.action && ap.data.action.status === 'executed',
    JSON.stringify(ap.data).slice(0, 200));
  const p2 = await api(base, 'GET', '/api/agent/actions/pending', null, tokA);
  check('pending: decided action leaves the list immediately',
    (p2.data.actions || []).length === 1 && p2.data.actions[0].id === actNew,
    JSON.stringify(p2.data).slice(0, 200));

  console.log(`\nagent-pending-test: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((e) => { console.error('agent-pending-test crashed:', e); process.exitCode = 1; })
  .finally(() => { for (const s of servers) { try { s.kill('SIGKILL'); } catch { /* already dead */ } } });
