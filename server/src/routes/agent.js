const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired, requireProduct } = require('../auth');
const { agentEnabled, AGENT_DISABLED_BODY } = require('../featureFlags');
const model = require('../agent/model');
const { TOOL_DEFS, createExecutor } = require('../agent/tools');
const { getAction, serializeAction, approveAction, rejectAction } = require('../agent/actions');
const { getOrCreateBrief } = require('../agent/brief');
const { checkAiQueryQuota, quotaExceeded, recordAgentTurn } = require('../usage');

const router = express.Router();
router.use(authRequired, requireProduct('rcm'));
// Dark-shipped: until AGENT_ENABLED=1 AND a provider key are configured,
// every agent endpoint answers the same 403 the client renders as its
// "not enabled" state (mirrors the FEATURE_HELD pattern). The plans-only
// gate in authRequired still runs first, like every other business API.
router.use((req, res, next) => (agentEnabled() ? next() : res.status(403).json(AGENT_DISABLED_BODY)));
const canDecide = roleRequired('owner', 'biller');

const SYSTEM_PROMPT = [
  "You are the ClaimPaid agent — an in-app revenue-cycle assistant for a medical billing team working inside ClaimPaid RCM.",
  'You help the signed-in user work their organization\'s denial and A/R queue.',
  '',
  'Rules:',
  '- Work ONLY from tool data. Never invent claim numbers, amounts, dates, payer rules, or statuses. If a tool returns nothing or errors, say so plainly.',
  "- Use get_worklist for questions about what to work on, priorities, filing deadlines across the queue, or dollars at stake. Use scope 'mine' when the user asks about their own assigned work.",
  '- Use get_claim before discussing a specific claim, and payer_rules for a payer\'s timely-filing limit, playbook guidance, or denial patterns.',
  '- For payer-POLICY questions (filing/appeal deadlines in the handbook, documentation or authorization rules, payer policy specifics), use search_handbook and cite the source it returns by name in your answer. If the handbook is unavailable or has no match, say so plainly — never reconstruct payer policy from memory.',
  '- draft_appeal is a PROPOSAL tool: it prepares an appeal letter and shows it to the user as an approval card. Nothing is saved to the claim unless the user approves the card. Never say an appeal was filed, sent, or submitted — ClaimPaid saves drafts; humans submit.',
  '- Keep replies concise and operational: lead with the answer, cite claim numbers and dollar amounts from the tools, and end with the single most useful next step when there is one.',
  '- You cannot change claim statuses, take payments, or edit settings, and you have no tools for that — say so if asked.',
].join('\n');

const HISTORY_LIMIT = 20;
const MAX_MESSAGE_CHARS = 4000;

function loadConvo(req, id) {
  return db.prepare('SELECT * FROM agent_conversations WHERE id = ? AND org_id = ? AND user_id = ?')
    .get(id, req.orgId, req.user.id);
}

function serializeMessage(row) {
  let events = [];
  try { events = row.tool_events ? JSON.parse(row.tool_events) : []; } catch { events = []; }
  return { id: row.id, role: row.role, content: row.content || '', tool_events: events, created_at: row.created_at };
}

// --- Morning brief (Phase 2): lazy per-day generation, then stored ---
router.get('/brief', async (req, res) => {
  try {
    const { brief, actions } = await getOrCreateBrief({ orgId: req.orgId, user: req.user });
    res.json({ brief, actions });
  } catch (e) {
    console.error('[agent] brief failed:', e.message);
    res.status(500).json({ error: 'The morning brief could not be prepared. Try again in a moment.' });
  }
});

