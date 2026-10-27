// Pluggable eligibility vendor layer (270/271-style real-time checks).
//
// Honest architecture: a real 270/271 check requires a clearinghouse/vendor
// account (pVerify, Eligible, Availity, Change Healthcare) PLUS payer enrollment
// for each payer you check against. Until the org configures one, everything
// runs through the org's configured vendor (Availity or a generic REST
// endpoint). There is no demo vendor: an unconfigured org gets a clear
// error instead of synthetic data (removed at market launch, deploy #52).
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
// confirmed live 2026-10-24), and /demo/v1 on the same host 404s (also
// confirmed live). Availity's own docs point demo/test traffic at two
// other hosts, so both are first-class options:
//   test: https://tst.api.availity.com/v1        (Getting Started: test token URL)
//   qa:   https://qua.api.availity.com/availity/v1 (QUA developer docs)
const AVAILITY_BASES = {
  production: 'https://api.availity.com/availity/v1',
  'demo-tst': 'https://tst.api.availity.com/v1',
  'demo-qua': 'https://qua.api.availity.com/availity/v1',
};
const AVAILITY_TIMEOUT_MS = 30000;
const tokenCache = new Map(); // `${base}|${client_id}` -> { token, expiresAt }

function availityBase(orgConfig) {
  const env = orgConfig.eligibility_availity_env;
  if (env === 'demo') return AVAILITY_BASES['demo-tst']; // legacy stored value
  return AVAILITY_BASES[env] || AVAILITY_BASES.production;
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
    if (base === AVAILITY_BASES.production) throw e;
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
    raw_request: { vendor: 'availity', env: orgConfig.eligibility_availity_env || 'production', payerID: String(payerID), memberId: input.member_id, serviceType: '30' },
    raw_response: { demo: false, http_status: res.status, vendor_body: parsed },
  };
}

// ---- stedi vendor -------------------------------------------------------------
// Real eligibility via Stedi, the API-first clearinghouse (Phase 1 of the
// Stedi integration — see claimpilot/stedi-integration-scope-2026-10-27.md).
//   Check:  POST https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/eligibility/v3
//           header Authorization: <api key, raw, no prefix>
//           body: { controlNumber, tradingPartnerServiceId,
//                   provider { organizationName, npi },
//                   subscriber { memberId, firstName, lastName, dateOfBirth YYYYMMDD },
//                   encounter { serviceTypeCodes: ["30"] } }
//           -> synchronous JSON 271 (subscriber.benefitsInformation, AAA errors)
//   Payers: GET  https://healthcare.us.stedi.com/2024-04-01/payers/search?name=<name>
//           -> payer records { stediId, primaryPayerId, displayName, aliases }
// Unlike Availity (per-org OAuth app in the DB), Stedi is a PLATFORM account:
// the API key lives only in the server env (STEDI_API_KEY), never in org rows,
// never in any settings payload. A key starting with "test_" is test mode
// (Stedi's own convention) and reaches mock payers only.
// Content-level payer rejections (AAA segments) come back as a mapped result
// with coverage_active 0 — same semantics as an Availity "no coverage found";
// transport/HTTP failures throw precise errors, exactly like the other vendors.

const STEDI_ELIGIBILITY_URL = 'https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/eligibility/v3';
const STEDI_PAYERS_URL = 'https://healthcare.us.stedi.com/2024-04-01/payers/search';
const STEDI_TIMEOUT_MS = 30000;
const STEDI_PAYER_CACHE_TTL_MS = 6 * 3600 * 1000;
// AAA codes Stedi does not bill for (payer-down class). 75 = subscriber not
// found is still a completed (billable in production) transaction.
const STEDI_NON_BILLABLE_AAA = ['42', '79', '80'];
const stediPayerCache = new Map(); // lowercase payer name -> { id, stediId, displayName, expiresAt }

function stediApiKey() {
  return (process.env.STEDI_API_KEY || '').trim();
}

function fmtDate8(v) {
  const s = String(v || '');
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}

// AAA errors can appear at the top level, on the subscriber, or on dependents.
function collectStediAaaErrors(parsed) {
  const out = [];
  const push = (list) => {
    if (!Array.isArray(list)) return;
    for (const e of list) {
      if (e && e.code) out.push({ code: String(e.code), description: e.description || null, followup_action: e.followupAction || null });
    }
  };
  push(parsed?.errors);
  push(parsed?.subscriber?.aaaErrors);
  if (Array.isArray(parsed?.dependents)) for (const d of parsed.dependents) push(d?.aaaErrors);
  return out;
}

