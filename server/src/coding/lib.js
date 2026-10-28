// AI-assisted coding helpers: curated code library + service-to-service call
// to the ClaimPaid AI service (local Ollama, zero external APIs).
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../auth');

let LIB = null;
function loadLibrary() {
  if (!LIB) {
    const raw = fs.readFileSync(path.join(__dirname, 'code-library.json'), 'utf8');
    LIB = JSON.parse(raw).codes;
  }
  return LIB;
}

// Normalize a code for comparison: uppercase, strip whitespace. CPT codes
// never contain dots; ICD-10 codes may (M54.5). We compare both dotted and
// undotted forms so "M545" still matches "M54.5".
function normCode(code) {
  return String(code || '').trim().toUpperCase().replace(/\s+/g, '');
}

function isInLibrary(code, type) {
  const n = normCode(code);
  const noDot = n.replace(/\./g, '');
  const t = String(type || '').toUpperCase();
  return loadLibrary().some(
    (c) =>
      (c.code.toUpperCase() === n || c.code.toUpperCase().replace(/\./g, '') === noDot) &&
      (!t || c.type === t)
  );
}

function libraryDescription(code, type) {
  const n = normCode(code);
  const noDot = n.replace(/\./g, '');
  const hit = loadLibrary().find(
    (c) => c.code.toUpperCase() === n || c.code.toUpperCase().replace(/\./g, '') === noDot
  );
  return hit ? { description: hit.description, type: hit.type } : null;
}

const AI_SERVICE_URL = (process.env.AI_SERVICE_URL || 'http://127.0.0.1:4001').replace(/\/$/, '');

// Sign a short-lived service token so the AI service can verify this call
// came from the RCM server (it holds the same secret as RCM_JWT_SECRET).
function serviceToken(orgId) {
  return jwt.sign({ service: 'claimpaid-rcm', org: orgId }, JWT_SECRET, { expiresIn: '5m' });
}

// Call the AI service's code-assist endpoint. Throws on any failure — the
// caller marks the job failed; we never silently degrade to fake suggestions.
async function callCodeAssist(orgId, noteText) {
  const library = loadLibrary().map((c) => ({ code: c.code, type: c.type, description: c.description }));
  const res = await fetch(`${AI_SERVICE_URL}/api/v1/code-assist`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-service-token': serviceToken(orgId),
    },
    // 200s: Ollama gets 180s server-side; give the hop a little headroom
    signal: AbortSignal.timeout(200000),
    body: JSON.stringify({ note_text: noteText, code_library: library }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Code-assist service returned ${res.status}`);
  }
  return res.json();
}

// Defense-in-depth: the AI service already sanitizes, but the RCM server
// never trusts a network response blindly. Malformed entries are dropped here too.
function sanitizeSuggestions(suggestions) {
  if (!Array.isArray(suggestions)) return [];
  return suggestions
    .map((s) => {
      if (!s || typeof s !== 'object') return null;
      const code = String(s.code || '').trim().toUpperCase();
      const type = String(s.type || '').trim().toUpperCase();
      const confidence = Number(s.confidence);
      if (!code || (type !== 'CPT' && type !== 'ICD10')) return null;
      return {
        code,
        type,
        confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
        evidence: String(s.evidence || '').slice(0, 500),
        rationale: String(s.rationale || '').slice(0, 500),
      };
    })
    .filter(Boolean)
    .slice(0, 25);
}

// ---- Evidence grounding + tri-state assessment (deploy #62) ----
// The AI returns an "evidence" quote per suggestion, but a quote is only
// evidence if those words are actually in the note. Verified deterministically
// here: normalize both texts (lowercase, non-alphanumeric -> space, collapse)
// and locate the quote, mapping the match back to character offsets in the
// ORIGINAL note so the UI can point at the exact span.
//   status 'valid'  : in library AND evidence verified AND confidence >= 0.75
//   status 'review' : anything else that survived sanitizing
// Job assessment: 'abstain' (zero suggestions — the assistant declined to
// guess), 'ready' (>= 1 valid), 'review' (suggestions exist, none grounded).
const MIN_EVIDENCE_CHARS = 8;
const VALID_CONFIDENCE = 0.75;

function normalizeWithMap(text) {
  const src = String(text || '');
  let norm = '';
  const map = []; // map[normalizedIndex] = originalIndex
  let lastWasSpace = true; // also trims leading whitespace
  for (let i = 0; i < src.length; i++) {
    const ch = src[i].toLowerCase();
    if (/[a-z0-9]/.test(ch)) {
      norm += ch; map.push(i); lastWasSpace = false;
    } else if (!lastWasSpace) {
      norm += ' '; map.push(i); lastWasSpace = true;
    }
  }
  let end = norm.length;
  while (end > 0 && norm[end - 1] === ' ') end--;
  return { norm: norm.slice(0, end), map: map.slice(0, end) };
}

function assessSuggestions(noteText, suggestions) {
  const { norm: noteNorm, map } = normalizeWithMap(noteText);
  return (suggestions || []).map((s) => {
    const evNorm = normalizeWithMap(s.evidence).norm;
    let evidence_verified = false;
    let evidence_span = null;
    if (evNorm.length >= MIN_EVIDENCE_CHARS) {
      const at = noteNorm.indexOf(evNorm);
      if (at !== -1) {
        evidence_verified = true;
        evidence_span = { start: map[at], end: map[at + evNorm.length - 1] + 1 };
      }
    }
    const status =
      isInLibrary(s.code, s.type) && evidence_verified && Number(s.confidence) >= VALID_CONFIDENCE
        ? 'valid'
        : 'review';
    return { ...s, evidence_verified, evidence_span, status };
  });
}

function assessJob(noteText, suggestions) {
  const assessed = assessSuggestions(noteText, suggestions);
  const valid = assessed.filter((s) => s.status === 'valid').length;
  return {
    suggestions: assessed,
    assessment: assessed.length === 0 ? 'abstain' : valid > 0 ? 'ready' : 'review',
    summary: { total: assessed.length, valid, review: assessed.length - valid },
  };
}

module.exports = { loadLibrary, normCode, isInLibrary, libraryDescription, callCodeAssist, sanitizeSuggestions, assessSuggestions, assessJob, AI_SERVICE_URL, serviceToken };