// --- Chat: one user turn through the tool-use loop ---
router.post('/chat', async (req, res) => {
  const { convo_id, message } = req.body || {};
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) return res.status(400).json({ error: 'A message is required' });
  if (text.length > MAX_MESSAGE_CHARS) return res.status(400).json({ error: `Message is too long (max ${MAX_MESSAGE_CHARS} characters)` });

  // AI-query quota gate (Phase 2 metering): BEFORE the turn runs. Fires
  // only for plans carrying a positive finite AI allowance (Pro/AI);
  // plans without one (Starter 0, Enterprise null) are counted, never
  // blocked — see checkAiQueryQuota in usage.js. Super-admin exempt,
  // mirroring checkClaimQuota.
  if (!req.isSuperAdmin) {
    const gate = checkAiQueryQuota(req.orgId);
    if (gate) return quotaExceeded(res, 'ai_query_limit_reached', gate.plan, gate.limit, gate.used);
  }

  let convo;
  if (convo_id != null) {
    convo = loadConvo(req, convo_id);
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });
  } else {
    const info = db.prepare('INSERT INTO agent_conversations (org_id, user_id, title) VALUES (?, ?, ?)')
      .run(req.orgId, req.user.id, text.slice(0, 80));
    convo = loadConvo(req, Number(info.lastInsertRowid));
  }

  const historyDesc = db.prepare('SELECT role, content FROM agent_messages WHERE convo_id = ? ORDER BY id DESC LIMIT ?')
    .all(convo.id, HISTORY_LIMIT);
  const history = historyDesc.reverse();

  db.prepare('INSERT INTO agent_messages (convo_id, role, content) VALUES (?, ?, ?)')
    .run(convo.id, 'user', text);

  let result;
  try {
    result = await model.runTurn({
      system: SYSTEM_PROMPT,
      history,
      userText: text,
      tools: TOOL_DEFS,
      executeTool: createExecutor({ orgId: req.orgId, user: req.user, convoId: convo.id }),
    });
  } catch (e) {
    // The user message stays saved (it is their words); no assistant reply is
    // fabricated. The client surfaces this as a retryable error.
    console.error('[agent] model turn failed:', e.message);
    return res.status(502).json({
      error: 'The agent model is unavailable right now. Your message was saved — try again in a moment.',
      code: 'AGENT_MODEL_ERROR',
    });
  }

  // Meter the COMPLETED turn (tokens summed across its tool iterations).
  recordAgentTurn(req.orgId, result.usage || {});

  db.prepare('INSERT INTO agent_messages (convo_id, role, content, tool_events) VALUES (?, ?, ?, ?)')
    .run(convo.id, 'assistant', result.reply, JSON.stringify(result.toolEvents || []));
  db.prepare("UPDATE agent_conversations SET updated_at = datetime('now') WHERE id = ?").run(convo.id);

  res.json({
    convo_id: convo.id,
    reply: result.reply,
    tool_events: result.toolEvents || [],
    actions: result.actions || [],
  });
});

// --- Conversation list (this user's, in this org) ---
router.get('/conversations', (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.title, c.created_at, c.updated_at,
      (SELECT COUNT(*) FROM agent_actions a WHERE a.convo_id = c.id AND a.status = 'pending') AS pending_actions
    FROM agent_conversations c
    WHERE c.org_id = ? AND c.user_id = ?
    ORDER BY c.updated_at DESC, c.id DESC
    LIMIT 50
  `).all(req.orgId, req.user.id);
  res.json({ conversations: rows });
});

// --- One conversation: thread + its approval cards ---
router.get('/conversations/:id', (req, res) => {
  const convo = loadConvo(req, req.params.id);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });
  const messages = db.prepare('SELECT * FROM agent_messages WHERE convo_id = ? ORDER BY id ASC').all(convo.id);
  const actions = db.prepare('SELECT * FROM agent_actions WHERE convo_id = ? ORDER BY id DESC').all(convo.id);
  res.json({
    conversation: { id: convo.id, title: convo.title, created_at: convo.created_at, updated_at: convo.updated_at },
    messages: messages.map(serializeMessage),
    actions: actions.map(serializeAction),
  });
});

// --- Decisions on proposed actions ---
router.post('/actions/:id/approve', canDecide, (req, res) => {
  const action = getAction(req.params.id, req.orgId);
  if (!action) return res.status(404).json({ error: 'Action not found' });
  try {
    return res.json({ action: serializeAction(approveAction(req, action)) });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/actions/:id/reject', canDecide, (req, res) => {
  const action = getAction(req.params.id, req.orgId);
  if (!action) return res.status(404).json({ error: 'Action not found' });
  try {
    return res.json({ action: serializeAction(rejectAction(req, action)) });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