function stediBenefitEntries(parsed) {
  const lists = [
    parsed?.subscriber?.benefitsInformation,
    ...(Array.isArray(parsed?.dependents) ? parsed.dependents.map((d) => d?.benefitsInformation) : []),
    parsed?.benefitsInformation,
  ];
  for (const l of lists) if (Array.isArray(l) && l.length) return l;
  return [];
}

function stediEntryText(e) {
  const msgs = Array.isArray(e?.messages) ? e.messages.map((m) => (typeof m === 'string' ? m : m?.message || '')).join(' ') : '';
  return [e?.name, e?.codeName, e?.planCoverageDescription, e?.serviceTypes, msgs].flat().filter(Boolean).join(' ');
}

// The 271 JSON nests benefit data under the subscriber (or a dependent).
// Extract defensively and ALWAYS keep the full body in raw_response.
function mapStediCoverage(parsed) {
  const out = {
    coverage_active: 0, plan_name: null, plan_type: null, group_number: null,
    copay_primary: null, copay_specialist: null,
    deductible_individual: null, deductible_remaining: null,
    oop_max: null, effective_date: null, term_date: null,
  };
  const entries = stediBenefitEntries(parsed);
  if (!entries.length) return out;
  const active = entries.find((e) => String(e?.code) === '1');
  if (active) out.coverage_active = 1;
  const src = active || entries[0];
  out.plan_name = pickField(src, ['planCoverageDescription', 'planName', 'name', 'coverageName']) || pickField(parsed?.payer, ['name']);
  out.plan_type = pickField(src, ['insuranceType', 'insuranceTypeCode', 'planType']);
  for (const e of entries) {
    const addl = e?.benefitsAdditionalInformation || {};
    const g = pickField(addl, ['groupNumber', 'groupId', 'groupPolicyNumber']) || pickField(e, ['groupNumber']);
    if (g && out.group_number === null) out.group_number = String(g);
    const dates = e?.benefitsDateInformation || {};
    if (out.effective_date === null) out.effective_date = fmtDate8(dates.benefitBegin || dates.eligibilityBegin || dates.benefitBeginDate);
    if (out.term_date === null) out.term_date = fmtDate8(dates.benefitEnd || dates.eligibilityEnd || dates.benefitEndDate);
  }
  if (out.group_number === null) out.group_number = pickField(parsed?.planInformation, ['groupNumber', 'groupId']);
  for (const e of entries) {
    const code = String(e?.code || '');
    const amt = numOrNull(e?.benefitAmount);
    const text = stediEntryText(e);
    const svc = Array.isArray(e?.serviceTypeCodes) ? e.serviceTypeCodes.map(String) : [];
    if (code === 'C' && amt !== null) { // Deductible
      if (/remain/i.test(text)) { if (out.deductible_remaining === null) out.deductible_remaining = amt; }
      else if (out.deductible_individual === null && (svc.includes('30') || svc.length === 0 || out.deductible_individual === null)) out.deductible_individual = amt;
    }
    if (code === 'B' && amt !== null) { // Co-Payment
      if (/special/i.test(text)) { if (out.copay_specialist === null) out.copay_specialist = amt; }
      else if (/primary|pcp|office/i.test(text)) { if (out.copay_primary === null) out.copay_primary = amt; }
      else if (out.copay_primary === null && (svc.includes('30') || svc.length === 0)) out.copay_primary = amt;
    }
    if (code === 'G' && amt !== null && out.oop_max === null) out.oop_max = amt; // Out of Pocket (Stop Loss)
    if (code === 'F' && amt !== null && out.oop_max === null && /out of pocket|stop loss/i.test(text)) out.oop_max = amt;
  }
  return out;
}

