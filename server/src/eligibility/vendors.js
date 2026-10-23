// Pluggable eligibility vendor layer (270/271-style real-time checks).
//
// Honest architecture: a real 270/271 check requires a clearinghouse/vendor
// account (pVerify, Eligible, Availity, Change Healthcare) PLUS payer enrollment
// for each payer you check against. Until the org configures one, everything
// runs through the `demo` vendor, whose responses are clearly labeled synthetic.
// Demo results are NEVER presented as real — the API returns demo:true and the
// UI shows a "DEMO MODE — synthetic data" banner.
//
// `runCheck(vendorName, orgConfig, input)` resolves to a normalized benefit object:
//   { coverage_active, plan_name, plan_type, group_number,
//     copay_primary, copay_specialist, deductible_individual, deductible_remaining,
//     oop_max, effective_date, term_date, raw_request, raw_response }
// `raw_response` always includes a `demo` boolean so storage + UI can label it.

const crypto = require('crypto');

// ---- input validation -------------------------------------------------------

function validDob(dob) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob || '')) return false;
  const d = new Date(dob + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  const age = (now - d) / (365.25 * 24 * 3600 * 1000);
  return age >= 0 && age <= 130;
}

function validateInput(input) {
  const errors = [];
  const first = (input.patient_first || '').trim();
  const last = (input.patient_last || '').trim();
  const memberId = (input.member_id || '').trim();
  const payer = (input.payer || '').trim();
  const dos = (input.date_of_service || '').trim();
  if (first.length < 1) errors.push('Patient first name is required');
  if (last.length < 1) errors.push('Patient last name is required');
  if (!validDob(input.dob)) errors.push('Date of birth must be a valid date (YYYY-MM-DD)');
  if (memberId.length < 3 || memberId.length > 40) errors.push('Member ID must be 3–40 characters');
  if (!payer) errors.push('Payer is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dos)) errors.push('Date of service must be YYYY-MM-DD');
  return { errors, clean: { patient_first: first, patient_last: last, dob: input.dob, member_id: memberId, payer, date_of_service: dos } };
}

// ---- demo vendor ------------------------------------------------------------
// Deterministic synthetic 271-style response. Same member_id → same benefits
// (stable hash), ~85% of member IDs resolve to active coverage.

const DEMO_PLANS = [
  { plan_name: 'Choice Plus PPO', plan_type: 'PPO', copay_primary: 25, copay_specialist: 50, deductible_individual: 1500, oop_max: 6000 },
  { plan_name: 'Open Access Plus', plan_type: 'PPO', copay_primary: 20, copay_specialist: 40, deductible_individual: 1000, oop_max: 5000 },
  { plan_name: 'Select HMO', plan_type: 'HMO', copay_primary: 30, copay_specialist: 60, deductible_individual: 0, oop_max: 4500 },
  { plan_name: 'High Deductible Health Plan', plan_type: 'HDHP', copay_primary: 0, copay_specialist: 0, deductible_individual: 3500, oop_max: 7000 },
  { plan_name: 'Preferred Provider Plan', plan_type: 'PPO', copay_primary: 35, copay_specialist: 70, deductible_individual: 2000, oop_max: 8000 },
];

function hashToUnit(str) {
  const h = crypto.createHash('sha256').update(str.toLowerCase()).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

function demoCheck(input) {
  const u = hashToUnit(input.member_id + '|' + input.payer);
  const u2 = hashToUnit('plan|' + input.member_id);
  const u3 = hashToUnit('ded|' + input.member_id);
  const active = u < 0.85;
  const plan = DEMO_PLANS[Math.floor(u2 * DEMO_PLANS.length)];
  const deductible_remaining = active ? Math.round(plan.deductible_individual * (0.15 + u3 * 0.85) * 100) / 100 : null;
  const effYear = new Date().getFullYear();

  const raw_response = {
    demo: true,
    note: 'SYNTHETIC — generated locally for workflow testing. Not a real 271 response.',
    eb: active ? '1' : '6', // EB01: 1=Active Coverage, 6=Inactive
    ...(!active ? {} : {
      plan_name: plan.plan_name,
      plan_type: plan.plan_type,
      group_number: 'GRP-' + Math.floor(100000 + u3 * 899999),
      copay_primary: plan.copay_primary,
      copay_specialist: plan.copay_specialist,
      deductible_individual: plan.deductible_individual,
      deductible_remaining,
      oop_max: plan.oop_max,
      effective_date: `${effYear}-01-01`,
      term_date: `${effYear}-12-31`,
    }),
  };

  return {
    coverage_active: active ? 1 : 0,
    plan_name: active ? plan.plan_name : null,
    plan_type: active ? plan.plan_type : null,
    group_number: active ? raw_response.group_number : null,
    copay_primary: active ? plan.copay_primary : null,
    copay_specialist: active ? plan.copay_specialist : null,
    deductible_individual: active ? plan.deductible_individual : null,
    deductible_remaining,
    oop_max: active ? plan.oop_max : null,
    effective_date: active ? raw_response.effective_date : null,
    term_date: active ? raw_response.term_date : null,
    raw_request: { vendor: 'demo', input },
    raw_response,
  };
}

// ---- rest vendor ------------------------------------------------------------
// Generic HTTPS vendor: POST { patient, payer, date_of_service } to the org's
// configured endpoint and map the vendor's fields onto the normalized shape.
// On ANY failure it throws — it never silently falls back to demo.

const REST_TIMEOUT_MS = 30000;

// Default field mapping: vendor JSON field -> normalized field.
// Vendors differ; this default covers the common shape. A future mapping editor
// can override per-org via org config — for now the default is documented here.
const DEFAULT_FIELD_MAP = {
  coverage_active: ['coverage_active', 'active', 'is_active', 'coverageActive'],
  plan_name: ['plan_name', 'planName', 'plan'],
  plan_type: ['plan_type', 'planType', 'plan_code'],
  group_number: ['group_number', 'groupNumber', 'group'],
  copay_primary: ['copay_primary', 'copayPrimary', 'pcp_copay'],
  copay_specialist: ['copay_specialist', 'copaySpecialist', 'specialist_copay'],
  deductible_individual: ['deductible_individual', 'deductibleIndividual', 'deductible'],
  deductible_remaining: ['deductible_remaining', 'deductibleRemaining', 'deductible_remaining_amount'],
  oop_max: ['oop_max', 'oopMax', 'out_of_pocket_max'],
  effective_date: ['effective_date', 'effectiveDate', 'coverage_start'],
  term_date: ['term_date', 'termDate', 'coverage_end'],
};

function pickField(obj, candidates) {
  for (const k of candidates) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

async function restCheck(orgConfig, input) {
  const endpoint = (orgConfig.eligibility_endpoint || '').trim();
  if (!endpoint) throw new Error('No eligibility endpoint configured — set one in Settings before running a real check.');
  if (!/^https?:\/\//i.test(endpoint)) throw new Error('Eligibility endpoint must be an http(s) URL.');

  const scheme = (orgConfig.eligibility_auth_scheme || 'Bearer').trim();
  const apiKey = (orgConfig.eligibility_api_key || '').trim();
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    if (/^basic$/i.test(scheme)) {
      headers.Authorization = 'Basic ' + Buffer.from(apiKey).toString('base64');
    } else if (/^bearer$/i.test(scheme)) {
      headers.Authorization = 'Bearer ' + apiKey;
    } else {
      // Custom header name, e.g. "X-API-Key"
      headers[scheme] = apiKey;
    }
  }

  const body = {
    patient: {
      first_name: input.patient_first,
      last_name: input.patient_last,
      dob: input.dob,
      member_id: input.member_id,
    },
    payer: input.payer,
    date_of_service: input.date_of_service,
  };

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Eligibility vendor unreachable: ${e.message}`);
  }

  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }

  if (!res.ok) {
    const detail = parsed?.error || parsed?.message || text.slice(0, 200);
    throw new Error(`Eligibility vendor returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Eligibility vendor returned a non-JSON response.');
  }

  const m = DEFAULT_FIELD_MAP;
  const activeRaw = pickField(parsed, m.coverage_active);
  return {
    coverage_active: activeRaw === true || activeRaw === 1 || String(activeRaw).toLowerCase() === 'active' ? 1 : 0,
    plan_name: pickField(parsed, m.plan_name),
    plan_type: pickField(parsed, m.plan_type),
    group_number: pickField(parsed, m.group_number),
    copay_primary: pickField(parsed, m.copay_primary),
    copay_specialist: pickField(parsed, m.copay_specialist),
    deductible_individual: pickField(parsed, m.deductible_individual),
    deductible_remaining: pickField(parsed, m.deductible_remaining),
    oop_max: pickField(parsed, m.oop_max),
    effective_date: pickField(parsed, m.effective_date),
    term_date: pickField(parsed, m.term_date),
    raw_request: { vendor: 'rest', endpoint, body },
    raw_response: { demo: false, http_status: res.status, vendor_body: parsed },
  };
}

// ---- entry point ------------------------------------------------------------

async function runCheck(vendorName, orgConfig, input) {
  const { errors, clean } = validateInput(input);
  if (errors.length) {
    const e = new Error(errors.join('; '));
    e.status = 400;
    e.validationErrors = errors;
    throw e;
  }
  if (vendorName === 'rest') return restCheck(orgConfig, clean);
  // Unknown/missing vendor names fall back to demo ONLY when the org never
  // configured a real vendor — a configured 'rest' vendor that fails throws.
  return demoCheck(clean);
}

module.exports = { runCheck, validateInput, demoCheck, restCheck, DEFAULT_FIELD_MAP };
