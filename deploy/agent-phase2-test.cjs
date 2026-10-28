// agent-phase2-test.cjs — Agent Phase 2 verification.
// Boots the real server against the scripted fake model transport (no real
// key) plus a stub AI service for the handbook endpoint. Verifies:
//   (unit) provider usage blocks parsed (both dialects); runTurn accumulates
//          usage across tool iterations; org-local date math.
//   (brief) first GET generates + persists a brief whose deterministic
//          sections match the seeded data; proposed drafts are created ONLY
//          for eligible claims (skip open-appeal / existing-pending-draft,
//          cap 3); second GET returns the same brief with no duplicates;
//          the brief narrative counts as one metered turn; cross-org
//          isolation for briefs and their actions.
//   (handbook) search_handbook tool: cited chunks from the (stubbed) AI
//          service flow into the reply with the "Searched the Payer Policy
//          Handbook" chip; AI service down -> graceful result, turn completes.
//   (metering) completed chat turns increment agent_usage with token totals;
//          usageForOrg merges AskBase + agent counts; the 402 gate fires at
//          the limit for a plan WITH an allowance (Pro) in the existing
//          error shape, and does NOT fire for Starter (allowance 0).
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
const MONTH = new Date().toISOString().slice(0, 7); // UTC month, matches monthKeyUtc

// ---------------------------------------------------------------------------
// Unit checks: usage threading + org-local dates
// ---------------------------------------------------------------------------
console.log('— unit: usage parsing + accumulation + org-local date —');
const model = require(path.join(REPO, 'server/src/agent/model.js'));
const { orgLocalDate } = require(path.join(REPO, 'server/src/agent/brief.js'));
{
  const a = model.parseAnthropicResponse({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 5 } });
  check('anthropic usage parsed', a.usage && a.usage.inputTokens === 12 && a.usage.outputTokens === 5, JSON.stringify(a.usage));
  const o = model.parseOpenAiResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } });
  check('openai usage parsed', o.usage && o.usage.inputTokens === 7 && o.usage.outputTokens === 3, JSON.stringify(o.usage));
  const noUsage = model.parseAnthropicResponse({ content: [{ type: 'text', text: 'x' }] });
  check('missing usage tolerated as zeros', noUsage.usage && noUsage.usage.inputTokens === 0 && noUsage.usage.outputTokens === 0);
}
(async () => {
  let calls = 0;
  const stub = async () => {
    calls++;
    if (calls === 1) return { text: '', toolCalls: [{ id: 't1', name: 'get_worklist', input: {} }], usage: { inputTokens: 10, outputTokens: 2 } };
    return { text: 'done', toolCalls: [], usage: { inputTokens: 10, outputTokens: 2 } };
  };
  const r = await model.runTurn({
    system: 'S', history: [], userText: 'hi',
    tools: [{ name: 'get_worklist', description: 'd', input_schema: { type: 'object' } }],
    executeTool: async () => ({ output: { ok: true }, event: { tool: 'get_worklist', label: 'x' } }),
    transport: stub,
  });
  check('runTurn accumulates usage across iterations', r.usage && r.usage.inputTokens === 20 && r.usage.outputTokens === 4 && r.usage.calls === 2, JSON.stringify(r.usage));
  const r2 = await model.runTurn({
    system: 'S', history: [], userText: 'hi', tools: [],
    executeTool: async () => ({ output: {}, event: {} }),
    transport: async () => ({ text: 'plain', toolCalls: [] }),
  });
  check('runTurn tolerates a transport with no usage', r2.usage && r2.usage.inputTokens === 0 && r2.usage.calls === 1, JSON.stringify(r2.usage));

  check('org-local date: NY is a day behind UTC in the small hours', orgLocalDate('America/New_York', new Date('2026-01-15T02:00:00Z')) === '2026-01-14');
  check('org-local date: UTC matches the UTC date', orgLocalDate('UTC', new Date('2026-01-15T02:00:00Z')) === '2026-01-15');
  check('org-local date: bogus timezone falls back without throwing', typeof orgLocalDate('Not/AZone', new Date('2026-01-15T02:00:00Z')) === 'string');
})().then(main).catch((e) => { failed++; console.log(`  FAIL unit async error: ${e.message}`); main(); });

