// Stedi claims client — submission (837P raw X12), claim status (276/277),
// and webhook event support for the transmission pipeline (Phase A of the
// Stedi integration; eligibility lives in ../eligibility/vendors.js).
//
// Platform account, same posture as eligibility: the API key lives ONLY in
// the server env (STEDI_API_KEY), never in org rows or settings payloads.
// A key starting with "test_" is TEST mode (Stedi's own convention): it can
// submit to Stedi's test flow but cannot run production transactions, and
// Stedi does not support claim-status checks with test keys at all. When the
// founder supplies the production key, the same code paths go live — mode is
// derived from the key, never from a config toggle.
//
// Endpoints (Stedi API reference, verified 2026-11-02):
//   Submit: POST {base}/change/medicalnetwork/professionalclaims/v3/raw-x12-submission
//           body { x12: "<837P text>" }, header Authorization: <key, raw>,
//           Idempotency-Key supported. 200 = Stedi validated + routed; the
//           response carries claimReference + Stedi's own edit-level 277CA
//           in `x12`. Payer acceptance arrives later (277CA via webhook).
//   Status: POST {base}/change/medicalnetwork/claimstatus/v2 (JSON 276 ->
//           synchronous JSON 277). Production claims only.

const STEDI_BASE = (process.env.STEDI_HEALTHCARE_BASE || 'https://healthcare.us.stedi.com/2024-04-01').replace(/\/$/, '');
const SUBMIT_URL = `${STEDI_BASE}/change/medicalnetwork/professionalclaims/v3/raw-x12-submission`;
const STATUS_URL = `${STEDI_BASE}/change/medicalnetwork/claimstatus/v2`;
const TIMEOUT_MS = 30000;

function stediApiKey() {
  return (process.env.STEDI_API_KEY || '').trim();
}

function stediMode() {
  const k = stediApiKey();
  if (!k) return 'unconfigured';
  return k.startsWith('test_') ? 'test' : 'production';
}

function requireKey() {
  const k = stediApiKey();
  if (!k) throw new Error('Stedi is not configured on this server (STEDI_API_KEY missing) — set it before transmitting via Stedi.');
  return k;
}

