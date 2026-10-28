'use strict';
// Agent tools v1 — thin adapters over EXISTING product logic. No business
// rules are re-implemented here: the worklist comes from worklistCore (the
// same computation as GET /api/worklist), filing/playbook data from the same
// tables + queries the Filing Rules and Playbook routes serve, and appeal
// letters from the existing appealLetters engine (org templates included).
//
// Every executor returns { output, isError?, event, action? } and never
// throws: output is what the model sees, event is the tool-activity chip
// shown to the user, action is a freshly created PENDING approval card.
const { db } = require('../db');
const { computeWorklist } = require('../worklistCore');
const { FILING_SELECT, FILING_JOIN } = require('../routes/filing');
const { generateLetter } = require('../appealLetters');
const { AI_SERVICE_URL, serviceToken } = require('../coding/lib');
const { createAction, serializeAction } = require('./actions');

const TOOL_DEFS = [
  {
    name: 'get_worklist',
    description: "Get the organization's ranked work queue (overdue appeal follow-ups, filing deadlines at risk, unworked denials, stale A/R) with totals at stake. Use scope 'mine' when the user asks about their own assigned work, otherwise 'all'.",
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['all', 'mine'], description: "Queue scope; default 'all'." },
      },
    },
  },
  {
    name: 'get_claim',
    description: 'Read one claim in detail: status, payer, billed/paid amounts, denial reason, timely-filing deadline, recent activity, and any appeals on it. Identify the claim by claim_id or exact claim_number (use get_worklist first if you only know it by description).',
    input_schema: {
      type: 'object',
      properties: {
        claim_id: { type: 'integer', description: 'Internal claim id, if known.' },
        claim_number: { type: 'string', description: 'Payer-facing claim number, e.g. HV-1013.' },
      },
    },
  },
  {
    name: 'payer_rules',
    description: "Get a payer's timely-filing limit for this organization, its playbook/appeal guidance entries, and its top denial reasons with denial counts.",
    input_schema: {
      type: 'object',
      properties: {
        payer: { type: 'string', description: 'Payer name, e.g. Aetna or UnitedHealthcare.' },
        payer_id: { type: 'integer', description: 'Payer id, if known.' },
      },
      required: ['payer'],
    },
  },
  {
    name: 'search_handbook',
    description: 'Search the Payer Policy Handbook (ClaimPaid\'s curated payer-policy knowledge base on the AI service) for payer policy: filing and appeal deadlines, documentation and authorization rules, payer-specific requirements. Returns cited excerpts — cite the source name in your answer. Use for payer-POLICY questions; use payer_rules for this workspace\'s own filing limits and denial data.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look up, e.g. "Aetna timely filing deadline" or "Cigna corrected claim rules".' },
      },
      required: ['query'],
    },
  },
  {
    name: 'draft_appeal',
    description: 'PROPOSE an appeal letter for a DENIED claim. This creates a pending approval card for the user with the full letter — it does NOT save anything to the claim and never submits or files anything. Only the user can approve it. Use only when the user asks to draft/write an appeal.',
    input_schema: {
      type: 'object',
      properties: {
        claim_id: { type: 'integer', description: 'Internal claim id, if known.' },
        claim_number: { type: 'string', description: 'Payer-facing claim number.' },
      },
    },
  },
];

function resolveClaim(orgId, input) {
  if (input && Number.isInteger(input.claim_id)) {
    return db.prepare('SELECT c.*, p.name AS payer FROM claims c LEFT JOIN payers p ON p.id = c.payer_id WHERE c.id = ? AND c.org_id = ?')
      .get(input.claim_id, orgId);
  }
  if (input && typeof input.claim_number === 'string' && input.claim_number.trim()) {
    return db.prepare('SELECT c.*, p.name AS payer FROM claims c LEFT JOIN payers p ON p.id = c.payer_id WHERE c.claim_number = ? COLLATE NOCASE AND c.org_id = ?')
      .get(input.claim_number.trim(), orgId);
  }
  return null;
}

function getWorklist(ctx, input) {
  const scope = input && input.scope === 'mine' ? 'mine' : 'all';
  const { items, summary } = computeWorklist(ctx.orgId, ctx.user.id, scope);
  const slim = items.slice(0, 30).map((i) => ({
    type: i.type, title: i.title, subtitle: i.subtitle, reason: i.reason,
    amount: i.amount, due: i.due || null, claim_id: i.claim_id, appeal_id: i.appeal_id || null,
  }));
  return {
    output: { scope, summary, items: slim },
    event: { tool: 'get_worklist', label: `Checked ${scope === 'mine' ? 'my ' : ''}worklist · ${summary.total} items · $${summary.totalAtStake} at stake` },
  };
}

