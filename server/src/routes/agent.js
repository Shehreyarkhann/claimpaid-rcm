const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired, requireProduct } = require('../auth');
const { agentEnabled, AGENT_DISABLED_BODY } = require('../featureFlags');
const model = require('../agent/model');
const { TOOL_DEFS, createExecutor, resolveClaim, buildApplyCodesAction } = require('../agent/tools');
const { getAction, serializeAction, approveAction, rejectAction } = require('../agent/actions');
const { getOrCreateBrief } = require('../agent/brief');
const predict = require('../agent/predict');
const eraResolve = require('../agent/eraResolve');
const { scrubClaim: runScrub } = require('../scrub');
const { sanitizeSuggestions, assessJob } = require('../coding/lib');
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
  '- Pre-claim checks: check_eligibility runs a real vendor eligibility check for a claim (relay its MODE honestly — a test-mode result is not a live payer answer), scrub_claim runs the deterministic pre-bill scrubber, and suggest_codes runs the quote-verified coding engine. Report suggest_codes verdicts EXACTLY as returned (Valid / Review / Abstain) — never soften an abstention or invent codes.',
  '- ERA exceptions: era_exceptions lists remittance lines that did not auto-post, each with a deterministic recommended disposition and its arithmetic. resolve_exception PROPOSES applying one disposition as an approval card — nothing posts or is ignored unless the user approves.',
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

// --- Insights (Phase 3): dashboard-level predictions from predict.js ---
router.get('/insights', (req, res) => {
  try {
    res.json(predict.insights(req.orgId));
  } catch (e) {
    console.error('[agent] insights failed:', e.message);
    res.status(500).json({ error: 'Insights could not be computed right now.' });
  }
});

// --- Per-claim analysis (Phase 3): predictions + recommended actions ---
function pendingActionFor(orgId, kind, matchSql, matchVal) {
  return db.prepare(`
    SELECT id FROM agent_actions WHERE org_id = ? AND kind = ? AND status = 'pending' AND ${matchSql}
  `).get(orgId, kind, matchVal);
}

router.get('/claims/:id/analysis', (req, res) => {
  const claim = resolveClaim(req.orgId, { claim_id: Number(req.params.id) });
  if (!claim) return res.status(404).json({ error: 'Claim not found' });
  try {
    const filing = predict.filingRisk(req.orgId, claim.id);
    const overturn = claim.status === 'denied'
      ? predict.appealOverturn(req.orgId, claim.payer_id, claim.denial_reason || null) : null;
    const pay = (claim.status === 'pending' || claim.status === 'in_ar')
      ? predict.payLikelihood(req.orgId, claim) : null;
    const exceptions = eraResolve.exceptionsForClaim(req.orgId, claim.id);
    const scrub = runScrub(claim);

    const recommendations = [];
    if (claim.status === 'denied') {
      const liveAppeal = db.prepare(
        "SELECT id FROM appeals WHERE claim_id = ? AND org_id = ? AND status NOT IN ('won', 'lost') LIMIT 1"
      ).get(claim.id, req.orgId);
      const pendingDraft = pendingActionFor(req.orgId, 'draft_appeal',
        "CAST(json_extract(payload, '$.claim_id') AS INTEGER) = ?", claim.id);
      if (!liveAppeal && !pendingDraft) {
        recommendations.push({
          kind: 'draft_appeal', spawnable: true, label: 'Draft an appeal for this denial',
          detail: overturn && overturn.value != null
            ? `Appeals like this overturn ${Math.round(overturn.value * 100)}% of the time here (n=${overturn.sampleSize}, ${overturn.label}).`
            : 'No decided appeals in this workspace yet to estimate the overturn chance.',
        });
      } else if (pendingDraft) {
        recommendations.push({
          kind: 'draft_appeal', spawnable: false, label: 'An appeal draft is already awaiting a decision',
          detail: 'Approve or reject it in the Agent tab.',
        });
      } else {
        recommendations.push({
          kind: 'draft_appeal', spawnable: false, label: 'An appeal is already open on this claim',
          detail: 'Work the open appeal in Denial Appeals.',
        });
      }
    }
    for (const ex of exceptions) {
      if (ex.recommendation.can_resolve) {
        recommendations.push({
          kind: 'resolve_exception', spawnable: true, era_line_id: ex.era_line_id,
          label: `Resolve ERA exception — ${ex.recommendation.label}`,
          detail: ex.recommendation.reason,
        });
      }
    }
    const job = db.prepare(
      "SELECT * FROM coding_jobs WHERE org_id = ? AND claim_id = ? AND status = 'complete' ORDER BY id DESC LIMIT 1"
    ).get(req.orgId, claim.id);
    if (job) {
      let validCount = 0;
      try {
        const parsed = JSON.parse(job.result_json || '{}');
        validCount = assessJob(job.note_text, sanitizeSuggestions(parsed.suggestions))
          .suggestions.filter((s) => s.status === 'valid').length;
      } catch { validCount = 0; }
      const pendingApply = pendingActionFor(req.orgId, 'apply_codes',
        "CAST(json_extract(payload, '$.job_id') AS INTEGER) = ?", job.id);
      if (validCount > 0 && !pendingApply) {
        recommendations.push({
          kind: 'apply_codes', spawnable: true, job_id: job.id,
          label: `Apply ${validCount} verified code${validCount === 1 ? '' : 's'} from the last coding run`,
          detail: 'Only codes the quote-verified engine marked Valid are proposed; approval applies them to the claim.',
        });
      }
    }
    if (scrub.errors > 0) {
      recommendations.push({
        kind: 'fix_scrub', spawnable: false,
        label: `Fix ${scrub.errors} scrub error${scrub.errors === 1 ? '' : 's'} before this claim can go out`,
        detail: scrub.issues.find((i) => i.severity === 'error')?.message || '',
      });
    } else if (!String(claim.cpt_codes || '').trim() || !String(claim.icd_codes || '').trim()) {
      recommendations.push({
        kind: 'suggest_codes', spawnable: false,
        label: 'Suggest codes from documentation',
        detail: 'Ask the agent to suggest codes — it runs the quote-verified engine on the claim\'s documentation and proposes the Valid set for your approval.',
      });
    }

    res.json({
      claim: {
        id: claim.id, claim_number: claim.claim_number, patient_name: claim.patient_name,
        payer: claim.payer, status: claim.status,
        billed_amount: claim.billed_amount, paid_amount: claim.paid_amount,
        denial_reason: claim.denial_reason || null,
      },
      filing_risk: filing,
      appeal_overturn: overturn,
      pay_likelihood: pay,
      era_exceptions: exceptions,
      scrub: {
        score: scrub.score, status: scrub.status, band: scrub.band, band_label: scrub.band_label,
        errors: scrub.errors, warnings: scrub.warnings,
      },
      recommendations,
    });
  } catch (e) {
    console.error('[agent] claim analysis failed:', e.message);
    res.status(500).json({ error: 'Analysis could not be computed right now.' });
  }
});

