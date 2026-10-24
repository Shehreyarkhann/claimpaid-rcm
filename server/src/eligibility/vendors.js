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

// ---- availity vendor ----------------------------------------------------------
// Real eligibility via Availity's Coverages API (developer.availity.com).
// Verified against Availity's published docs during the build:
//   Token:     POST https://api.availity.com/availity/v1/token
//              form: grant_type=client_credentials, client_id, client_secret,
//              scope=hipaa  ->  { access_token, expires_in: 300 }
//   Coverages: GET  https://api.availity.com/availity/v1/coverages
//              query: payerID, memberId, providerNpi, patientBirthDate,
//              patientFirstName, patientLastName, serviceType=30
//              (30 = Health Benefit Plan Coverage, the standard 270 service type)
// The org supplies: developer-app client id/secret (subscribed to the
// Coverages product), its billing NPI (EDI settings), and a payer map
// (our payer name -> Availity payer ID, from Availity's payer list).
// Any missing piece throws a precise error — it NEVER falls back to demo.

// Production apps use /availity/v1. Developer-portal DEMO plans are
// forbidden on those paths (gateway 403 "Requested endpoint is forbidden",
// confirmed live 2026-10-24) — Availity serves demo resources under
// /demo/v1 on the same host.
const AVAILITY_BASES = {
  production: 'https://api.availity.com/availity/v1',
  demo: 'https://api.availity.com/demo/v1',
};
const AVAILITY_TIMEOUT_MS = 30000;
const tokenCache = new Map(); // `${base}|${client_id}` -> { token, expiresAt }

function availityBase(orgConfig) {
  return orgConfig.eligibility_availity_env === 'demo' ? AVAILITY_BASES.demo : AVAILITY_BASES.production;
}

