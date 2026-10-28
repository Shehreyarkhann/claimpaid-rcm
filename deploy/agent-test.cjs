// agent-test.cjs — Agent Phase 1 verification (dark-shipped in-app agent).
// Boots the real server against a SCRIPTED FAKE model transport (canonical
// level, via AGENT_TRANSPORT_MODULE) — no real key, no network. Verifies:
//   (unit) provider config resolution + Anthropic/OpenAI dialect conversions
//   (a) chat -> get_worklist tool -> reply summarizes ONLY the tool's data
//   (b) draft_appeal creates a PENDING action and saves NOTHING to the claim
//   (f) cross-org isolation: org B cannot read org A's convo or decide its actions
//   (c) approve -> appeal saved as a draft (status 'open', letter on the
//       timeline as a note, never 'submitted') + audit rows
//   (d) reject -> nothing saved + audit row
//   (e) flag off / key missing -> 403 AGENT_DISABLED; compat base-URL mode is
//       treated as enabled (502 from the unreachable endpoint, not 403)
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

// ---------------------------------------------------------------------------
// Unit checks: provider config + wire-dialect conversions (pure, in-process)
// ---------------------------------------------------------------------------
console.log('— unit: model client config + dialects —');
const model = require(path.join(REPO, 'server/src/agent/model.js'));
{
  const c1 = model.resolveProviderConfig({ ANTHROPIC_API_KEY: 'k1' });
  check('config: native provider by default', c1.provider === 'anthropic' && c1.baseUrl === null);
  check("config: native default model is 'claude-sonnet-5-5'", c1.model === 'claude-sonnet-5-5', c1.model);
  check('config: ANTHROPIC_API_KEY used natively', c1.apiKey === 'k1');
  const c2 = model.resolveProviderConfig({ AGENT_API_KEY: 'g', ANTHROPIC_API_KEY: 'k1' });
  check('config: AGENT_API_KEY wins over ANTHROPIC_API_KEY', c2.apiKey === 'g');
  const c3 = model.resolveProviderConfig({ AGENT_BASE_URL: 'https://api.deepseek.com/v1/', AGENT_API_KEY: 'k2' });
  check('config: base URL selects openai-compatible', c3.provider === 'openai-compatible');
  check('config: base URL trailing slash trimmed', c3.baseUrl === 'https://api.deepseek.com/v1', c3.baseUrl);
  check("config: compat default model is 'deepseek-chat'", c3.model === 'deepseek-chat', c3.model);
  const c4 = model.resolveProviderConfig({ AGENT_BASE_URL: 'https://x.example/v1', AGENT_API_KEY: 'k', AGENT_MODEL: 'grok-4' });
  check('config: AGENT_MODEL overrides in compat mode', c4.model === 'grok-4');
  const c5 = model.resolveProviderConfig({ ANTHROPIC_API_KEY: 'k', AGENT_MODEL: 'claude-opus-4-5' });
  check('config: AGENT_MODEL overrides natively', c5.model === 'claude-opus-4-5');

  const toolDef = [{ name: 'get_worklist', description: 'd', input_schema: { type: 'object', properties: { scope: { type: 'string' } } } }];
  const canon = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'tu1', name: 'get_worklist', input: { scope: 'all' } }] },
    { role: 'user', toolResults: [{ id: 'tu1', output: '{"summary":{"total":1}}', isError: false }] },
  ];
  const areq = model.buildAnthropicRequest({ system: 'S', messages: canon, tools: toolDef, model: 'm', maxTokens: 100 });
  check('anthropic: tool def uses input_schema', !!areq.tools[0].input_schema);
  check('anthropic: assistant tool_use block', areq.messages[1].content[0].type === 'tool_use' && areq.messages[1].content[0].name === 'get_worklist');
  check('anthropic: user tool_result block', areq.messages[2].content[0].type === 'tool_result' && areq.messages[2].content[0].tool_use_id === 'tu1');
  const aresp = model.parseAnthropicResponse({ content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 'tu9', name: 'get_claim', input: { claim_id: 3 } }], stop_reason: 'tool_use' });
  check('anthropic: response parsed', aresp.text === 'hello' && aresp.toolCalls.length === 1 && aresp.toolCalls[0].input.claim_id === 3);

  const oreq = model.buildOpenAiRequest({ system: 'S', messages: canon, tools: toolDef, model: 'm', maxTokens: 100 });
  check('openai: system message first', oreq.messages[0].role === 'system');
  check('openai: tool def is function w/ parameters', oreq.tools[0].type === 'function' && !!oreq.tools[0].function.parameters);
  const oAssist = oreq.messages.find((m) => m.role === 'assistant');
  check('openai: assistant tool_calls serialized', !!oAssist && oAssist.tool_calls[0].function.name === 'get_worklist' && oAssist.tool_calls[0].function.arguments === '{"scope":"all"}');
  const oTool = oreq.messages.find((m) => m.role === 'tool');
  check('openai: tool result message', !!oTool && oTool.tool_call_id === 'tu1');
  const oresp = model.parseOpenAiResponse({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'draft_appeal', arguments: '{"claim_id":7}' } }] }, finish_reason: 'tool_calls' }] });
  check('openai: response parsed', oresp.toolCalls.length === 1 && oresp.toolCalls[0].input.claim_id === 7);
}