// --- Propose an action outside chat (Phase 3: claim-panel buttons) ---
// Creates a PENDING action through the same builders the tools use.
// Proposing never approves — decisions still happen on the standard cards.
router.post('/actions/propose', async (req, res) => {
  const { kind, claim_id, era_line_id } = req.body || {};
  try {
    if (kind === 'draft_appeal') {
      const execute = createExecutor({ orgId: req.orgId, user: req.user, convoId: null });
      const result = await execute('draft_appeal', { claim_id });
      if (result.isError) return res.status(400).json({ error: (result.output && result.output.error) || 'Could not draft that appeal.' });
      return res.status(201).json({ action: result.action });
    }
    if (kind === 'resolve_exception') {
      const row = eraResolve.buildResolveAction({ orgId: req.orgId, userId: req.user.id, convoId: null, lineId: era_line_id });
      return res.status(201).json({ action: serializeAction(row) });
    }
    if (kind === 'apply_codes') {
      const claim = resolveClaim(req.orgId, { claim_id });
      if (!claim) return res.status(404).json({ error: 'Claim not found' });
      const job = db.prepare(
        "SELECT * FROM coding_jobs WHERE org_id = ? AND claim_id = ? AND status = 'complete' ORDER BY id DESC LIMIT 1"
      ).get(req.orgId, claim.id);
      if (!job) return res.status(400).json({ error: 'No completed coding run exists for this claim — run Suggest codes first.' });
      let assessed;
      try {
        const parsed = JSON.parse(job.result_json || '{}');
        assessed = assessJob(job.note_text, sanitizeSuggestions(parsed.suggestions));
      } catch {
        return res.status(400).json({ error: 'The last coding run could not be re-read.' });
      }
      const row = buildApplyCodesAction({ orgId: req.orgId, userId: req.user.id, convoId: null, claim, jobId: job.id, assessed });
      if (!row) return res.status(400).json({ error: 'The last coding run produced no Valid codes to apply.' });
      return res.status(201).json({ action: serializeAction(row) });
    }
    return res.status(400).json({ error: `Unknown action kind '${kind}'` });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
});

// --- Watchdog alerts (Phase 4): today's actionable items for THIS user,
// computed exactly as the digest computes them — reading never sends.
const watchdog = require('../agent/watchdog');
router.get('/alerts', (req, res) => {
  try {
    const org = db.prepare('SELECT id, timezone, name FROM orgs WHERE id = ?').get(req.orgId);
    const items = watchdog.computeDigestItems(
      org || { id: req.orgId, timezone: null },
      { id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role },
    );
    res.json({ items });
  } catch (e) {
    console.error('[agent] alerts failed:', e.message);
    res.status(500).json({ error: 'Alerts could not be computed right now.' });
  }
});

// --- Run a read tool outside chat (Phase 4, WS3: the Rescue wizard) ---
// The wizard's engine: the Phase 3 read tools through the SAME executor
// the chat uses (same shared runners, same org scoping) — no tool logic
// is duplicated. A run counts as one metered agent turn, like a chat turn.
const RUNNABLE_TOOLS = new Set(['check_eligibility', 'scrub_claim', 'suggest_codes']);
router.post('/tools/run', async (req, res) => {
  const { tool, claim_id } = req.body || {};
  if (!RUNNABLE_TOOLS.has(tool)) {
    return res.status(400).json({ error: `Tool '${tool || ''}' cannot be run directly. Runnable: ${[...RUNNABLE_TOOLS].join(', ')}.` });
  }
  if (!Number.isInteger(claim_id)) return res.status(400).json({ error: 'claim_id (integer) is required.' });
  try {
    const execute = createExecutor({ orgId: req.orgId, user: req.user, convoId: null });
    const result = await execute(tool, { claim_id });
    recordAgentTurn(req.orgId, {});
    return res.json({
      tool,
      is_error: !!result.isError,
      output: result.output,
      event: result.event || null,
      action: result.action || null,
    });
  } catch (e) {
    console.error('[agent] tools/run failed:', e.message);
    return res.status(500).json({ error: 'That check could not be run right now.' });
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