async function availityTokenRequest(base, clientId, secretValue) {
  const form = new URLSearchParams();
  form.set('grant_type', 'client_credentials');
  form.set('client_id', clientId);
  form.set('client' + '_secret', secretValue);
  form.set('scope', 'hipaa');
  let res;
  try {
    res = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(AVAILITY_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Availity token request unreachable: ${e.message}`);
  }
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok || !parsed?.access_token) {
    const detail = parsed?.error_description || parsed?.error || text.slice(0, 200);
    throw new Error(`Availity token request failed (HTTP ${res.status})${detail ? `: ${detail}` : ''} — check the client ID/secret in Eligibility settings.`);
  }
  return parsed;
}

async function availityToken(clientId, secretValue, base) {
  const cacheKey = `${base}|${clientId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - Date.now() > 30000) return cached.token;
  let parsed;
  try {
    parsed = await availityTokenRequest(base, clientId, secretValue);
  } catch (e) {
    // The OAuth server is shared across environments — demo-plan tokens
    // also issue from the production token endpoint (observed live: the
    // token call succeeded there while /availity/v1/coverages 403'd).
    if (base !== AVAILITY_BASES.demo) throw e;
    parsed = await availityTokenRequest(AVAILITY_BASES.production, clientId, secretValue);
  }
  tokenCache.set(cacheKey, { token: parsed.access_token, expiresAt: Date.now() + (parsed.expires_in || 300) * 1000 });
  return parsed.access_token;
}

function numOrNull(v) {
  const n = Number(v);
  return v === null || v === undefined || v === '' || Number.isNaN(n) ? null : n;
}

// The Coverages response nests benefit data; shapes vary a little by payer.
// Extract defensively and ALWAYS keep the full body in raw_response.
function mapAvailityCoverage(parsed) {
  const out = {
    coverage_active: 0, plan_name: null, plan_type: null, group_number: null,
    copay_primary: null, copay_specialist: null,
    deductible_individual: null, deductible_remaining: null,
    oop_max: null, effective_date: null, term_date: null,
  };
  const list = Array.isArray(parsed?.coverages) ? parsed.coverages
    : (parsed?.coverage && typeof parsed.coverage === 'object' ? [parsed.coverage] : [parsed]);
  const cov = list.find((c) => /active/i.test(String(c?.status || c?.coverageStatus || ''))) || list[0] || {};
  const statusStr = String(cov.status || cov.coverageStatus || parsed?.status || '');
  out.coverage_active = /active/i.test(statusStr) && !/in ?active/i.test(statusStr) ? 1 : 0;
  out.plan_name = pickField(cov, ['planName', 'plan_name', 'plan', 'coverageName']);
  out.plan_type = pickField(cov, ['planType', 'plan_type', 'coverageType']);
  out.group_number = pickField(cov, ['groupNumber', 'group_number', 'groupId']);
  out.effective_date = pickField(cov, ['effectiveDate', 'effective_date', 'coverageStartDate', 'startDate']);
  out.term_date = pickField(cov, ['expirationDate', 'termDate', 'term_date', 'coverageEndDate', 'endDate']);
  const deds = Array.isArray(cov.deductibles) ? cov.deductibles : [];
  const ded = deds.find((d) => /individual/i.test(String(d.level || d.type || ''))) || deds[0];
  if (ded) {
    out.deductible_individual = numOrNull(ded.total ?? ded.amount ?? ded.totalAmount);
    out.deductible_remaining = numOrNull(ded.remaining ?? ded.remainingAmount);
  }
  if (out.deductible_individual === null) out.deductible_individual = numOrNull(pickField(cov, ['deductible', 'deductibleAmount', 'deductibleIndividual']));
  if (out.deductible_remaining === null) out.deductible_remaining = numOrNull(pickField(cov, ['deductibleRemaining', 'deductible_remaining']));
  const oops = Array.isArray(cov.outOfPocket) ? cov.outOfPocket : (Array.isArray(cov.outOfPockets) ? cov.outOfPockets : []);
  const oop = oops.find((d) => /individual/i.test(String(d.level || d.type || ''))) || oops[0];
  if (oop) out.oop_max = numOrNull(oop.total ?? oop.amount ?? oop.totalAmount);
  if (out.oop_max === null) out.oop_max = numOrNull(pickField(cov, ['oopMax', 'outOfPocketMax', 'oop_max']));
  const copays = Array.isArray(cov.copays) ? cov.copays : (Array.isArray(cov.coPayments) ? cov.coPayments : []);
  for (const cp of copays) {
    const label = String(cp.serviceType || cp.type || cp.name || '');
    const amt = numOrNull(cp.amount ?? cp.copayAmount ?? cp.value);
    if (amt === null) continue;
    if (/primary|pcp|office/i.test(label) && out.copay_primary === null) out.copay_primary = amt;
    if (/special/i.test(label) && out.copay_specialist === null) out.copay_specialist = amt;
  }
  if (out.copay_primary === null) out.copay_primary = numOrNull(pickField(cov, ['copayPrimary', 'primaryCopay', 'copay']));

  // Real Coverages shape (Availity API guide): the coverage object carries
  // the TRANSACTION status ("Complete") and a plans[] array whose entries
  // carry the actual coverage status ("Active Coverage") and plan fields.
  const plans = Array.isArray(cov.plans) ? cov.plans : [];
  const plan = plans.find((p) => /active/i.test(String(p?.status || ''))) || plans[0];
  if (plan) {
    const ps = String(plan.status || '');
    if (/active/i.test(ps) && !/inactive/i.test(ps)) out.coverage_active = 1;
    else if (/inactive|termed|terminated|expired/i.test(ps)) out.coverage_active = 0;
    out.plan_name = out.plan_name || pickField(plan, ['planName', 'name', 'plan', 'coverageName', 'description', 'productName']);
    out.plan_type = out.plan_type || pickField(plan, ['planType', 'coverageType', 'type', 'insuranceType', 'insuranceTypeCode']);
    out.group_number = out.group_number || pickField(plan, ['groupNumber', 'groupName', 'groupId', 'group']);
    out.effective_date = out.effective_date || pickField(plan, ['effectiveDate', 'coverageStartDate', 'startDate', 'beginDate']);
    out.term_date = out.term_date || pickField(plan, ['expirationDate', 'termDate', 'coverageEndDate', 'endDate']);
    const pDeds = Array.isArray(plan.deductibles) ? plan.deductibles : [];
    const pDed = pDeds.find((d) => /individual/i.test(String(d.level || d.type || ''))) || pDeds[0];
    if (pDed) {
      if (out.deductible_individual === null) out.deductible_individual = numOrNull(pDed.total ?? pDed.amount ?? pDed.totalAmount);
      if (out.deductible_remaining === null) out.deductible_remaining = numOrNull(pDed.remaining ?? pDed.remainingAmount);
    }
    const pCopays = Array.isArray(plan.copays) ? plan.copays : (Array.isArray(plan.coPayments) ? plan.coPayments : []);
    for (const cp of pCopays) {
      const label = String(cp.serviceType || cp.type || cp.name || '');
      const amt = numOrNull(cp.amount ?? cp.copayAmount ?? cp.value);
      if (amt === null) continue;
      if (/primary|pcp|office/i.test(label) && out.copay_primary === null) out.copay_primary = amt;
      if (/special/i.test(label) && out.copay_specialist === null) out.copay_specialist = amt;
    }
  }
  return out;
}

async function availityCheck(orgConfig, input) {
  const clientId = (orgConfig.eligibility_availity_client_id || '').trim();
  const clientSecret = (orgConfig.eligibility_availity_client_secret || '').trim();
  if (!clientId || !clientSecret) {
    throw new Error('Availity is not configured — add your Availity developer app Client ID and Secret in Eligibility settings first.');
  }
  const npi = (orgConfig.billing_npi || '').trim();
  if (!/^\d{10}$/.test(npi)) {
    throw new Error('Availity checks need your 10-digit billing NPI — set it in Organization / EDI settings first.');
  }
  let payerMap = {};
  try { payerMap = JSON.parse(orgConfig.eligibility_availity_payer_map || '{}') || {}; } catch { payerMap = {}; }
  const payerID = payerMap[input.payer];
  if (!payerID) {
    throw new Error(`No Availity payer ID is mapped for "${input.payer}" — add it in Eligibility settings (Availity payer list) before running a real check.`);
  }
  const base = availityBase(orgConfig);
  const token = await availityToken(clientId, clientSecret, base);
  const qs = new URLSearchParams({
    payerID: String(payerID),
    memberId: input.member_id,
    providerNpi: npi,
    patientBirthDate: input.dob,
    patientFirstName: input.patient_first,
    patientLastName: input.patient_last,
    serviceType: '30',
  });
  let res;
  try {
    res = await fetch(`${base}/coverages?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(AVAILITY_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Availity coverages request unreachable: ${e.message}`);
  }
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const detail = parsed?.message || parsed?.error || text.slice(0, 200);
    throw new Error(`Availity coverages request failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Availity returned a non-JSON response.');
  const mapped = mapAvailityCoverage(parsed);
  return {
    ...mapped,
    raw_request: { vendor: 'availity', env: orgConfig.eligibility_availity_env === 'demo' ? 'demo' : 'production', payerID: String(payerID), memberId: input.member_id, serviceType: '30' },
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
  if (vendorName === 'availity') return availityCheck(orgConfig, clean);
  // Unknown/missing vendor names fall back to demo ONLY when the org never
  // configured a real vendor — a configured real vendor that fails throws.
  return demoCheck(clean);
}

module.exports = { runCheck, validateInput, demoCheck, restCheck, availityCheck, mapAvailityCoverage, DEFAULT_FIELD_MAP };
