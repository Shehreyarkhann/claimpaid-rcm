'use strict';
// Document intake (agent Phase 5, WS1) — paper EOBs and payer denial
// letters become structured, REVIEWABLE proposals. Nothing here writes
// to claims or remittances: extraction produces a validated record, a
// person reviews it (fixing claim matches by hand), and applying happens
// only through an approved apply_intake agent action — which creates a
// HELD remittance in the existing ERA model or attaches the denial to
// the matched claim and proposes an appeal draft.
//
// Honesty rules, enforced in code (not just the prompt):
//   * The model transcribes; it never invents. A field the document did
//     not yield stays null and is flagged in `problems`.
//   * All arithmetic (line balances, totals) is recomputed HERE from the
//     transcribed numbers — the model's own sums are never trusted.
//   * Claim matching is deterministic (exact claim_number in this org);
//     anything else is a suggestion the reviewer must confirm.
// Extraction rides the agent model client (model.extractDocument): on
// the Anthropic transport the file travels as a base64 document/image
// content block, exactly the Messages API shape. Tests inject the fake
// transport through the same AGENT_TRANSPORT_MODULE seam as chat.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('../db');
const model = require('./model');
const { createAction } = require('./actions');
const { recomputeRemittance, round2, VARIANCE_TOLERANCE } = require('../eraPosting');
const { logActivity } = require('../activity');
const { REASON_TEXT, GROUP_TEXT } = require('../edi/parse835');

// Files live OUTSIDE the public /uploads static root on purpose: these
// are PHI documents. The storage pattern mirrors the org-logo upload
// (multer memory buffer -> fs write into a purpose directory + a DB row
// pointing at it); the per-org subdirectory plus the org-checked file
// endpoint are what make reads owner-only.
const DOCS_ROOT = path.join(__dirname, '..', 'agent-documents');
const BALANCE_TOLERANCE = 0.05;