// ---------------------------------------------------------------------------
// HTTP suites
// ---------------------------------------------------------------------------
const TMP = '/tmp/agent-p2-test';
const FAKE = path.join(TMP, 'fake-transport.cjs');
const AI_DB = path.join(TMP, 'fake-ai.db');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(FAKE, `'use strict';
// Scripted canonical fake v2: usage-bearing; routes on the user's words;
// the brief narrative prompt gets a fixed summary sentence.
async function transport({ messages }) {
  const last = messages[messages.length - 1];
  const usage = { inputTokens: 50, outputTokens: 10 };
  if (last && last.toolResults) {
    let text = '';
    for (const r of last.toolResults) {
      let data = {};
      try { data = JSON.parse(r.output); } catch {}
      if (data && data.summary && Array.isArray(data.items)) {
        text = 'Worklist: ' + data.summary.total + ' items, $' + data.summary.totalAtStake + ' at stake.';
      } else if (data && data.found && Array.isArray(data.chunks) && data.chunks.length) {
        text = 'From the handbook (' + data.chunks[0].source + '): ' + data.chunks[0].text;
      } else if (data && data.available === false) {
        text = 'The Payer Policy Handbook is unavailable right now, so I cannot check that policy.';
      } else if (data && data.action_id) {
        text = 'Draft appeal created (action ' + data.action_id + ').';
      } else if (data && data.error) {
        text = 'Tool said: ' + data.error;
      }
    }
    return { text: text || 'Done.', toolCalls: [], stopReason: 'end_turn', usage };
  }
  const text = last && typeof last.content === 'string' ? last.content : '';
  if (text.includes('MORNING BRIEF NARRATIVE')) {
    return { text: 'Six new denials landed overnight and one follow-up is overdue — start there.', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 300, outputTokens: 40 } };
  }
  if (/handbook/i.test(text)) {
    return { text: '', toolCalls: [{ id: 'tu-hb-1', name: 'search_handbook', input: { query: 'Aetna timely filing deadline' } }], stopReason: 'tool_use', usage };
  }
  if (/worklist/i.test(text)) {
    return { text: '', toolCalls: [{ id: 'tu-wl-1', name: 'get_worklist', input: {} }], stopReason: 'tool_use', usage };
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
  // Stub AI service: serves the handbook chunks, records the service token.
  let lastServiceToken = null;
  const stubAi = http.createServer((req, res) => {
    if (req.url === '/api/v1/kb-search' && req.method === 'POST') {
      lastServiceToken = req.headers['x-service-token'] || null;
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          kb: 'Payer Policy Handbook',
          chunks: [{ text: 'Aetna timely filing: claims must be filed within 120 days of the date of service.', source: 'aetna-filing.txt', score: 0.91 }],
        }));
      });
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => stubAi.listen(4199, '127.0.0.1', r));

  try {
    console.log('— http: boot A (brief + handbook + metering) —');
    const { base, dbPath } = await boot(4143, {
      AGENT_ENABLED: '1', ANTHROPIC_API_KEY: 'test-key-not-real', AGENT_TRANSPORT_MODULE: FAKE,
      AI_DB_PATH: AI_DB, AI_SERVICE_URL: 'http://127.0.0.1:4199',
    });
    const sA = await api(base, 'POST', '/api/auth/signup', { orgName: 'P2 Org A', name: 'Ann Owner', email: 'a@p2.test', password: 'Test1234!' });
    const tokA = sA.data.token;
    check('org A signup', sA.status === 201 && !!tokA, JSON.stringify(sA.data).slice(0, 150));
    const sB = await api(base, 'POST', '/api/auth/signup', { orgName: 'P2 Org B', name: 'Bob Owner', email: 'b@p2.test', password: 'Test1234!' });
    const tokB = sB.data.token;
    check('org B signup', sB.status === 201 && !!tokB);

    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(dbPath);
    const orgA = raw.prepare("SELECT id FROM orgs WHERE name = 'P2 Org A'").get().id;
    const orgB = raw.prepare("SELECT id FROM orgs WHERE name = 'P2 Org B'").get().id;
    const userA = raw.prepare("SELECT id FROM users WHERE email = 'a@p2.test'").get().id;
    const payerA = raw.prepare("SELECT id FROM payers WHERE org_id = ? AND name = 'Aetna'").get(orgA).id;

    // Fake AskBase usage DB: org A asked 7 AI questions this month.
    const aiDb = new DatabaseSync(AI_DB);
    aiDb.exec('CREATE TABLE IF NOT EXISTS ai_query_usage (rcm_org_id INTEGER, month TEXT, queries INTEGER)');
    aiDb.prepare('INSERT INTO ai_query_usage (rcm_org_id, month, queries) VALUES (?, ?, 7)').run(orgA, MONTH);
    aiDb.close();

    // Seed: six fresh denials. 2005 has an OPEN appeal (follow-up yesterday);
    // 2006 already has a PENDING draft action. Drafts may only be proposed
    // for three of {2001, 2002, 2003, 2004}.
    const insClaim = raw.prepare(`INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date,
      billed_amount, paid_amount, status, denial_reason) VALUES (?, ?, ?, ?, date('now', '-10 days'), ?, 0, 'denied', ?)`);
    const claimIds = {};
    for (const [num, amt] of [['CLM-2001', 500], ['CLM-2002', 700], ['CLM-2003', 300], ['CLM-2004', 200], ['CLM-2005', 900], ['CLM-2006', 800]]) {
      claimIds[num] = Number(insClaim.run(orgA, num, 'Pat ' + num, payerA, amt, 'CO-50 not medically necessary').lastInsertRowid);
    }
    raw.prepare("INSERT INTO appeals (org_id, claim_id, assigned_to, status, priority, follow_up_date) VALUES (?, ?, ?, 'open', 'high', date('now', '-1 day'))")
      .run(orgA, claimIds['CLM-2005'], userA);
    raw.prepare(`INSERT INTO agent_actions (org_id, user_id, convo_id, kind, status, payload, preview)
      VALUES (?, ?, NULL, 'draft_appeal', 'pending', ?, 'Pre-existing draft letter')`)
      .run(orgA, userA, JSON.stringify({ claim_id: claimIds['CLM-2006'], claim_number: 'CLM-2006' }));
    // ERA: one posted line ($250.50) + one exception on hold.
    const eraId = Number(raw.prepare("INSERT INTO era_remittances (org_id, payer_name, check_number, payment_amount, status) VALUES (?, 'Aetna', 'CHK-900', 250.5, 'posted')").run(orgA).lastInsertRowid);
    raw.prepare("INSERT INTO era_claim_lines (era_id, org_id, clp_ref, patient_name, paid, post_status, posted_at) VALUES (?, ?, 'CLM-2001', 'Pat CLM-2001', 250.5, 'posted', datetime('now'))").run(eraId, orgA);
    raw.prepare("INSERT INTO era_claim_lines (era_id, org_id, clp_ref, patient_name, paid, flags, post_status) VALUES (?, ?, 'CLM-2099', 'Pat X', 0, '[\"variance_exceeded\"]', 'pending')").run(eraId, orgA);

    // ---- Brief: first GET generates + persists ----
    console.log('— brief —');
    const b1 = await api(base, 'GET', '/api/agent/brief', null, tokA);
    check('brief: first GET 200', b1.status === 200, JSON.stringify(b1.data).slice(0, 200));
    const brief = b1.data.brief || {};
    const wa = brief.while_away || {};
    check('brief: 6 new denials counted', wa.new_denials && wa.new_denials.count === 6, JSON.stringify(wa.new_denials || {}));
    check('brief: top denial highlight is the $900 claim', !!(wa.new_denials && wa.new_denials.highlights[0] && wa.new_denials.highlights[0].claim_number === 'CLM-2005'));
    check('brief: ERA postings counted with total', wa.era_postings && wa.era_postings.count === 1 && wa.era_postings.total_paid === 250.5, JSON.stringify(wa.era_postings || {}));
    check('brief: ERA exceptions new + on hold', wa.era_exceptions && wa.era_exceptions.new_count === 1 && wa.era_exceptions.on_hold_count === 1, JSON.stringify(wa.era_exceptions || {}));
    check('brief: 1 follow-up passed', wa.followups_passed && wa.followups_passed.count === 1, JSON.stringify(wa.followups_passed || {}));
    check('brief: plan leads with the overdue follow-up', Array.isArray(brief.plan) && brief.plan.length >= 5 && brief.plan[0].type === 'followup' && brief.plan[0].claim_id === claimIds['CLM-2005'], JSON.stringify((brief.plan || []).map((p) => p.type)));
    check('brief: plan items carry reasons', Array.isArray(brief.plan) && brief.plan.every((p) => typeof p.reason === 'string' && p.reason.length > 0));
    check('brief: narrative summary from the single model call', brief.summary === 'Six new denials landed overnight and one follow-up is overdue — start there.', String(brief.summary));
    check('brief: 3 proposed draft actions returned', Array.isArray(b1.data.actions) && b1.data.actions.length === 3, `got ${(b1.data.actions || []).length}`);
    const draftedNums = raw.prepare("SELECT payload FROM agent_actions WHERE org_id = ? AND kind = 'draft_appeal' AND status = 'pending' AND convo_id IS NULL").all(orgA)
      .map((r) => JSON.parse(r.payload).claim_number).sort();
    check('brief: drafts only for eligible claims (skip appeal + pending-draft, cap 3)',
      JSON.stringify(draftedNums) === JSON.stringify(['CLM-2001', 'CLM-2002', 'CLM-2003', 'CLM-2006']), draftedNums.join(','));
    const briefDraftNums = (b1.data.actions || []).map((a) => (a.payload && a.payload.claim_number) || (a.preview || '').match(/CLM-\d+/)?.[0]).sort();
    check('brief: returned cards are the 3 new drafts', JSON.stringify(briefDraftNums) === JSON.stringify(['CLM-2001', 'CLM-2002', 'CLM-2003']), briefDraftNums.join(','));
    let usageA = raw.prepare('SELECT * FROM agent_usage WHERE org_id = ? AND month = ?').get(orgA, MONTH);
    check('brief: narrative counted as ONE metered turn with its tokens', !!usageA && usageA.turns === 1 && usageA.input_tokens === 300 && usageA.output_tokens === 40, JSON.stringify(usageA || {}));

    // ---- Brief: second GET is the same stored brief ----
    const b2 = await api(base, 'GET', '/api/agent/brief', null, tokA);
    check('brief: second GET returns the same brief', b2.data.brief && b2.data.brief.id === brief.id, `${b2.data.brief && b2.data.brief.id} vs ${brief.id}`);
    const pendingAfter = raw.prepare("SELECT COUNT(*) AS n FROM agent_actions WHERE org_id = ? AND kind = 'draft_appeal' AND status = 'pending'").get(orgA).n;
    check('brief: no duplicate drafts on re-open', pendingAfter === 4, `pending=${pendingAfter}`);
    usageA = raw.prepare('SELECT * FROM agent_usage WHERE org_id = ? AND month = ?').get(orgA, MONTH);
    check('brief: no second narrative call on re-open', !!usageA && usageA.turns === 1, JSON.stringify(usageA || {}));

    // ---- Brief: cross-org isolation ----
    const bB = await api(base, 'GET', '/api/agent/brief', null, tokB);
    check('brief: org B gets its own (empty) brief', bB.status === 200 && bB.data.brief && bB.data.brief.while_away.new_denials.count === 0 && (bB.data.actions || []).length === 0, JSON.stringify(bB.data).slice(0, 160));
    check('brief: org B brief has no narrative (nothing to summarize)', bB.data.brief && bB.data.brief.summary === null);
    const briefActionId = (b1.data.actions || [])[0] && b1.data.actions[0].id;
    const crossApprove = await api(base, 'POST', `/api/agent/actions/${briefActionId}/approve`, {}, tokB);
    check('brief: org B cannot approve org A brief draft', crossApprove.status === 404, `got ${crossApprove.status}`);

    // ---- Metering: a completed chat turn ----
    console.log('— metering —');
    const chat1 = await api(base, 'POST', '/api/agent/chat', { message: 'What is on my worklist?' }, tokA);
    check('metering: worklist chat 200', chat1.status === 200, JSON.stringify(chat1.data).slice(0, 160));
    usageA = raw.prepare('SELECT * FROM agent_usage WHERE org_id = ? AND month = ?').get(orgA, MONTH);
    check('metering: chat turn increments turns + tokens (2 model calls summed)', !!usageA && usageA.turns === 2 && usageA.input_tokens === 400 && usageA.output_tokens === 60, JSON.stringify(usageA || {}));
    const usageRes = await api(base, 'GET', '/api/billing/usage', null, tokA);
    check('metering: usageForOrg merges AskBase (7) + agent (2) = 9', usageRes.data.aiQueries && usageRes.data.aiQueries.used === 9, JSON.stringify(usageRes.data.aiQueries || {}));
    check('metering: merged figure exposes the agent split', usageRes.data.aiQueries && usageRes.data.aiQueries.agentTurns === 2, JSON.stringify(usageRes.data.aiQueries || {}));

    // ---- Handbook tool (stubbed AI service) ----
    console.log('— handbook —');
    const chatHb = await api(base, 'POST', '/api/agent/chat', { message: 'What does the handbook say about Aetna timely filing?' }, tokA);
    check('handbook: chat 200', chatHb.status === 200, JSON.stringify(chatHb.data).slice(0, 200));
    check('handbook: reply carries the chunk fact', typeof chatHb.data.reply === 'string' && chatHb.data.reply.includes('120 days'), chatHb.data.reply);
    check('handbook: reply cites the source', typeof chatHb.data.reply === 'string' && chatHb.data.reply.includes('aetna-filing.txt'), chatHb.data.reply);
    check('handbook: tool chip label', Array.isArray(chatHb.data.tool_events) && chatHb.data.tool_events[0] && chatHb.data.tool_events[0].label === 'Searched the Payer Policy Handbook', JSON.stringify(chatHb.data.tool_events || []));
    check('handbook: service JWT was sent to the AI service', typeof lastServiceToken === 'string' && lastServiceToken.split('.').length === 3);

    // ---- Metering: Pro cap fires; Starter never blocks ----
    console.log('— quota gate —');
    raw.prepare("UPDATE orgs SET plan = 'pro' WHERE id = ?").run(orgA);
    raw.prepare('UPDATE agent_usage SET turns = 2000 WHERE org_id = ? AND month = ?').run(orgA, MONTH);
    const capped = await api(base, 'POST', '/api/agent/chat', { message: 'What is on my worklist?' }, tokA);
    check('quota: Pro at the limit -> 402', capped.status === 402, `got ${capped.status} ${JSON.stringify(capped.data).slice(0, 160)}`);
    check('quota: error shape matches plan-limit responses', capped.data.error === 'ai_query_limit_reached' && capped.data.limit === 2000 && typeof capped.data.used === 'number' && capped.data.used >= 2000 && typeof capped.data.message === 'string' && capped.data.message.includes('AI queries') && 'upgrade' in capped.data, JSON.stringify(capped.data).slice(0, 220));

    raw.prepare("UPDATE orgs SET plan = 'starter' WHERE id = ?").run(orgB);
    raw.prepare('INSERT INTO agent_usage (org_id, month, turns, input_tokens, output_tokens) VALUES (?, ?, 9999, 0, 0)').run(orgB, MONTH);
    const starterChat = await api(base, 'POST', '/api/agent/chat', { message: 'Hello there' }, tokB);
    check('quota: Starter (allowance 0) is NOT hard-blocked', starterChat.status === 200 && starterChat.data.reply === 'OK.', `got ${starterChat.status}`);
    const usageB = raw.prepare('SELECT turns FROM agent_usage WHERE org_id = ? AND month = ?').get(orgB, MONTH);
    check('quota: Starter turns are still counted', !!usageB && usageB.turns === 10000, JSON.stringify(usageB || {}));
    raw.close();

    // ---- Handbook: AI service down -> graceful ----
    console.log('— http: boot B (AI service down) —');
    const bootB = await boot(4144, {
      AGENT_ENABLED: '1', ANTHROPIC_API_KEY: 'test-key-not-real', AGENT_TRANSPORT_MODULE: FAKE,
      AI_SERVICE_URL: 'http://127.0.0.1:9',
    });
    const sC = await api(bootB.base, 'POST', '/api/auth/signup', { orgName: 'P2 Org C', name: 'Cat Owner', email: 'c@p2.test', password: 'Test1234!' });
    const downChat = await api(bootB.base, 'POST', '/api/agent/chat', { message: 'What does the handbook say about Aetna timely filing?' }, sC.data.token);
    check('handbook down: turn still completes (200)', downChat.status === 200, `got ${downChat.status} ${JSON.stringify(downChat.data).slice(0, 160)}`);
    check('handbook down: reply relays the unavailability', typeof downChat.data.reply === 'string' && downChat.data.reply.includes('unavailable'), downChat.data.reply);
    check('handbook down: chip shows the unavailable state', Array.isArray(downChat.data.tool_events) && downChat.data.tool_events[0] && downChat.data.tool_events[0].tool === 'search_handbook' && /unavailable/.test(downChat.data.tool_events[0].label), JSON.stringify(downChat.data.tool_events || []));
  } catch (e) {
    failed++;
    console.log(`  FAIL suite error: ${e.message}`);
  } finally {
    stubAi.close();
    for (const s of servers) { try { s.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