function getClaim(ctx, input) {
  const claim = resolveClaim(ctx.orgId, input || {});
  if (!claim) {
    return {
      output: { error: 'Claim not found in this workspace. Use get_worklist to find the claim first, or ask for the exact claim number.' },
      isError: true,
      event: { tool: 'get_claim', label: 'Read claim — not found' },
    };
  }
  const filing = db.prepare(`
    SELECT ${FILING_SELECT} FROM claims c ${FILING_JOIN} WHERE c.id = ? AND c.org_id = ?
  `).get(claim.id, ctx.orgId);
  const appeals = db.prepare(`
    SELECT a.id, a.status, a.priority, a.follow_up_date, a.created_at, u.name AS assignee_name
    FROM appeals a LEFT JOIN users u ON u.id = a.assigned_to
    WHERE a.claim_id = ? AND a.org_id = ? ORDER BY a.id DESC
  `).all(claim.id, ctx.orgId);
  const activity = db.prepare(`
    SELECT ca.action, ca.detail, ca.created_at, u.name AS user_name
    FROM claim_activity ca LEFT JOIN users u ON u.id = ca.user_id
    WHERE ca.claim_id = ? AND ca.org_id = ? ORDER BY ca.created_at DESC LIMIT 10
  `).all(claim.id, ctx.orgId);
  return {
    output: {
      claim_id: claim.id,
      claim_number: claim.claim_number,
      patient_name: claim.patient_name,
      payer: claim.payer,
      status: claim.status,
      service_date: claim.service_date,
      billed_amount: claim.billed_amount,
      paid_amount: claim.paid_amount,
      at_stake: Math.round((claim.billed_amount - claim.paid_amount) * 100) / 100,
      denial_reason: claim.denial_reason || null,
      cpt_codes: claim.cpt_codes || null,
      icd_codes: claim.icd_codes || null,
      days_in_ar: claim.days_in_ar,
      filing_deadline: filing ? filing.filing_deadline : null,
      days_until_filing: filing ? filing.days_until_filing : null,
      filing_days: filing ? filing.filing_days : null,
      appeals,
      recent_activity: activity,
    },
    event: { tool: 'get_claim', label: `Read claim ${claim.claim_number}` },
  };
}

function payerRules(ctx, input) {
  let payer = null;
  if (input && Number.isInteger(input.payer_id)) {
    payer = db.prepare('SELECT id, name, type FROM payers WHERE id = ? AND org_id = ?').get(input.payer_id, ctx.orgId);
  }
  if (!payer && input && typeof input.payer === 'string' && input.payer.trim()) {
    payer = db.prepare('SELECT id, name, type FROM payers WHERE name = ? COLLATE NOCASE AND org_id = ?')
      .get(input.payer.trim(), ctx.orgId)
      || db.prepare('SELECT id, name, type FROM payers WHERE name LIKE ? AND org_id = ? ORDER BY name LIMIT 1')
        .get(`%${input.payer.trim()}%`, ctx.orgId);
  }
  if (!payer) {
    return {
      output: { error: `No payer matching '${(input && input.payer) || ''}' in this workspace.` },
      isError: true,
      event: { tool: 'payer_rules', label: 'Checked payer rules — payer not found' },
    };
  }
  const rule = db.prepare('SELECT filing_days, notes FROM payer_filing_rules WHERE org_id = ? AND payer_id = ?')
    .get(ctx.orgId, payer.id);
  const playbook = db.prepare(`
    SELECT title, category, content FROM payer_playbook
    WHERE org_id = ? AND (payer_id = ? OR payer_id IS NULL)
    ORDER BY CASE category WHEN 'appeals' THEN 0 WHEN 'billing' THEN 1 ELSE 2 END, updated_at DESC
    LIMIT 5
  `).all(ctx.orgId, payer.id).map((e) => ({ ...e, content: String(e.content || '').slice(0, 600) }));
  const counts = db.prepare(`
    SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END), 0) AS denied
    FROM claims WHERE org_id = ? AND payer_id = ?
  `).get(ctx.orgId, payer.id);
  const topReasons = db.prepare(`
    SELECT denial_reason, COUNT(*) AS n FROM claims
    WHERE org_id = ? AND payer_id = ? AND status = 'denied' AND denial_reason IS NOT NULL AND denial_reason != ''
    GROUP BY denial_reason ORDER BY n DESC LIMIT 3
  `).all(ctx.orgId, payer.id);
  return {
    output: {
      payer: payer.name,
      payer_type: payer.type,
      filing_days: rule ? rule.filing_days : 365,
      filing_rule_is_default: !rule,
      filing_notes: rule ? rule.notes : null,
      claims_total: counts.total,
      claims_denied: counts.denied,
      denial_rate_pct: counts.total ? Math.round((counts.denied / counts.total) * 1000) / 10 : 0,
      top_denial_reasons: topReasons,
      playbook,
    },
    event: { tool: 'payer_rules', label: `Checked ${payer.name} rules · ${rule ? rule.filing_days : 365}-day filing limit` },
  };
}