function orgDir(orgId) {
  const dir = path.join(DOCS_ROOT, String(orgId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function documentPath(doc) {
  return path.join(DOCS_ROOT, String(doc.org_id), doc.stored_name);
}

// Magic-byte sniffing — the client-supplied mimetype is never trusted.
function detectMediaType(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  return null;
}

const EXT_BY_MEDIA = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg' };

// ---------- Extraction prompt (strict JSON, transcribe-only) ----------

const EXTRACTION_SYSTEM = 'You extract structured data from healthcare billing documents. You output only JSON. Accuracy over completeness: a field the document does not show is null, never a guess.';

const EXTRACTION_INSTRUCTION = `The attached file is either a payer remittance advice / explanation of benefits (EOB) or a payer denial letter. Transcribe ONLY what the document actually shows. Never estimate, infer, or invent a value: if a field is not shown, return null for it. Return a single JSON object and nothing else — no prose, no markdown fences.

Shape:
{
  "kind": "remittance" | "denial_letter" | "unknown",
  "remittance": null | {
    "payer": string|null, "check_number": string|null, "pay_date": "YYYY-MM-DD"|null, "payment_amount": number|null,
    "lines": [ { "claim_number": string|null, "patient": string|null, "service_date": "YYYY-MM-DD"|null,
      "billed": number|null, "paid": number|null,
      "adjustments": [ { "group": string, "reason": string, "amount": number } ],
      "patient_resp": number|null } ]
  },
  "denial_letter": null | {
    "payer": string|null, "claim_number": string|null, "patient": string|null,
    "denial_reasons": [string], "appeal_deadline": "YYYY-MM-DD"|null, "appeal_address": string|null
  }
}

Rules:
- Amounts are plain numbers (no $ or commas). Dates are YYYY-MM-DD (convert from the document's format).
- For remittances, one line per claim on the document. adjustment "group" is the CAS group code printed on the document (CO, PR, OA, PI); "reason" is the reason CODE printed (e.g. "45", "97", "B15") — if the document prints only text, put the short text instead. If the document shows no adjustment group, use "OA".
- patient_resp is the patient-responsibility amount for that line if the document states one, else null.
- For denial letters, denial_reasons quotes the payer's stated reason(s), including any reason codes exactly as printed.
- kind is "unknown" (with both objects null) when the document is neither a remittance/EOB nor a denial letter.`;

// ---------- Defensive parsing + normalization ----------

function parseExtractionText(text) {
  let s = String(text || '').trim();
  if (!s) return null;
  // Strip markdown fences the model may add despite instructions.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  // Fall back to the outermost JSON object if prose surrounds it.
  if (!s.startsWith('{')) {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a === -1 || b <= a) return null;
    s = s.slice(a, b + 1);
  }
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? round2(v) : null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? round2(n) : null;
}

function str(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function dateStr(v) {
  const s = str(v);
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function findClaimByNumber(orgId, claimNumber) {
  if (!claimNumber) return null;
  return db.prepare('SELECT id, claim_number, patient_name, billed_amount FROM claims WHERE org_id = ? AND claim_number = ? COLLATE NOCASE')
    .get(orgId, claimNumber) || null;
}

// Suggestion only (mirrors the ERA inbox's findSuggestion): same billed
// amount on an open claim + a corroborating signal (patient last name or
// exact service date). Never treated as a match.
function suggestClaim(orgId, { billed, patient, serviceDate }) {
  if (billed == null) return null;
  const rows = db.prepare(`
    SELECT id, claim_number FROM claims WHERE org_id = ? AND billed_amount = ? AND status != 'paid'
    ORDER BY created_at DESC LIMIT 10
  `).all(orgId, billed);
  const lastName = (patient || '').trim().split(/\s+/).pop()?.toLowerCase();
  for (const c of rows) {
    const full = db.prepare('SELECT patient_name, service_date FROM claims WHERE id = ?').get(c.id);
    const nameHit = lastName && full && full.patient_name.toLowerCase().includes(lastName);
    const dateHit = serviceDate && full && full.service_date === serviceDate;
    if (nameHit || dateHit) return c.id;
  }
  return null;
}

function normalizeAdjustment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const amount = num(raw.amount);
  if (amount == null) return null;
  const group = (str(raw.group) || 'OA').toUpperCase().slice(0, 4);
  const reason = str(raw.reason) || str(raw.code) || '';
  const looksLikeCode = /^[A-Za-z]{0,2}-?\d{1,3}[A-Za-z]?$/.test(reason);
  return {
    group,
    code: looksLikeCode ? reason.toUpperCase() : null,
    text: looksLikeCode ? (REASON_TEXT[reason.toUpperCase()] || reason) : (reason || 'Adjustment'),
    amount,
  };
}

function normalizeRemittance(orgId, raw) {
  const lines = (Array.isArray(raw && raw.lines) ? raw.lines : []).map((l, i) => {
    const src = l && typeof l === 'object' ? l : {};
    const line = {
      claim_number: str(src.claim_number),
      patient: str(src.patient),
      service_date: dateStr(src.service_date),
      billed: num(src.billed),
      paid: num(src.paid),
      adjustments: (Array.isArray(src.adjustments) ? src.adjustments : []).map(normalizeAdjustment).filter(Boolean),
      patient_resp: num(src.patient_resp),
      matched_claim_id: null,
      suggested_claim_id: null,
      match_method: null,
    };
    const claim = findClaimByNumber(orgId, line.claim_number);
    if (claim) {
      line.matched_claim_id = claim.id;
      line.match_method = 'control_number';
    } else {
      line.suggested_claim_id = suggestClaim(orgId, line);
    }
    return line;
  });
  return {
    payer: str(raw && raw.payer),
    check_number: str(raw && raw.check_number),
    pay_date: dateStr(raw && raw.pay_date),
    payment_amount: num(raw && raw.payment_amount),
    lines,
  };
}

function normalizeDenialLetter(orgId, raw) {
  const data = {
    payer: str(raw && raw.payer),
    claim_number: str(raw && raw.claim_number),
    patient: str(raw && raw.patient),
    denial_reasons: (Array.isArray(raw && raw.denial_reasons) ? raw.denial_reasons : []).map(str).filter(Boolean),
    appeal_deadline: dateStr(raw && raw.appeal_deadline),
    appeal_address: str(raw && raw.appeal_address),
    claim_id: null,
    suggested_claim_id: null,
  };
  const claim = findClaimByNumber(orgId, data.claim_number);
  if (claim) data.claim_id = claim.id;
  return data;
}

// ---------- Deterministic validation (the model's sums are never trusted) ----------

function lineVariance(line) {
  const adjTotal = line.adjustments.reduce((s, a) => s + a.amount, 0);
  const prAdj = line.adjustments.filter((a) => a.group === 'PR').reduce((s, a) => s + a.amount, 0);
  const unexplainedPr = Math.max(0, (line.patient_resp || 0) - prAdj);
  return round2((line.billed || 0) - (line.paid || 0) - adjTotal - unexplainedPr);
}

function validateRemittance(data) {
  const problems = [];
  if (!data.payer) problems.push('Payer not stated on the document.');
  if (!data.lines.length) {
    problems.push('No remittance lines could be read from this document.');
    return problems;
  }
  data.lines.forEach((line, i) => {
    const n = i + 1;
    if (!line.claim_number) problems.push(`Line ${n}: claim number not readable — the line cannot be matched.`);
    if (line.billed == null) problems.push(`Line ${n}: billed amount not readable.`);
    if (line.paid == null) problems.push(`Line ${n}: paid amount not readable.`);
    if (line.billed != null && line.paid != null) {
      const v = lineVariance(line);
      if (Math.abs(v) > BALANCE_TOLERANCE) {
        const adjTotal = round2(line.adjustments.reduce((s, a) => s + a.amount, 0));
        problems.push(`Line ${n}: amounts do not balance — billed $${line.billed.toFixed(2)} vs paid $${(line.paid || 0).toFixed(2)} + adjustments $${adjTotal.toFixed(2)} + patient resp $${(line.patient_resp || 0).toFixed(2)} (off by $${v.toFixed(2)}).`);
      }
    }
    if (line.claim_number && !line.matched_claim_id) {
      problems.push(`Line ${n}: no claim in this workspace matches "${line.claim_number}" — pick the right claim, or it will be held unmatched in the ERA inbox.`);
    }
  });
  if (data.payment_amount != null) {
    const paidSum = round2(data.lines.reduce((s, l) => s + (l.paid || 0), 0));
    if (Math.abs(data.payment_amount - paidSum) > BALANCE_TOLERANCE) {
      problems.push(`Document check total $${data.payment_amount.toFixed(2)} does not match the sum of line payments $${paidSum.toFixed(2)}.`);
    }
  }
  return problems;
}

function validateDenialLetter(data) {
  const problems = [];
  if (!data.payer) problems.push('Payer not stated on the letter.');
  if (!data.claim_number) problems.push('Claim number not readable — the denial cannot be attached to a claim.');
  else if (!data.claim_id) problems.push(`No claim in this workspace matches "${data.claim_number}" — pick the claim this letter belongs to.`);
  if (!data.denial_reasons.length) problems.push('No denial reason could be read from the letter.');
  if (!data.appeal_deadline) problems.push('No appeal deadline is stated on the letter — verify the deadline from the payer\u2019s filing rules before relying on one.');
  return problems;
}

function computeProblems(kind, data) {
  if (kind === 'remittance') return validateRemittance(data);
  if (kind === 'denial_letter') return validateDenialLetter(data);
  return ['The document could not be classified as a remittance/EOB or a denial letter.'];
}

// ---------- Upload + extraction ----------

async function extractAndStore({ orgId, userId, filename, mediaType, buffer }) {
  const ext = EXT_BY_MEDIA[mediaType] || '';
  const storedName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(orgDir(orgId), storedName), buffer);
  const info = db.prepare(`
    INSERT INTO agent_documents (org_id, user_id, filename, stored_name, media_type, size_bytes, kind, status)
    VALUES (?, ?, ?, ?, ?, ?, 'unknown', 'needs_review')
  `).run(orgId, userId, filename, storedName, mediaType, buffer.length);
  const docId = Number(info.lastInsertRowid);

  let usage = { inputTokens: 0, outputTokens: 0 };
  try {
    const out = await model.extractDocument({
      mediaType,
      dataBase64: buffer.toString('base64'),
      instruction: EXTRACTION_INSTRUCTION,
      system: EXTRACTION_SYSTEM,
    });
    usage = out.usage || usage;
    const parsed = parseExtractionText(out.text);
    if (!parsed) throw new Error('The model\u2019s reply could not be parsed as extraction JSON.');
    const kind = parsed.kind === 'remittance' || parsed.kind === 'denial_letter' ? parsed.kind : 'unknown';
    let data = null;
    if (kind === 'remittance') data = normalizeRemittance(orgId, parsed.remittance || {});
    if (kind === 'denial_letter') data = normalizeDenialLetter(orgId, parsed.denial_letter || {});
    const problems = kind === 'unknown'
      ? ['The document could not be classified as a remittance/EOB or a denial letter.']
      : computeProblems(kind, data);
    db.prepare(`
      UPDATE agent_documents SET kind = ?, status = ?, extracted = ?, problems = ?, updated_at = datetime('now') WHERE id = ?
    `).run(kind, problems.length ? 'needs_review' : 'extracted',
      data ? JSON.stringify(data) : null, JSON.stringify(problems), docId);
  } catch (e) {
    db.prepare(`
      UPDATE agent_documents SET status = 'extract_failed', problems = ?, updated_at = datetime('now') WHERE id = ?
    `).run(JSON.stringify([`Extraction failed: ${e.message}`]), docId);
  }
  return { doc: getDocument(docId, orgId), usage };
}

function getDocument(id, orgId) {
  return db.prepare('SELECT * FROM agent_documents WHERE id = ? AND org_id = ?').get(id, orgId) || null;
}

function parseStored(doc) {
  let extracted = null;
  let problems = [];
  try { extracted = doc.extracted ? JSON.parse(doc.extracted) : null; } catch { extracted = null; }
  try { problems = doc.problems ? JSON.parse(doc.problems) : []; } catch { problems = []; }
  return { extracted, problems };
}

function serializeDocument(doc, { detail = false } = {}) {
  if (!doc) return null;
  const { extracted, problems } = parseStored(doc);
  const out = {
    id: doc.id,
    filename: doc.filename,
    media_type: doc.media_type,
    size_bytes: doc.size_bytes,
    kind: doc.kind,
    status: doc.status,
    problems,
    action_id: doc.action_id || null,
    era_id: doc.era_id || null,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
  if (extracted && doc.kind === 'remittance') {
    out.payer = extracted.payer || null;
    out.line_count = (extracted.lines || []).length;
    out.matched_count = (extracted.lines || []).filter((l) => l.matched_claim_id).length;
  }
  if (extracted && doc.kind === 'denial_letter') {
    out.payer = extracted.payer || null;
    out.claim_number = extracted.claim_number || null;
    out.matched = !!extracted.claim_id;
  }
  if (detail) out.extracted = extracted;
  return out;
}

// ---------- Review-time match fixes ----------
// Reviewer picks (or clears) the claim for one remittance line, or for a
// denial letter as a whole. Problems recompute from the updated data —
// the same deterministic validator that ran at extraction.
function updateMatch(orgId, doc, { lineIndex, claimId }) {
  const { extracted } = parseStored(doc);
  if (!extracted) { const e = new Error('This document has no extraction to match against.'); e.status = 400; throw e; }
  let claim = null;
  if (claimId != null) {
    claim = db.prepare('SELECT id, claim_number FROM claims WHERE id = ? AND org_id = ?').get(claimId, orgId);
    if (!claim) { const e = new Error('Claim not found in this workspace.'); e.status = 404; throw e; }
  }
  if (doc.kind === 'remittance') {
    const line = (extracted.lines || [])[lineIndex];
    if (!line) { const e = new Error('Line not found on this document.'); e.status = 400; throw e; }
    line.matched_claim_id = claim ? claim.id : null;
    line.match_method = 'manual';
  } else if (doc.kind === 'denial_letter') {
    extracted.claim_id = claim ? claim.id : null;
  } else {
    const e = new Error('This document cannot be matched — it was not classified as a remittance or denial letter.');
    e.status = 400; throw e;
  }
  const problems = computeProblems(doc.kind, extracted);
  const status = doc.status === 'extracted' || doc.status === 'needs_review'
    ? (problems.length ? 'needs_review' : 'extracted') : doc.status;
  db.prepare(`
    UPDATE agent_documents SET extracted = ?, problems = ?, status = ?, updated_at = datetime('now') WHERE id = ?
  `).run(JSON.stringify(extracted), JSON.stringify(problems), status, doc.id);
  return getDocument(doc.id, orgId);
}

// ---------- The apply_intake approval action ----------

function money(n) { return `$${(Number(n) || 0).toFixed(2)}`; }

function intakePreview(doc, data) {
  if (doc.kind === 'remittance') {
    const totals = (data.lines || []).reduce((t, l) => ({
      billed: round2(t.billed + (l.billed || 0)), paid: round2(t.paid + (l.paid || 0)),
    }), { billed: 0, paid: 0 });
    const lines = [
      `Document intake — remittance${data.payer ? ` from ${data.payer}` : ''}${data.check_number ? ` · check/EFT ${data.check_number}` : ''}${data.pay_date ? ` · paid ${data.pay_date}` : ''}`,
      `File: ${doc.filename} · ${data.lines.length} line${data.lines.length === 1 ? '' : 's'} · billed ${money(totals.billed)} · paid ${money(totals.paid)}`,
      '',
      ...data.lines.map((l, i) => `• ${l.claim_number || `(line ${i + 1})`} — ${l.patient || 'patient not stated'} — billed ${money(l.billed)} · paid ${money(l.paid)} — ${l.matched_claim_id ? 'matched to a claim in this workspace' : 'NOT matched (will sit in the ERA inbox as an exception)'}`),
      '',
      'Approving creates this remittance in the ERA inbox HELD — no line posts — so the ERA tab takes it from there. Rejecting dismisses the document and creates nothing.',
    ];
    return lines.join('\n');
  }
  const reasons = (data.denial_reasons || []).join('; ') || 'no reason read';
  return [
    `Document intake — denial letter${data.payer ? ` from ${data.payer}` : ''}`,
    `File: ${doc.filename}`,
    `Claim: ${data.claim_number || 'not readable'} — ${data.patient || 'patient not stated'}${data.claim_id ? ' — matched to a claim in this workspace' : ' — NOT matched'}`,
    `Denial: ${reasons}`,
    ...(data.appeal_deadline ? [`Appeal deadline stated on the letter: ${data.appeal_deadline}`] : []),
    ...(data.appeal_address ? [`Appeals address on the letter: ${data.appeal_address}`] : []),
    '',
    'Approving records this denial on the matched claim and proposes an appeal draft for your decision. Rejecting dismisses the document and changes nothing.',
  ].join('\n');
}

function buildIntakeAction({ orgId, userId, doc }) {
  if (doc.status === 'applied') { const e = new Error('This document was already applied.'); e.status = 409; throw e; }
  if (doc.status === 'dismissed') { const e = new Error('This document was dismissed.'); e.status = 409; throw e; }
  if (doc.kind !== 'remittance' && doc.kind !== 'denial_letter') {
    const e = new Error('This document could not be classified as a remittance or denial letter — there is nothing to apply.');
    e.status = 400; throw e;
  }
  const existing = db.prepare(`
    SELECT id FROM agent_actions WHERE org_id = ? AND kind = 'apply_intake' AND status = 'pending'
      AND CAST(json_extract(payload, '$.document_id') AS INTEGER) = ?
  `).get(orgId, doc.id);
  if (existing) { const e = new Error('An apply proposal for this document is already awaiting a decision.'); e.status = 409; throw e; }
  const { extracted } = parseStored(doc);
  const action = createAction({
    orgId, userId, convoId: null,
    kind: 'apply_intake',
    payload: {
      document_id: doc.id,
      doc_kind: doc.kind,
      filename: doc.filename,
      payer: extracted ? (extracted.payer || null) : null,
    },
    preview: intakePreview(doc, extracted || {}),
  });
  db.prepare("UPDATE agent_documents SET action_id = ?, updated_at = datetime('now') WHERE id = ?").run(action.id, doc.id);
  return action;
}

// ---------- Execution (only ever runs inside an approved action) ----------

function createHeldRemittance(orgId, userId, doc, data) {
  const fileBytes = fs.readFileSync(documentPath(doc));
  const fileHash = crypto.createHash('sha256').update(fileBytes).digest('hex');
  const lines = data.lines || [];
  const totals = lines.reduce((t, l) => {
    const adj = (l.adjustments || []).reduce((s, a) => s + a.amount, 0);
    return {
      billed: round2(t.billed + (l.billed || 0)),
      paid: round2(t.paid + (l.paid || 0)),
      adj: round2(t.adj + adj),
      pr: round2(t.pr + (l.patient_resp || 0)),
    };
  }, { billed: 0, paid: 0, adj: 0, pr: 0 });

  db.exec('BEGIN');
  try {
    const eraId = Number(db.prepare(`
      INSERT INTO era_remittances (org_id, payer_name, check_number, pay_date, payment_amount,
        plb_total, total_billed, total_paid, total_adjustments, total_patient_resp,
        line_count, source_filename, file_hash, uploaded_by)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(orgId, data.payer || null, data.check_number || null, data.pay_date || null,
      data.payment_amount != null ? data.payment_amount : totals.paid,
      totals.billed, totals.paid, totals.adj, totals.pr,
      lines.length, doc.filename, fileHash, userId).lastInsertRowid);

    const insertLine = db.prepare(`
      INSERT INTO era_claim_lines (era_id, org_id, clp_ref, payer_icn, patient_name,
        service_start, service_end, status_code, billed, paid, patient_resp, allowed,
        adjustments, total_adjustments, variance, denial_reason, flags,
        match_claim_id, suggested_claim_id, match_method)
      VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    lines.forEach((l, i) => {
      const adjustments = (l.adjustments || []).map((a) => ({
        group: a.group, groupText: GROUP_TEXT[a.group] || a.group,
        code: a.code || '', text: a.text || 'Adjustment', amount: a.amount,
      }));
      const totalAdj = round2(adjustments.reduce((s, a) => s + a.amount, 0));
      const coAdj = round2(adjustments.filter((a) => a.group === 'CO').reduce((s, a) => s + a.amount, 0));
      const variance = lineVariance(l);
      const denialTexts = adjustments.filter((a) => a.group !== 'PR')
        .map((a) => (a.code ? `${a.code} — ${a.text}` : a.text));
      const denialReason = denialTexts.length ? denialTexts.join('; ') : null;
      const isDenial = (l.paid || 0) === 0 && !!denialReason && (l.patient_resp || 0) === 0 && totalAdj < (l.billed || 0);
      const flags = [];
      if (!l.matched_claim_id) flags.push('unmatched');
      if (isDenial) flags.push('denial');
      if (Math.abs(variance) > VARIANCE_TOLERANCE) flags.push('variance');
      if ((l.paid || 0) === 0 && !isDenial) flags.push('zero_pay');
      insertLine.run(eraId, orgId, l.claim_number || `INTAKE-${doc.id}-${i + 1}`, l.patient || null,
        l.service_date || null, isDenial ? '4' : '1', l.billed || 0, l.paid || 0, l.patient_resp || 0,
        round2((l.billed || 0) - coAdj), JSON.stringify(adjustments), totalAdj, variance,
        denialReason, JSON.stringify(flags),
        l.matched_claim_id || null, l.suggested_claim_id || null, l.match_method || null);
    });
    recomputeRemittance(eraId);
    db.exec('COMMIT');
    return { era_id: eraId, lines: lines.length, matched: lines.filter((l) => l.matched_claim_id).length };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function attachDenial(req, doc, data) {
  const orgId = doc.org_id;
  if (!data.claim_id) {
    throw new Error('No claim is matched to this letter — pick the claim in the review screen before applying.');
  }
  const claim = db.prepare('SELECT id, claim_number, denial_reason FROM claims WHERE id = ? AND org_id = ?')
    .get(data.claim_id, orgId);
  if (!claim) throw new Error('The matched claim no longer exists in this workspace.');
  const denialText = (data.denial_reasons || []).join('; ') || claim.denial_reason || 'Denial reported by payer letter';
  db.prepare(`
    UPDATE claims SET status = 'denied', denial_reason = ?, last_touched_at = datetime('now') WHERE id = ?
  `).run(denialText, claim.id);
  logActivity(orgId, claim.id, req.user.id, 'denial_recorded',
    `Denial attached from payer letter (${doc.filename})${data.appeal_deadline ? ` — appeal by ${data.appeal_deadline}` : ''}${data.appeal_address ? ` — appeals to: ${data.appeal_address}` : ''}`);

  // Propose the appeal draft through the SAME tool the chat uses (it
  // builds the pending draft_appeal card incl. winning-angle learning).
  // Skipped when a draft for this claim is already awaiting a decision.
  let draftActionId = null;
  let draftNote = null;
  const pendingDraft = db.prepare(`
    SELECT id FROM agent_actions WHERE org_id = ? AND kind = 'draft_appeal' AND status = 'pending'
      AND CAST(json_extract(payload, '$.claim_id') AS INTEGER) = ?
  `).get(orgId, claim.id);
  if (pendingDraft) {
    draftNote = 'An appeal draft for this claim is already awaiting a decision.';
  } else {
    const { draftAppealTool } = require('./tools');
    const r = draftAppealTool({ orgId, user: req.user, convoId: null }, { claim_id: claim.id });
    if (r && !r.isError && r.action) draftActionId = r.action.id;
    else draftNote = (r && r.output && r.output.error) || 'An appeal draft could not be proposed.';
  }
  return { claim_id: claim.id, claim_number: claim.claim_number, draft_action_id: draftActionId, draft_note: draftNote };
}

// Executor body for the apply_intake action kind (called by actions.js).
function applyIntake(req, action) {
  const payload = JSON.parse(action.payload || '{}');
  const doc = getDocument(payload.document_id, action.org_id);
  if (!doc) throw new Error('The intake document no longer exists in this workspace.');
  if (doc.status === 'applied') throw new Error('This document was already applied.');
  const { extracted } = parseStored(doc);
  if (!extracted) throw new Error('This document has no extraction to apply.');
  let result;
  if (doc.kind === 'remittance') {
    result = createHeldRemittance(action.org_id, req.user.id, doc, extracted);
    db.prepare("UPDATE agent_documents SET status = 'applied', era_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(result.era_id, doc.id);
    result = { document_id: doc.id, kind: 'remittance', ...result };
  } else if (doc.kind === 'denial_letter') {
    const r = attachDenial(req, doc, extracted);
    db.prepare("UPDATE agent_documents SET status = 'applied', updated_at = datetime('now') WHERE id = ?").run(doc.id);
    result = { document_id: doc.id, kind: 'denial_letter', ...r };
  } else {
    throw new Error('This document was not classified as a remittance or denial letter — nothing to apply.');
  }
  return result;
}

module.exports = {
  DOCS_ROOT,
  detectMediaType,
  parseExtractionText,
  extractAndStore,
  getDocument,
  parseStored,
  serializeDocument,
  updateMatch,
  computeProblems,
  buildIntakeAction,
  applyIntake,
  documentPath,
  lineVariance,
};
