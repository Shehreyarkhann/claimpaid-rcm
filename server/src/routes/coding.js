// AI-assisted medical coding API.
//
// HUMAN-IN-THE-LOOP (hard guarantee): the LLM only SUGGESTS codes. Nothing is
// ever auto-applied to a claim. A human (owner/biller) must explicitly accept
// each code via POST /jobs/:id/decide before it touches a claim draft.
// Codes outside the curated library are marked `unverified` and can only be
// applied when the human explicitly confirms a final_code.
//
// Flow: POST /analyze -> { job_id } (async, LLM takes 30-90s)
//        GET  /jobs/:id            (poll until status complete/failed)
//        POST /jobs/:id/decide     (accept/reject per code; accepted codes
//                                   applied to the linked claim draft)
const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired, requireProduct } = require('../auth');
const { logActivity } = require('../activity');
const { isInLibrary, libraryDescription, callCodeAssist, sanitizeSuggestions, assessJob } = require('../coding/lib');

const router = express.Router();
const rcm = requireProduct('rcm');
const canWrite = [authRequired, rcm, roleRequired('owner', 'biller')];

const MIN_NOTE = 50;
const MAX_NOTE = 20000;

// ---- background worker (never blocks the analyze response) ----
async function processJob(jobId) {
  const job = db.prepare('SELECT * FROM coding_jobs WHERE id = ?').get(jobId);
  if (!job || job.status !== 'pending') return;
  db.prepare(`UPDATE coding_jobs SET status = 'processing' WHERE id = ?`).run(jobId);
  try {
    const out = await callCodeAssist(job.org_id, job.note_text);
    db.prepare(`UPDATE coding_jobs SET status = 'complete', result_json = ? WHERE id = ?`).run(
      JSON.stringify({ suggestions: sanitizeSuggestions(out.suggestions), model: out.model || null }),
      jobId
    );
  } catch (e) {
    db.prepare(`UPDATE coding_jobs SET status = 'failed', error = ? WHERE id = ?`).run(
      String(e.message || e).slice(0, 500),
      jobId
    );
  }
}

function withLibraryFlags(suggestions) {
  return (suggestions || []).map((s) => {
    const lib = libraryDescription(s.code, s.type);
    return {
      code: s.code,
      type: s.type,
      confidence: s.confidence,
      evidence: s.evidence,
      rationale: s.rationale,
      in_library: !!lib,
      library_description: lib ? lib.description : null,
    };
  });
}

// POST /api/coding/analyze { note_text, claim_id?, encounter_id? } -> { job_id }
router.post('/analyze', ...canWrite, (req, res) => {
  const { note_text, claim_id, encounter_id } = req.body || {};
  const note = typeof note_text === 'string' ? note_text.trim() : '';
  if (note.length < MIN_NOTE) {
    return res.status(400).json({ error: `Clinical note is too short — at least ${MIN_NOTE} characters so the AI has something to code from.` });
  }
  if (note.length > MAX_NOTE) {
    return res.status(400).json({ error: `Clinical note exceeds ${MAX_NOTE} characters.` });
  }
  let claimId = null;
  if (claim_id != null) {
    const c = db.prepare('SELECT id FROM claims WHERE id = ? AND org_id = ?').get(claim_id, req.orgId);
    if (!c) return res.status(404).json({ error: 'Claim not found' });
    claimId = c.id;
  }
  let encounterId = null;
  if (encounter_id != null) {
    const e = db.prepare('SELECT id FROM ehr_encounters WHERE id = ? AND org_id = ?').get(encounter_id, req.orgId);
    if (!e) return res.status(404).json({ error: 'Encounter not found' });
    encounterId = e.id;
  }
  const jobId = Number(
    db.prepare(
      `INSERT INTO coding_jobs (org_id, claim_id, encounter_id, note_text, created_by)
       VALUES (?, ?, ?, ?, ?)`
    ).run(req.orgId, claimId, encounterId, note, req.user.id).lastInsertRowid
  );
  // Async: LLM calls take 30-90s. Never block the response.
  setImmediate(() => processJob(jobId).catch((e) => {
    try {
      db.prepare(`UPDATE coding_jobs SET status = 'failed', error = ? WHERE id = ?`)
        .run(String(e.message || e).slice(0, 500), jobId);
    } catch { /* best effort */ }
  }));
  res.status(202).json({ job_id: jobId, status: 'pending' });
});