async function stediFetch(url, { method = 'POST', body, idempotencyKey } = {}) {
  const key = requireKey();
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: key,
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Stedi unreachable: ${e.message}`);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { res, text, json };
}

// Submit one 837P file (a whole batch envelope) through Stedi.
// Resolves { mode, controlNumber, status, payerName, ackX12, raw } on a
// clean Stedi acceptance; throws with the precise Stedi error otherwise
// (HTTP failure, or claim-edit errors in claimReference.errors).
async function submitRawX12(ediText, idempotencyKey) {
  const { res, text, json } = await stediFetch(SUBMIT_URL, {
    body: { x12: ediText },
    idempotencyKey,
  });
  if (!res.ok) {
    const msg = json?.message || json?.error || text.slice(0, 300);
    throw new Error(`Stedi submission failed (HTTP ${res.status})${msg ? `: ${msg}` : ''}`);
  }
  const ref = json?.claimReference || {};
  const errors = Array.isArray(ref.errors) ? ref.errors : [];
  if (errors.length) {
    const list = errors.slice(0, 5).map((e) => e.description || e.message || JSON.stringify(e)).join('; ');
    throw new Error(`Stedi rejected the file at claim edits (${errors.length}): ${list}`);
  }
  return {
    mode: stediMode(),
    controlNumber: ref.controlNumber || json?.meta?.controlNumber || null,
    status: json?.status || null,
    payerName: json?.payer?.name || null,
    tradingPartnerServiceId: json?.tradingPartnerServiceId || null,
    ackX12: typeof json?.x12 === 'string' && json.x12.trim() ? json.x12 : null,
    raw: json,
  };
}

// Real-time claim status (276/277). Production keys only — Stedi rejects
// test keys for this endpoint, so fail fast with the honest reason instead
// of burning a call. payload is the CHC-shape JSON built by the caller.
async function claimStatusCheck(payload) {
  if (stediMode() === 'test') {
    const err = new Error('Claim status needs the production Stedi key — Stedi does not support claim-status checks with test keys.');
    err.code = 'STEDI_TEST_KEY';
    throw err;
  }
  const { res, text, json } = await stediFetch(STATUS_URL, { body: payload });
  if (!res.ok) {
    const msg = json?.message || json?.error || text.slice(0, 300);
    throw new Error(`Stedi claim status failed (HTTP ${res.status})${msg ? `: ${msg}` : ''}`);
  }
  return json;
}

// Prior-auth 278 transmit (deploy #106, Phase F). HONEST VENDOR STATE:
// Stedi's healthcare API catalog has no dedicated 278 endpoint today
// (eligibility, claims, claim status, ERA — 278 exists as EDI guides
// only). So this mirrors the eligibility posture exactly:
//   - test/unconfigured key: NO network call. The payload was prepared
//     and recorded locally; the result says TEST MODE, never "sent".
//   - production key + STEDI_278_PATH set (the trading-partner 278 route
//     provisioned on the account): POST the raw X12 to {base}{path} with
//     the same auth + idempotency pattern as claim submission.
//   - production key without the path: a precise, honest error — the
//     code path exists; the vendor route is the missing piece.
async function submitHealthServiceReview(x12, idempotencyKey) {
  const mode = stediMode();
  if (mode !== 'production') {
    return {
      mode,
      transmitted: false,
      controlNumber: null,
      note: mode === 'test'
        ? 'TEST MODE — the 278 was prepared and recorded locally. Test keys do not reach payers; nothing was sent.'
        : 'Stedi is not configured on this server (STEDI_API_KEY missing) — the 278 was prepared and recorded locally only.',
    };
  }
  const path = (process.env.STEDI_278_PATH || '').trim();
  if (!path) {
    const err = new Error('Stedi does not offer a dedicated 278 endpoint in its healthcare API catalog, and no trading-partner 278 route is provisioned on this account yet (STEDI_278_PATH unset). The 278 payload is prepared and saved on the record; submit it through the payer portal or fax until the route is provisioned.');
    err.code = 'STEDI_278_NOT_PROVISIONED';
    throw err;
  }
  const { res, text, json } = await stediFetch(`${STEDI_BASE}${path.startsWith('/') ? path : `/${path}`}`, {
    body: { x12 },
    idempotencyKey,
  });
  if (!res.ok) {
    const msg = json?.message || json?.error || text.slice(0, 300);
    throw new Error(`Stedi 278 submission failed (HTTP ${res.status})${msg ? `: ${msg}` : ''}`);
  }
  return {
    mode,
    transmitted: true,
    controlNumber: json?.meta?.controlNumber || json?.controlNumber || null,
    status: json?.status || null,
    note: 'Transmitted to Stedi for routing to the payer.',
    raw: json,
  };
}

// Map one Stedi 277 JSON claim entry onto a compact, UI-ready shape.
function mapStatusResult(json) {
  const claims = Array.isArray(json?.claims) ? json.claims : [];
  return claims.map((c) => {
    const cs = c.claimStatus || {};
    return {
      status: c.status || json?.status || null,
      category_code: cs.statusCategoryCode || null,
      status_code: cs.statusCode || null,
      entity_code: cs.entityCode || null,
      patient_account_number: cs.patientAccountNumber || null,
      payer_icn: cs.claimControlNumber || c.claimControlNumber || null,
      total_charges: cs.totalClaimChargeAmount ?? null,
      paid_amount: cs.claimPaymentAmount ?? null,
      status_text: [cs.statusCategoryCode, cs.statusCode].filter(Boolean).join(' / ') || null,
    };
  });
}

module.exports = { stediApiKey, stediMode, submitRawX12, claimStatusCheck, mapStatusResult, submitHealthServiceReview, SUBMIT_URL, STATUS_URL };
