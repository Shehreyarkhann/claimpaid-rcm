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
const { generateLetter, CATEGORY_LABELS } = require('../appealLetters');
const predict = require('./predict');
const { AI_SERVICE_URL, serviceToken, callCodeAssist, sanitizeSuggestions, assessJob } = require('../coding/lib');
const { scrubClaim: runScrub } = require('../scrub');
const eligibilityRoute = require('../routes/eligibility');
const { listExceptions, buildResolveAction } = require('./eraResolve');
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
    description: 'PROPOSE an appeal letter for a DENIED claim. This creates a pending approval card for the user with the full letter — it does NOT save anything to the claim and never submits or files anything. Only the user can approve it. Use only when the user asks to draft/write an appeal. When this workspace\'s decided appeals support a historically best-performing angle for the payer + denial reason, the tool picks it and returns the stat — state it in your reply exactly as given.',
    input_schema: {
      type: 'object',
      properties: {
        claim_id: { type: 'integer', description: 'Internal claim id, if known.' },
        claim_number: { type: 'string', description: 'Payer-facing claim number.' },
      },
    },
  },
  {
    name: 'check_eligibility',
    description: "Run a REAL eligibility check for a claim's patient/payer through the workspace's configured vendor (the same check the Eligibility tab runs; it is stored in Eligibility history). Returns coverage status, plan details, and any payer AAA rejection in plain terms. The result states its vendor MODE — a test-mode result is NOT a live payer answer and must be relayed as such.",
    input_schema: {
      type: 'object',
      properties: {
        claim_id: { type: 'integer', description: 'Internal claim id, if known.' },
        claim_number: { type: 'string', description: 'Payer-facing claim number.' },
      },
    },
  },
  {
    name: 'scrub_claim',
    description: 'Run the deterministic pre-bill scrubber on a claim. Returns the readiness score and every finding grouped by severity (errors, then warnings) with the fix for each. Read-only — it changes nothing.',
    input_schema: {
      type: 'object',
      properties: {
        claim_id: { type: 'integer', description: 'Internal claim id, if known.' },
        claim_number: { type: 'string', description: 'Payer-facing claim number.' },
      },
    },
  },
  {
    name: 'suggest_codes',
    description: "Run the quote-verified coding engine on a claim's documentation and report its verdicts EXACTLY (Valid / Review / Abstain) — never soften an abstention. When Valid codes exist, this also creates a pending apply_codes approval card carrying ONLY the Valid codes; nothing is applied to the claim unless the user approves it. Documentation comes from the note passed here, the EHR encounter that created the claim, or the claim's last coding run.",
    input_schema: {
      type: 'object',
      properties: {
        claim_id: { type: 'integer', description: 'Internal claim id, if known.' },
        claim_number: { type: 'string', description: 'Payer-facing claim number.' },
        note: { type: 'string', description: 'Clinical documentation to code from, if the user pasted it. Optional.' },
      },
    },
  },
  {
    name: 'era_exceptions',
    description: 'List the current ERA exceptions (pending remittance lines that did not auto-post) with claim, payer, amounts, the remittance CAS adjustments, and a deterministic recommended disposition for each, with the arithmetic shown.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'resolve_exception',
    description: 'PROPOSE resolving one ERA exception with its recommended disposition. This creates a pending approval card — nothing posts, moves, or is ignored unless the user approves it. Get the era_line_id from era_exceptions first. Use only when the user asks to resolve an exception.',
    input_schema: {
      type: 'object',
      properties: {
        era_line_id: { type: 'integer', description: 'ERA claim line id from era_exceptions.' },
      },
      required: ['era_line_id'],
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

  // Winning-argument learning (Phase 4, WS1): when this payer + denial
  // reason pair has decided history and one angle's own record clears the
  // sample threshold, argue THAT angle — deterministically chosen here,
  // from this org's own outcomes; the model only narrates the stat.
  // Below threshold there is no guidance and no claim.
  const learned = predict.bestAngle(ctx.orgId, claim.payer_id, claim.denial_reason || null);
  const letter = generateLetter({
    claim, appeal: appealForLetter, org, auth,
    ...(learned ? { category: learned.angle } : {}),
  });
  const angleLabel = CATEGORY_LABELS[letter.category] || letter.category;
  const angleStat = learned
    ? `Angle: ${angleLabel} — overturns ${Math.round(learned.value * 100)}% here (n=${learned.sampleSize}).`
    : null;

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
      angle_source: learned ? 'learned' : 'default',
      angle_stat: learned ? { value: learned.value, sampleSize: learned.sampleSize } : null,
    },
    // The learned-angle stat rides at the top of the card preview so the
    // approver sees WHY this angle was chosen; the letter itself is the
    // payload the executor saves.
    preview: angleStat ? `${angleStat}\n\n${letter.text}` : letter.text,
  });
  // Deploy #101: when the owner's auto-approve policy fired inside
  // createAction, the action is already executed — the tool output must
  // say so, never "awaiting approval" for a draft that already saved.
  const autoSaved = action.status === 'executed' && action.auto_approved === 1;
  return {
    output: {
      action_id: action.id,
      claim_number: claim.claim_number,
      category: letter.category_label || letter.category,
      angle: learned
        ? { category: letter.category, label: angleLabel, source: 'learned', overturn_rate: learned.value, sample_size: learned.sampleSize, statement: angleStat }
        : { category: letter.category, label: angleLabel, source: 'default' },
      status: autoSaved ? 'auto_approved' : 'pending',
      note: autoSaved
        ? `The workspace's auto-approval policy approved this draft immediately — it is ALREADY saved to the claim as a draft appeal (never submitted to the payer). It appears in the Auto-approved review stream, where it can still be voided. ${learned ? `The letter argues the ${angleLabel} angle: "${angleStat}"` : ''}`
        : learned
          ? `The draft appeal letter is now shown to the user as an approval card. NOTHING has been saved to the claim. The letter argues the ${angleLabel} angle because this workspace's own decided appeals support it — state this in your reply exactly: "${angleStat}" It is saved as a draft appeal only if the user approves; it is never submitted to the payer by the system.`
          : 'The draft appeal letter is now shown to the user as an approval card. NOTHING has been saved to the claim. It is saved as a draft appeal only if the user approves; it is never submitted to the payer by the system.',
    },
    event: { tool: 'draft_appeal', label: autoSaved ? `Drafted appeal · ${claim.claim_number} — auto-approved by policy` : `Drafted appeal · ${claim.claim_number} — awaiting approval` },
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

// ---- Eligibility (Phase 3, WS1) ----
// Runs the EXISTING vendor layer through the eligibility route module's
// shared runner, so the check is stored in eligibility_lookups exactly
// like a check run from the Eligibility tab. The vendor MODE (test vs
// live) is surfaced in both the output and the chip — a test-mode result
// is never presented as a live payer answer.
const AAA_GLOSS = {
  42: 'The payer could not respond right now — retry later.',
  52: 'The service date falls outside the provider\'s plan enrollment.',
  58: 'The date of birth sent was invalid or missing.',
  67: 'The payer has no patient matching what was sent.',
  71: 'The date of birth does not match the payer\'s records for this patient.',
  72: 'The member/subscriber ID sent was invalid or missing.',
  75: 'The subscriber is not in the group/plan identified.',
  76: 'The subscriber ID matches more than one record at the payer.',
  77: 'The subscriber was found, but the patient was not.',
  78: 'The subscriber/insured is not in the payer\'s database.',
};

async function checkEligibility(ctx, input) {
  const claim = resolveClaim(ctx.orgId, input || {});
  const baseLabel = 'Checked eligibility';
  if (!claim) {
    return {
      output: { error: 'Claim not found in this workspace. Use get_worklist to find the claim first, or ask for the exact claim number.' },
      isError: true,
      event: { tool: 'check_eligibility', label: `${baseLabel} — claim not found` },
    };
  }
  const label = `${baseLabel} · ${claim.claim_number}`;
  const parts = String(claim.patient_name || '').trim().split(/\s+/).filter(Boolean);
  const missing = [];
  if (!claim.patient_dob) missing.push('patient date of birth');
  if (!claim.member_id) missing.push('member ID');
  if (!claim.payer) missing.push('payer');
  if (parts.length < 2) missing.push('patient first and last name');
  if (missing.length) {
    return {
      output: { error: `Claim ${claim.claim_number} is missing ${missing.join(', ')} — add it to the claim before an eligibility check can run. Nothing was checked.` },
      isError: true,
      event: { tool: 'check_eligibility', label: `${label} — missing identifiers` },
    };
  }
  try {
    const { lookup, result, cfg } = await eligibilityRoute.runOrgEligibilityCheck(ctx.orgId, ctx.user.id, {
      patient_first: parts[0],
      patient_last: parts.slice(1).join(' '),
      dob: claim.patient_dob,
      member_id: claim.member_id,
      payer: claim.payer,
      date_of_service: claim.service_date,
    });
    const mode = eligibilityRoute.eligibilityMode(cfg, result);
    const aaa = ((result.raw_response && result.raw_response.aaa_errors) || []).map((e) => ({
      code: e.code,
      description: e.description || null,
      plain_terms: AAA_GLOSS[String(e.code)] || e.description || 'The payer rejected the inquiry — see the description.',
      followup_action: e.followup_action || null,
    }));
    return {
      output: {
        claim_id: claim.id,
        claim_number: claim.claim_number,
        lookup_id: lookup.id,
        vendor: cfg.vendor,
        mode,
        coverage_active: !!result.coverage_active,
        plan_name: result.plan_name || null,
        plan_type: result.plan_type || null,
        group_number: result.group_number || null,
        copay_primary: result.copay_primary ?? null,
        copay_specialist: result.copay_specialist ?? null,
        deductible_individual: result.deductible_individual ?? null,
        deductible_remaining: result.deductible_remaining ?? null,
        oop_max: result.oop_max ?? null,
        effective_date: result.effective_date || null,
        term_date: result.term_date || null,
        aaa_errors: aaa,
        note: mode === 'live'
          ? 'Live payer response via the configured vendor. The check is stored in Eligibility history.'
          : `This check ran in ${mode.toUpperCase()} mode — it is NOT a live payer answer. You must tell the user it was a ${mode}-mode check.`,
      },
      event: {
        tool: 'check_eligibility',
        label: `${label} · ${result.coverage_active ? 'coverage active' : 'coverage not active'}${mode !== 'live' ? ` · ${mode} mode` : ''}`,
      },
    };
  } catch (e) {
    return {
      output: { error: `Eligibility check could not run for claim ${claim.claim_number}: ${e.message}` },
      isError: true,
      event: { tool: 'check_eligibility', label: `${label} — could not run` },
    };
  }
}

// ---- Scrub (Phase 3, WS1): the existing deterministic scrubber, verbatim ----
function scrubClaimTool(ctx, input) {
  const claim = resolveClaim(ctx.orgId, input || {});
  if (!claim) {
    return {
      output: { error: 'Claim not found in this workspace — nothing was scrubbed.' },
      isError: true,
      event: { tool: 'scrub_claim', label: 'Scrubbed claim — not found' },
    };
  }
  const result = runScrub(claim);
  const group = (sev) => result.issues
    .filter((i) => i.severity === sev)
    .map((i) => ({ rule: i.rule, name: i.name, fix: i.message }));
  return {
    output: {
      claim_id: claim.id,
      claim_number: claim.claim_number,
      status: result.status,
      score: result.score,
      band: result.band,
      band_label: result.band_label,
      errors: group('error'),
      warnings: group('warning'),
      note: 'Findings are the deterministic scrubber\'s, exactly as the Scrub tab reports them. Each finding\'s "fix" is what to correct.',
    },
    event: { tool: 'scrub_claim', label: `Scrubbed claim · ${claim.claim_number} · score ${result.score} · ${result.errors} errors, ${result.warnings} warnings` },
  };
}

// ---- Coding (Phase 3, WS1): the quote-verified engine, verdicts verbatim ----
function buildEncounterNote(enc) {
  const parseCodes = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
  const cpts = parseCodes(enc.cpt_codes);
  const icds = parseCodes(enc.icd_codes);
  const lines = [
    `Patient: ${enc.patient_first || ''} ${enc.patient_last || ''}`.trim(),
    enc.patient_dob ? `DOB: ${enc.patient_dob}` : null,
    enc.date_of_service ? `Date of service: ${enc.date_of_service}` : null,
    enc.payer_name ? `Payer: ${enc.payer_name}` : null,
    enc.rendering_provider ? `Rendering provider: ${enc.rendering_provider}` : null,
    cpts.length ? `EHR procedure codes: ${cpts.join(', ')}` : null,
    icds.length ? `EHR diagnosis codes: ${icds.join(', ')}` : null,
  ].filter(Boolean);
  let raw = '';
  try {
    const payload = typeof enc.raw_payload === 'string' ? JSON.parse(enc.raw_payload) : enc.raw_payload;
    raw = JSON.stringify(payload, null, 1).slice(0, 4000);
  } catch { raw = String(enc.raw_payload || '').slice(0, 4000); }
  if (raw) lines.push(`EHR encounter detail:\n${raw}`);
  return lines.join('\n');
}

function codesPreview(claim, assessed, validCodes) {
  const lines = [
    `Code suggestions for claim ${claim.claim_number} — verdicts from the quote-verified coding engine:`,
    '',
    ...assessed.suggestions.map((s) => `• ${s.code} (${s.type}) — ${s.status === 'valid' ? 'Valid' : 'Review'}${s.evidence_verified ? ' · quote verified in the documentation' : ' · quote NOT verified'} — ${s.rationale || 'no rationale given'}`),
    '',
    validCodes.length
      ? `Approving applies ONLY the Valid code(s) to the claim: ${validCodes.map((c) => c.code).join(', ')}. Review-status codes are never applied. Rejecting changes nothing.`
      : 'No Valid codes in this run — nothing will be applied.',
  ];
  return lines.join('\n');
}

// Shared by the suggest_codes tool and POST /api/agent/actions/propose:
// builds the pending apply_codes action from an assessed run. Only Valid
// codes enter the payload — that is the set approval applies.
function buildApplyCodesAction({ orgId, userId, convoId, claim, jobId, assessed }) {
  const valid = assessed.suggestions.filter((s) => s.status === 'valid');
  if (!valid.length) return null;
  const codes = valid.map((s) => ({ code: s.code, type: s.type, final_code: null }));
  const row = createAction({
    orgId, userId, convoId: convoId || null,
    kind: 'apply_codes',
    payload: {
      claim_id: claim.id,
      claim_number: claim.claim_number,
      payer: claim.payer || null,
      job_id: jobId || null,
      codes,
      assessment: assessed.assessment,
    },
    preview: codesPreview(claim, assessed, codes),
  });
  return row;
}

async function suggestCodes(ctx, input) {
  const claim = resolveClaim(ctx.orgId, input || {});
  const baseLabel = 'Suggested codes';
  if (!claim) {
    return {
      output: { error: 'Claim not found in this workspace — no codes were suggested.' },
      isError: true,
      event: { tool: 'suggest_codes', label: `${baseLabel} — claim not found` },
    };
  }
  let note = typeof (input && input.note) === 'string' ? input.note.trim() : '';
  let noteSource = note ? 'documentation provided in this conversation' : null;
  let encounterId = null;
  if (!note) {
    const enc = db.prepare('SELECT * FROM ehr_encounters WHERE org_id = ? AND converted_claim_id = ? ORDER BY id DESC LIMIT 1')
      .get(ctx.orgId, claim.id);
    if (enc) { note = buildEncounterNote(enc); noteSource = 'the EHR encounter that created this claim'; encounterId = enc.id; }
  }
  if (!note) {
    const prior = db.prepare("SELECT note_text FROM coding_jobs WHERE org_id = ? AND claim_id = ? AND status = 'complete' ORDER BY id DESC LIMIT 1")
      .get(ctx.orgId, claim.id);
    if (prior && prior.note_text) { note = prior.note_text; noteSource = 'the note from the last coding run on this claim'; }
  }
  if (!note || note.length < 50) {
    return {
      output: { error: `No usable documentation for claim ${claim.claim_number} (an encounter note, a prior coding note, or a note pasted here — at least 50 characters). Ask the user to paste the visit note, then run this again with it. No codes were suggested.` },
      isError: true,
      event: { tool: 'suggest_codes', label: `${baseLabel} · ${claim.claim_number} — no documentation` },
    };
  }
  let out;
  try {
    out = await callCodeAssist(ctx.orgId, note);
  } catch (e) {
    return {
      output: { error: `The coding engine could not run for claim ${claim.claim_number}: ${e.message}` },
      isError: true,
      event: { tool: 'suggest_codes', label: `${baseLabel} · ${claim.claim_number} — engine unavailable` },
    };
  }
  const sanitized = sanitizeSuggestions(out.suggestions);
  const assessed = assessJob(note, sanitized);
  // Record the run in the same substrate as Coding-panel runs.
  const jobId = Number(db.prepare(`
    INSERT INTO coding_jobs (org_id, claim_id, encounter_id, note_text, created_by, status, result_json)
    VALUES (?, ?, ?, ?, ?, 'complete', ?)
  `).run(ctx.orgId, claim.id, encounterId, note, ctx.user.id,
    JSON.stringify({ suggestions: sanitized, model: out.model || null })).lastInsertRowid);

  let action = null;
  const actionRow = buildApplyCodesAction({ orgId: ctx.orgId, userId: ctx.user.id, convoId: ctx.convoId, claim, jobId, assessed });
  if (actionRow) action = serializeAction(actionRow);

  return {
    output: {
      claim_id: claim.id,
      claim_number: claim.claim_number,
      job_id: jobId,
      note_source: noteSource,
      assessment: assessed.assessment,
      summary: assessed.summary,
      suggestions: assessed.suggestions.map((s) => ({
        code: s.code, type: s.type, status: s.status, confidence: s.confidence,
        evidence_verified: s.evidence_verified, rationale: s.rationale,
      })),
      action_id: action ? action.id : null,
      note: assessed.assessment === 'abstain'
        ? 'The coding engine ABSTAINED: no code in the library is supported by the documentation\'s own words. Report the abstention as-is — do not suggest codes yourself.'
        : 'Verdicts are the quote-verified engine\'s, exactly as produced. Only Valid codes are on the approval card; nothing is applied unless the user approves.',
    },
    event: { tool: 'suggest_codes', label: `${baseLabel} · ${claim.claim_number} · ${assessed.assessment}${action ? ' — awaiting approval' : ''}` },
    action,
  };
}

// ---- ERA exceptions (Phase 3, WS2) ----
function eraExceptions(ctx) {
  const exceptions = listExceptions(ctx.orgId, 25);
  return {
    output: {
      count: exceptions.length,
      exceptions,
      note: 'Dispositions are computed deterministically from each remittance\'s CAS adjustments — the math is in each recommendation\'s arithmetic. Resolving one requires the user to approve a resolve_exception proposal.',
    },
    event: { tool: 'era_exceptions', label: `Listed ERA exceptions · ${exceptions.length} open` },
  };
}

async function resolveExceptionTool(ctx, input) {
  const lineId = input && Number.isInteger(input.era_line_id) ? input.era_line_id : null;
  if (!lineId) {
    return {
      output: { error: 'era_line_id is required — list exceptions with era_exceptions first.' },
      isError: true,
      event: { tool: 'resolve_exception', label: 'Resolve exception — no line given' },
    };
  }
  try {
    const row = buildResolveAction({ orgId: ctx.orgId, userId: ctx.user.id, convoId: ctx.convoId, lineId });
    const action = serializeAction(row);
    const p = JSON.parse(row.payload || '{}');
    return {
      output: {
        action_id: row.id,
        era_line_id: lineId,
        disposition: p.disposition,
        status: 'pending',
        note: 'The proposed resolution is now shown to the user as an approval card. NOTHING has posted or been ignored. It applies only if the user approves.',
      },
      event: { tool: 'resolve_exception', label: `Proposed ERA resolution · ${p.disposition} — awaiting approval` },
      action,
    };
  } catch (e) {
    return {
      output: { error: `Could not propose that resolution: ${e.message}` },
      isError: true,
      event: { tool: 'resolve_exception', label: 'Resolve exception — could not propose' },
    };
  }
}

const EXECUTORS = {
  get_worklist: getWorklist,
  get_claim: getClaim,
  payer_rules: payerRules,
  search_handbook: searchHandbook,
  draft_appeal: draftAppeal,
  check_eligibility: checkEligibility,
  scrub_claim: scrubClaimTool,
  suggest_codes: suggestCodes,
  era_exceptions: eraExceptions,
  resolve_exception: resolveExceptionTool,
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

module.exports = { TOOL_DEFS, createExecutor, resolveClaim, buildApplyCodesAction, draftAppealTool: draftAppeal };