// Payer ID resolution: the org's stored payer map carries the standard payer
// ID family Stedi's tradingPartnerServiceId uses (their docs use 87726 for
// UHC — the same IDs orgs already store for Availity). When the map has no
// entry, resolve by name through the Payers API — exact displayName match
// only, never a fuzzy guess — and cache the result in memory.
async function resolveStediPayerId(orgConfig, payerName, apiKey) {
  let payerMap = {};
  try { payerMap = JSON.parse(orgConfig.eligibility_availity_payer_map || '{}') || {}; } catch { payerMap = {}; }
  if (payerMap[payerName]) return { tradingPartnerServiceId: String(payerMap[payerName]), source: 'org_map' };
  const cacheKey = String(payerName || '').toLowerCase();
  const cached = stediPayerCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { tradingPartnerServiceId: cached.id, source: 'payers_api_cache', stediId: cached.stediId };
  let res;
  try {
    res = await fetch(`${STEDI_PAYERS_URL}?name=${encodeURIComponent(payerName)}`, {
      headers: { Authorization: apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(STEDI_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Stedi payer lookup unreachable: ${e.message}`);
  }
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const detail = parsed?.message || parsed?.error || text.slice(0, 200);
    throw new Error(`Stedi payer lookup failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
  }
  const items = Array.isArray(parsed?.items) ? parsed.items : (Array.isArray(parsed) ? parsed : []);
  const match = items.find((it) => String(it?.payer?.displayName || it?.displayName || '').toLowerCase() === cacheKey);
  const rec = match?.payer || match;
  const primaryId = rec?.primaryPayerId ? String(rec.primaryPayerId) : null;
  if (!primaryId) {
    throw new Error(`Could not resolve a Stedi payer ID for "${payerName}" — add the standard payer ID for this payer in Eligibility settings (payer map) and try again.`);
  }
  stediPayerCache.set(cacheKey, { id: primaryId, stediId: rec?.stediId || null, displayName: rec?.displayName || payerName, expiresAt: Date.now() + STEDI_PAYER_CACHE_TTL_MS });
  return { tradingPartnerServiceId: primaryId, source: 'payers_api', stediId: rec?.stediId || null };
}

function buildStediRequest(orgConfig, input, tradingPartnerServiceId) {
  return {
    controlNumber: String(crypto.randomInt(100000000, 1000000000)),
    tradingPartnerServiceId: String(tradingPartnerServiceId),
    provider: {
      organizationName: orgConfig.org_name || '',
      npi: (orgConfig.billing_npi || '').trim(),
    },
    // Our eligibility input models the patient as the member (same as the
    // Availity vendor), so the patient goes in `subscriber`, not dependents.
    subscriber: {
      memberId: input.member_id,
      firstName: input.patient_first,
      lastName: input.patient_last,
      dateOfBirth: String(input.dob || '').replace(/-/g, ''),
    },
    encounter: { serviceTypeCodes: ['30'] },
  };
}

async function stediCheck(orgConfig, input) {
  const apiKey = stediApiKey();
  if (!apiKey) {
    throw new Error('Stedi is not configured — the STEDI_API_KEY server environment variable is not set. Add it to the server environment, then select Stedi as the eligibility vendor.');
  }
  const npi = (orgConfig.billing_npi || '').trim();
  if (!/^\d{10}$/.test(npi)) {
    throw new Error('Stedi checks need your 10-digit billing NPI — set it in Organization / EDI settings first.');
  }
  const testMode = apiKey.startsWith('test_');
  const resolution = await resolveStediPayerId(orgConfig, input.payer, apiKey);
  const body = buildStediRequest(orgConfig, input, resolution.tradingPartnerServiceId);
  let res;
  try {
    res = await fetch(STEDI_ELIGIBILITY_URL, {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(STEDI_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Stedi eligibility request unreachable: ${e.message}`);
  }
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const detail = parsed?.message || parsed?.error || text.slice(0, 200);
    throw new Error(`Stedi eligibility request failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Stedi returned a non-JSON response.');
  const aaaErrors = collectStediAaaErrors(parsed);
  const mapped = mapStediCoverage(parsed);
  // Usage metering (Phase 0 hook): one structured line per completed check.
  // Stedi does not bill test-mode checks or AAA 42/79/80 (payer-down) failures;
  // the billable flag mirrors that so the future allowance system has the data.
  const billable = !testMode && !aaaErrors.some((e) => STEDI_NON_BILLABLE_AAA.includes(e.code));
  console.log('[stedi] ' + JSON.stringify({
    event: 'eligibility_check', vendor: 'stedi',
    org_id: orgConfig.org_id ?? null, payer: input.payer,
    trading_partner_service_id: resolution.tradingPartnerServiceId,
    mode: testMode ? 'test' : 'production', billable,
    aaa_codes: aaaErrors.map((e) => e.code),
  }));
  return {
    ...mapped,
    raw_request: { vendor: 'stedi', mode: testMode ? 'test' : 'production', tradingPartnerServiceId: resolution.tradingPartnerServiceId, payer_resolution: resolution.source, body },
    raw_response: { demo: false, http_status: res.status, test_mode: testMode, aaa_errors: aaaErrors, vendor_body: parsed },
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
  if (vendorName === 'stedi') return stediCheck(orgConfig, clean);
  // No demo fallback (removed at market launch, deploy #52): an unconfigured
  // org gets a clear error, never synthetic data.
  const e = new Error('No eligibility vendor configured — connect Availity, Stedi, or a REST endpoint in Organization settings.');
  e.status = 400;
  throw e;
}

module.exports = { runCheck, validateInput, restCheck, availityCheck, mapAvailityCoverage, stediCheck, mapStediCoverage, buildStediRequest, resolveStediPayerId, collectStediAaaErrors, _stediPayerCache: stediPayerCache, DEFAULT_FIELD_MAP };