function draftAppeal(ctx, input) {
  const claim = resolveClaim(ctx.orgId, input || {});
  if (!claim) {
    return {
      output: { error: 'Claim not found in this workspace — nothing was drafted.' },
      isError: true,
      event: { tool: 'draft_appeal', label: 'Draft appeal — claim not found' },
    };
  }
  if (claim.status !== 'denied') {
    return {
      output: { error: `Claim ${claim.claim_number} is '${claim.status}', not denied. Appeals can only be drafted for denied claims — nothing was drafted.` },
      isError: true,
      event: { tool: 'draft_appeal', label: `Draft appeal · ${claim.claim_number} — not a denial` },
    };
  }
  // Reuse the existing letter engine end-to-end (org templates, signature,
  // categories) exactly as GET /api/appeals/:id/letter does.
  const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(ctx.orgId);
  const existing = db.prepare(`
    SELECT a.*, u.name AS assignee_name, u.email AS assignee_email
    FROM appeals a LEFT JOIN users u ON u.id = a.assigned_to
    WHERE a.claim_id = ? AND a.org_id = ? ORDER BY a.id ASC LIMIT 1
  `).get(claim.id, ctx.orgId);
  const appealForLetter = existing || { assignee_name: ctx.user.name, assignee_email: ctx.user.email };
  const auth = db.prepare(`
    SELECT * FROM auth_requests WHERE linked_claim_id = ? AND org_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(claim.id, ctx.orgId);
  const letter = generateLetter({ claim, appeal: appealForLetter, org, auth });

  const action = createAction({
    orgId: ctx.orgId,
    userId: ctx.user.id,
    convoId: ctx.convoId,
    kind: 'draft_appeal',
    payload: {
      claim_id: claim.id,
      claim_number: claim.claim_number,
      payer: claim.payer,
      category: letter.category,
      subject: letter.subject,
      letter: letter.text,
    },
    preview: letter.text,
  });
  return {
    output: {
      action_id: action.id,
      claim_number: claim.claim_number,
      category: letter.category_label || letter.category,
      status: 'pending',
      note: 'The draft appeal letter is now shown to the user as an approval card. NOTHING has been saved to the claim. It is saved as a draft appeal only if the user approves; it is never submitted to the payer by the system.',
    },
    event: { tool: 'draft_appeal', label: `Drafted appeal · ${claim.claim_number} — awaiting approval` },
    action: serializeAction(action),
  };
}

// ---- Handbook search (AI service /api/v1/kb-search) ----
// Same service-JWT pattern as the code-assist integration (coding/lib).
// ANY failure — AI service down, bad response, timeout — degrades to a
// graceful "handbook unavailable" tool result the model can relay; it
// never throws the turn. Chunks carry their source filename so the model
// can cite the handbook section it used.
async function searchHandbook(ctx, input) {
  const query = String((input && input.query) || '').trim();
  const label = 'Searched the Payer Policy Handbook';
  if (!query) {
    return { output: { error: 'query_required', note: 'search_handbook needs a query string.' }, isError: true, event: { tool: 'search_handbook', label } };
  }
  try {
    const res = await fetch(`${AI_SERVICE_URL}/api/v1/kb-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-token': serviceToken(ctx.orgId) },
      body: JSON.stringify({ query, limit: 5 }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`kb-search responded ${res.status}`);
    const data = await res.json();
    const chunks = (Array.isArray(data && data.chunks) ? data.chunks : [])
      .map((c) => ({ text: String(c.text || '').slice(0, 1500), source: c.source || 'Payer Policy Handbook', score: c.score }))
      .filter((c) => c.text);
    if (chunks.length === 0) {
      return {
        output: { found: false, query, note: 'The Payer Policy Handbook has nothing on that. Tell the user plainly that the handbook does not cover it — do not fill the gap from memory.' },
        event: { tool: 'search_handbook', label: `${label} · no match` },
      };
    }
    return {
      output: {
        found: true,
        query,
        chunks,
        note: 'Answer from these excerpts and cite the source name(s) (the "source" field) in your reply.',
      },
      event: { tool: 'search_handbook', label },
    };
  } catch (e) {
    return {
      output: {
        available: false,
        query,
        note: `The Payer Policy Handbook is unavailable right now (${e.message}). Tell the user plainly that the handbook could not be reached, and do not reconstruct payer policy from memory.`,
      },
      event: { tool: 'search_handbook', label: `${label} · unavailable` },
    };
  }
}

const EXECUTORS = {
  get_worklist: getWorklist,
  get_claim: getClaim,
  payer_rules: payerRules,
  search_handbook: searchHandbook,
  draft_appeal: draftAppeal,
};

function createExecutor(ctx) {
  return async (name, input) => {
    const fn = EXECUTORS[name];
    if (!fn) {
      return { output: { error: `Unknown tool '${name}'` }, isError: true, event: { tool: name, label: `Unknown tool ${name}` } };
    }
    try {
      return fn(ctx, input || {});
    } catch (e) {
      return {
        output: { error: `Tool ${name} failed: ${e.message}` },
        isError: true,
        event: { tool: name, label: `${name} failed` },
      };
    }
  };
}

module.exports = { TOOL_DEFS, createExecutor };