// ---------------------------------------------------------------------------
// HTTP suite against the scripted fake transport
// ---------------------------------------------------------------------------
const TMP = '/tmp/agent-test';
const FAKE = path.join(TMP, 'fake-transport.cjs');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(FAKE, `'use strict';
// Scripted canonical fake: answers from tool results when present, else
// picks a tool from the user's words. Summaries are BUILT from the tool
// payload, so a reply can only contain facts the tools returned.
async function transport({ messages }) {
  const last = messages[messages.length - 1];
  if (last && last.toolResults) {
    let text = '';
    for (const r of last.toolResults) {
      let data = {};
      try { data = JSON.parse(r.output); } catch {}
      if (data && data.summary && Array.isArray(data.items)) {
        text = 'Worklist: ' + data.summary.total + ' items, $' + data.summary.totalAtStake + ' at stake. Top: ' + (data.items.length ? data.items[0].title : 'none');
      } else if (data && data.action_id) {
        text = 'Draft appeal created (action ' + data.action_id + ') and shown for approval. Nothing saved yet.';
      } else if (data && data.error) {
        text = 'Tool said: ' + data.error;
      }
    }
    return { text: text || 'Done.', toolCalls: [], stopReason: 'end_turn' };
  }
  const text = last && typeof last.content === 'string' ? last.content : '';
  const m = text.match(/claim\\s+#?(\\d+)/i);
  if (/draft/i.test(text) && m) {
    return { text: '', toolCalls: [{ id: 'tu-draft-1', name: 'draft_appeal', input: { claim_id: Number(m[1]) } }], stopReason: 'tool_use' };
  }
  if (/worklist/i.test(text)) {
    return { text: '', toolCalls: [{ id: 'tu-wl-1', name: 'get_worklist', input: {} }], stopReason: 'tool_use' };
  }
  return { text: 'OK.', toolCalls: [], stopReason: 'end_turn' };
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

(async () => {
  try {
    console.log('— http: agent enabled with fake model —');
    const { base, dbPath } = await boot(4137, {
      AGENT_ENABLED: '1', ANTHROPIC_API_KEY: 'test-key-not-real', AGENT_TRANSPORT_MODULE: FAKE,
    });
    const s = await api(base, 'POST', '/api/auth/signup', { orgName: 'Agent Org A', name: 'Ann Owner', email: 'a@agent.test', password: 'Test1234!' });
    const tokA = s.data.token;
    check('org A signup', s.status === 201 && !!tokA, JSON.stringify(s.data).slice(0, 150));
    const sB = await api(base, 'POST', '/api/auth/signup', { orgName: 'Agent Org B', name: 'Bob Owner', email: 'b@agent.test', password: 'Test1234!' });
    const tokB = sB.data.token;
    check('org B signup', sB.status === 201 && !!tokB);

    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(dbPath);
    const orgA = raw.prepare("SELECT id FROM orgs WHERE name = 'Agent Org A'").get().id;
    const payerA = raw.prepare("SELECT id FROM payers WHERE org_id = ? AND name = 'Aetna'").get(orgA).id;
    const insClaim = raw.prepare(`INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date,
      billed_amount, paid_amount, status, denial_reason) VALUES (?, ?, ?, ?, date('now', '-10 days'), ?, 0, 'denied', ?)`);
    const claim1 = Number(insClaim.run(orgA, 'CLM-1001', 'Pat One', payerA, 900, 'Not medically necessary').lastInsertRowid);

    // (a) worklist chat
    const chat1 = await api(base, 'POST', '/api/agent/chat', { message: 'What is on my worklist?' }, tokA);
    check('(a) chat 200', chat1.status === 200, JSON.stringify(chat1.data).slice(0, 200));
    check('(a) reply summarizes only tool data (names the seeded denial)', typeof chat1.data.reply === 'string' && chat1.data.reply.includes('CLM-1001'), chat1.data.reply);
    check('(a) reply carries the tool total', chat1.data.reply.includes('$900'), chat1.data.reply);
    check('(a) tool_events recorded', Array.isArray(chat1.data.tool_events) && chat1.data.tool_events[0] && chat1.data.tool_events[0].tool === 'get_worklist');
    check('(a) no actions proposed', Array.isArray(chat1.data.actions) && chat1.data.actions.length === 0);
    const convoId = chat1.data.convo_id;
    const detail1 = await api(base, 'GET', `/api/agent/conversations/${convoId}`, null, tokA);
    check('(a) thread persisted (user + assistant)', detail1.data.messages && detail1.data.messages.length === 2
      && detail1.data.messages[0].role === 'user' && detail1.data.messages[1].role === 'assistant');
    check('(a) assistant message kept its tool_events', detail1.data.messages[1].tool_events.length === 1);

    // (b) draft_appeal -> PENDING action, nothing saved
    const chat2 = await api(base, 'POST', '/api/agent/chat', { message: `Please draft an appeal for claim ${claim1}` }, tokA);
    check('(b) draft chat 200', chat2.status === 200, JSON.stringify(chat2.data).slice(0, 200));
    check('(b) one action proposed', Array.isArray(chat2.data.actions) && chat2.data.actions.length === 1, JSON.stringify(chat2.data.actions).slice(0, 200));
    const action1 = chat2.data.actions[0] || {};
    check('(b) action is pending', action1.status === 'pending');
    check('(b) action preview is the letter', typeof action1.preview === 'string' && action1.preview.includes('CLM-1001'), (action1.preview || '').slice(0, 120));
    const appealsBefore = raw.prepare('SELECT COUNT(*) AS n FROM appeals WHERE claim_id = ?').get(claim1).n;
    check('(b) NOTHING saved to the claim (no appeal row)', appealsBefore === 0, `appeals=${appealsBefore}`);
    const actionRow = raw.prepare('SELECT status FROM agent_actions WHERE id = ?').get(action1.id);
    check('(b) action row persisted as pending', !!actionRow && actionRow.status === 'pending');
    const convo2 = chat2.data.convo_id;
    const listA = await api(base, 'GET', '/api/agent/conversations', null, tokA);
    const listed = (listA.data.conversations || []).find((c) => c.id === convo2);
    check('(b) conversation list shows the pending action', !!listed && listed.pending_actions === 1, JSON.stringify(listed || {}));

    // (f) cross-org isolation
    const readB = await api(base, 'GET', `/api/agent/conversations/${convo2}`, null, tokB);
    check('(f) org B cannot read org A conversation', readB.status === 404, `got ${readB.status}`);
    const approveB = await api(base, 'POST', `/api/agent/actions/${action1.id}/approve`, {}, tokB);
    check('(f) org B cannot approve org A action', approveB.status === 404, `got ${approveB.status}`);
    const listB = await api(base, 'GET', '/api/agent/conversations', null, tokB);
    check('(f) org B conversation list is its own (empty)', (listB.data.conversations || []).length === 0);

    // (c) approve -> draft appeal saved + audit
    const appr = await api(base, 'POST', `/api/agent/actions/${action1.id}/approve`, {}, tokA);
    check('(c) approve 200 + executed', appr.status === 200 && appr.data.action && appr.data.action.status === 'executed', JSON.stringify(appr.data).slice(0, 200));
    const appeal = raw.prepare('SELECT * FROM appeals WHERE claim_id = ?').get(claim1);
    check('(c) appeal row now exists', !!appeal);
    check("(c) appeal is a draft ('open', never 'submitted')", !!appeal && appeal.status === 'open', appeal && appeal.status);
    const note = appeal ? raw.prepare('SELECT note FROM appeal_notes WHERE appeal_id = ?').get(appeal.id) : null;
    check('(c) letter saved on the appeal timeline', !!note && note.note.includes('CLM-1001'), note ? note.note.slice(0, 100) : 'no note');
    const auditActs = raw.prepare("SELECT action FROM audit_log WHERE resource_type = 'agent_action' AND resource_id = ? ORDER BY id").all(String(action1.id)).map((r) => r.action);
    check('(c) audit rows for approve + execute', auditActs.includes('agent_action_approve') && auditActs.includes('agent_action_execute'), auditActs.join(','));
    check('(c) action result carries the appeal id', !!(appr.data.action.result && appr.data.action.result.appeal_id === (appeal && appeal.id)));
    const apprAgain = await api(base, 'POST', `/api/agent/actions/${action1.id}/approve`, {}, tokA);
    check('(c) double-approve is a 409', apprAgain.status === 409, `got ${apprAgain.status}`);

    // (d) reject -> nothing saved
    const claim2 = Number(insClaim.run(orgA, 'CLM-1002', 'Pat Two', payerA, 400, 'Duplicate claim').lastInsertRowid);
    const chat3 = await api(base, 'POST', '/api/agent/chat', { message: `Please draft an appeal for claim ${claim2}` }, tokA);
    const action2 = (chat3.data.actions || [])[0] || {};
    check('(d) second draft proposed', !!action2.id && action2.status === 'pending', JSON.stringify(chat3.data).slice(0, 160));
    const rej = await api(base, 'POST', `/api/agent/actions/${action2.id}/reject`, {}, tokA);
    check('(d) reject 200 + rejected', rej.status === 200 && rej.data.action && rej.data.action.status === 'rejected', JSON.stringify(rej.data).slice(0, 160));
    const appeals2 = raw.prepare('SELECT COUNT(*) AS n FROM appeals WHERE claim_id = ?').get(claim2).n;
    check('(d) nothing saved for the rejected draft', appeals2 === 0, `appeals=${appeals2}`);
    const auditRej = raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE resource_type = 'agent_action' AND resource_id = ? AND action = 'agent_action_reject'").get(String(action2.id)).n;
    check('(d) audit row for reject', auditRej === 1);
    raw.close();

    // (e) disabled variants
    console.log('— http: disabled + compat-mode boots —');
    const off1 = await boot(4138, { ANTHROPIC_API_KEY: 'some-key' }); // AGENT_ENABLED unset
    const so1 = await api(off1.base, 'POST', '/api/auth/signup', { orgName: 'Off Org', name: 'Ola Off', email: 'o@off.test', password: 'Test1234!' });
    const offChat = await api(off1.base, 'POST', '/api/agent/chat', { message: 'hi' }, so1.data.token);
    check('(e) flag unset -> 403 AGENT_DISABLED', offChat.status === 403 && offChat.data.code === 'AGENT_DISABLED', JSON.stringify(offChat.data));

    const off2 = await boot(4139, { AGENT_ENABLED: '1' }); // no key anywhere
    const so2 = await api(off2.base, 'POST', '/api/auth/signup', { orgName: 'NoKey Org', name: 'Ned Nokey', email: 'n@nokey.test', password: 'Test1234!' });
    const offChat2 = await api(off2.base, 'POST', '/api/agent/chat', { message: 'hi' }, so2.data.token);
    check('(e) enabled but no key -> 403 AGENT_DISABLED', offChat2.status === 403 && offChat2.data.code === 'AGENT_DISABLED', JSON.stringify(offChat2.data));

    const compat = await boot(4140, { AGENT_ENABLED: '1', AGENT_BASE_URL: 'http://127.0.0.1:9/v1', AGENT_API_KEY: 'compat-key' });
    const so3 = await api(compat.base, 'POST', '/api/auth/signup', { orgName: 'Compat Org', name: 'Cam Compat', email: 'c@compat.test', password: 'Test1234!' });
    const compatChat = await api(compat.base, 'POST', '/api/agent/chat', { message: 'hi' }, so3.data.token);
    check('(e) compat base-URL mode counts as enabled (502 model error, not 403)', compatChat.status === 502 && compatChat.data.code === 'AGENT_MODEL_ERROR', `${compatChat.status} ${JSON.stringify(compatChat.data).slice(0, 140)}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL suite error: ${e.message}`);
  } finally {
    for (const s of servers) { try { s.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