// GET /api/coding/jobs/:id -> job + suggestions (poll this)
router.get('/jobs/:id', authRequired, rcm, (req, res) => {
  const job = db.prepare('SELECT * FROM coding_jobs WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!job) return res.status(404).json({ error: 'Coding job not found' });
  let suggestions = [];
  let assessment = null;
  let summary = null;
  try {
    const parsed = job.result_json ? JSON.parse(job.result_json) : null;
    const flagged = withLibraryFlags(parsed?.suggestions);
    if (job.status === 'complete') {
      // Grounding gate (deploy #62): verify each evidence quote against the
      // stored note and stamp the tri-state status before the client sees it.
      const out = assessJob(job.note_text, flagged);
      suggestions = out.suggestions;
      assessment = out.assessment;
      summary = out.summary;
    } else {
      suggestions = flagged;
    }
  } catch { /* corrupted result: leave empty */ }
  const decisions = db.prepare('SELECT code, type, decision, final_code FROM coding_decisions WHERE job_id = ?').all(job.id);
  res.json({
    id: job.id,
    status: job.status,
    error: job.error,
    claim_id: job.claim_id,
    encounter_id: job.encounter_id,
    model: (() => { try { return JSON.parse(job.result_json || '{}').model || null; } catch { return null; } })(),
    created_at: job.created_at,
    suggestions,
    assessment,
    summary,
    decisions,
  });
});

// Merge accepted codes into the linked claim draft (dedupe; never overwrite).
function applyToClaim(orgId, claimId, userId, accepted) {
  const claim = db.prepare('SELECT * FROM claims WHERE id = ? AND org_id = ?').get(claimId, orgId);
  if (!claim) {
    const e = new Error('Claim not found');
    e.status = 404;
    throw e;
  }
  const cpts = new Set((claim.cpt_codes || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
  const icds = new Set((claim.icd_codes || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
  for (const a of accepted) {
    const code = String(a.final_code || a.code).trim().toUpperCase();
    if (!code) continue;
    if (a.type === 'CPT') cpts.add(code);
    else icds.add(code);
  }
  db.prepare('UPDATE claims SET cpt_codes = ?, icd_codes = ? WHERE id = ? AND org_id = ?').run(
    [...cpts].join(', ') || null,
    [...icds].join(', ') || null,
    claimId,
    orgId
  );
  logActivity(orgId, claimId, userId, 'updated',
    `AI code assist: ${accepted.length} code(s) applied after human review (${accepted.map((a) => a.final_code || a.code).join(', ')})`);
  return db.prepare('SELECT c.*, p.name AS payer FROM claims c JOIN payers p ON p.id = c.payer_id WHERE c.id = ?').get(claimId);
}

// POST /api/coding/jobs/:id/decide { decisions: [{code, type, decision, final_code?}] }
router.post('/jobs/:id/decide', ...canWrite, (req, res) => {
  const job = db.prepare('SELECT * FROM coding_jobs WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!job) return res.status(404).json({ error: 'Coding job not found' });
  if (job.status !== 'complete') {
    return res.status(400).json({ error: `Job is ${job.status} — decisions require a completed analysis.` });
  }
  const { decisions } = req.body || {};
  if (!Array.isArray(decisions) || decisions.length === 0) {
    return res.status(400).json({ error: 'decisions (non-empty array) is required' });
  }
  const clean = [];
  for (const d of decisions) {
    const code = String(d?.code || '').trim().toUpperCase();
    const type = String(d?.type || '').trim().toUpperCase();
    const decision = String(d?.decision || '').trim().toLowerCase();
    const finalCode = d?.final_code != null ? String(d.final_code).trim().toUpperCase() : null;
    if (!code || (type !== 'CPT' && type !== 'ICD10')) {
      return res.status(400).json({ error: `Invalid code/type in decision for "${d?.code}".` });
    }
    if (!['accepted', 'rejected', 'modified'].includes(decision)) {
      return res.status(400).json({ error: `Invalid decision "${d?.decision}" — use accepted, rejected, or modified.` });
    }
    const inLib = isInLibrary(code, type);
    if (decision === 'modified' && !finalCode) {
      return res.status(400).json({ error: `Code ${code}: "modified" requires final_code.` });
    }
    if (decision === 'accepted' && !inLib && !finalCode) {
      // HARD STOP: unverified codes can never be applied on AI authority alone.
      return res.status(400).json({
        error: `Code ${code} is not in the verified library — a human must confirm it via final_code before it can be accepted.`,
      });
    }
    clean.push({ code, type, decision, final_code: finalCode || null, in_library: inLib ? 1 : 0 });
  }

  // Replace prior decisions (re-review is idempotent; apply merges codes).
  db.prepare('DELETE FROM coding_decisions WHERE job_id = ?').run(job.id);
  const ins = db.prepare(
    `INSERT INTO coding_decisions (job_id, code, type, decision, final_code, in_library, decided_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const c of clean) {
    ins.run(job.id, c.code, c.type, c.decision, c.final_code, c.in_library, req.user.id);
  }

  let claim = null;
  const accepted = clean.filter((c) => c.decision === 'accepted' || c.decision === 'modified');
  if (accepted.length && job.claim_id) {
    try {
      claim = applyToClaim(req.orgId, job.claim_id, req.user.id, accepted);
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }
  res.json({
    ok: true,
    applied: accepted.length,
    applied_to_claim: claim ? claim.id : null,
    claim,
    note: job.claim_id ? undefined : 'No claim linked — decisions recorded; apply them when a claim is linked.',
  });
});

module.exports = router;
