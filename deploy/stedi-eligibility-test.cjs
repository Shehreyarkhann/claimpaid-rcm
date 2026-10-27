// Deploy #74 test: Stedi eligibility vendor (Phase 1).
// Unit-level, no network: global.fetch is stubbed for the stediCheck paths.
//  (a) the REAL captured Stedi test-mode 271 (golden fixture: a CMS response
//      carrying AAA 72) maps to coverage_active 0 with the AAA error surfaced
//  (b) the request builder emits Stedi's shape: YYYYMMDD dob, serviceTypeCodes
//      ["30"], controlNumber, tradingPartnerServiceId from the org payer map
//  (c) AAA mapping: 42/79/80 are the non-billable payer-down class, 75
//      (subscriber not found) is a completed check; test mode is never billable
//  (d) payer resolution falls back to the Payers API (exact displayName match)
//      and caches; an absent STEDI_API_KEY reports unconfigured, never demo data
// Run: node deploy/stedi-eligibility-test.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const vendors = require('../server/src/eligibility/vendors');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); }
}

const GOLDEN = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'claimpilot', 'fixtures', 'stedi-eligibility-cms-test-271.json'), 'utf8'));

// Synthetic ACTIVE 271 in Stedi's documented JSON shape (EB codes: 1 active,
// C deductible, B co-payment, G out-of-pocket, A co-insurance).
const ACTIVE = {
  payer: { name: 'UnitedHealthcare' },
  subscriber: {
    memberId: 'UHC123456', firstName: 'JOHN', lastName: 'SMITH',
    benefitsInformation: [
      { code: '1', name: 'Active Coverage', insuranceTypeCode: 'PP', insuranceType: 'Preferred Provider Organization (PPO)', planCoverageDescription: 'UHC Choice Plus', serviceTypeCodes: ['30'], benefitsAdditionalInformation: { groupNumber: 'GRP-7781' }, benefitsDateInformation: { benefitBegin: '20260101', benefitEnd: '20261231' } },
      { code: 'C', name: 'Deductible', serviceTypeCodes: ['30'], benefitAmount: '1500' },
      { code: 'C', name: 'Deductible', serviceTypeCodes: ['30'], planCoverageDescription: 'Deductible Remaining', benefitAmount: '425.50' },
      { code: 'B', name: 'Co-Payment', serviceTypeCodes: ['30'], planCoverageDescription: 'Primary Care Office Visit', benefitAmount: '30' },
      { code: 'B', name: 'Co-Payment', serviceTypeCodes: ['30'], planCoverageDescription: 'Specialist Office Visit', benefitAmount: '75' },
      { code: 'G', name: 'Out of Pocket (Stop Loss)', serviceTypeCodes: ['30'], benefitAmount: '4500' },
      { code: 'A', name: 'Co-Insurance', serviceTypeCodes: ['30'], benefitPercent: '0.20' },
    ],
  },
};

const ORG = { org_id: 42, org_name: 'ACME HEALTH', billing_npi: '1999999984', eligibility_availity_payer_map: JSON.stringify({ CMS: 'CMS', Aetna: '60054' }) };
const INPUT = { patient_first: 'JANE', patient_last: 'DOE', dob: '1950-01-01', member_id: '1EG4TE5MK73', payer: 'CMS', date_of_service: '2026-10-27' };

function jsonRes(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) };
}

async function withEnv(key, fn) {
  const prevKey = process.env.STEDI_API_KEY;
  const prevFetch = global.fetch;
  const prevLog = console.log;
  const lines = [];
  if (key === null) delete process.env.STEDI_API_KEY; else process.env.STEDI_API_KEY = key;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    global.fetch = prevFetch;
    console.log = prevLog;
    if (prevKey === undefined) delete process.env.STEDI_API_KEY; else process.env.STEDI_API_KEY = prevKey;
  }
}

function stediLog(lines) {
  const line = lines.find((l) => l.startsWith('[stedi] '));
  return line ? JSON.parse(line.slice('[stedi] '.length)) : null;
}

(async () => {
  // (a) golden fixture -> mapper
  const gm = vendors.mapStediCoverage(GOLDEN);
  check('golden (AAA 72): coverage_active 0', gm.coverage_active === 0, gm);
  check('golden (AAA 72): no plan/cost fields invented', gm.plan_name === null && gm.deductible_individual === null && gm.copay_primary === null, gm);
  const gErr = vendors.collectStediAaaErrors(GOLDEN);
  check('golden: AAA errors collected from top level + subscriber', gErr.length >= 1 && gErr[0].code === '72', gErr);

  // active synthetic -> mapper
  const am = vendors.mapStediCoverage(ACTIVE);
  check('active: coverage_active 1', am.coverage_active === 1, am);
  check('active: plan_name', am.plan_name === 'UHC Choice Plus', am);
  check('active: plan_type', am.plan_type === 'Preferred Provider Organization (PPO)', am);
  check('active: group_number', am.group_number === 'GRP-7781', am);
  check('active: deductible_individual 1500', am.deductible_individual === 1500, am);
  check('active: deductible_remaining 425.5', am.deductible_remaining === 425.5, am);
  check('active: copay_primary 30 / specialist 75', am.copay_primary === 30 && am.copay_specialist === 75, am);
  check('active: oop_max 4500', am.oop_max === 4500, am);
  check('active: dates YYYYMMDD -> ISO', am.effective_date === '2026-01-01' && am.term_date === '2026-12-31', am);
  const inact = vendors.mapStediCoverage({ subscriber: { benefitsInformation: [{ code: '6', name: 'Inactive', serviceTypeCodes: ['30'] }] } });
  check('inactive (EB 6): coverage_active 0', inact.coverage_active === 0, inact);

  // (b) request builder
  const body = vendors.buildStediRequest(ORG, INPUT, 'CMS');
  check('builder: dob YYYYMMDD', body.subscriber.dateOfBirth === '19500101', body);
  check('builder: serviceTypeCodes ["30"]', JSON.stringify(body.encounter.serviceTypeCodes) === '["30"]', body);
  check('builder: tradingPartnerServiceId + controlNumber', body.tradingPartnerServiceId === 'CMS' && /^\d{9}$/.test(body.controlNumber), body);
  check('builder: provider org + npi, patient as subscriber', body.provider.organizationName === 'ACME HEALTH' && body.provider.npi === '1999999984' && body.subscriber.memberId === '1EG4TE5MK73' && !body.dependents, body);

  // (a)+(b) end to end through stediCheck with the golden fixture as the reply
  let seenReq = null;
  const run1 = await withEnv('test_unit-key-123', async () => {
    global.fetch = async (url, opts) => { seenReq = { url, opts }; return jsonRes(GOLDEN); };
    return vendors.stediCheck(ORG, INPUT);
  });
  check('stediCheck golden: coverage_active 0, AAA 72 in raw_response', run1.result.coverage_active === 0 && run1.result.raw_response.aaa_errors[0]?.code === '72', run1.result.raw_response);
  check('stediCheck golden: org-map payer resolution recorded', run1.result.raw_request.tradingPartnerServiceId === 'CMS' && run1.result.raw_request.payer_resolution === 'org_map', run1.result.raw_request);
  check('stediCheck: POSTs the v3 endpoint with the RAW key in Authorization', seenReq.url.includes('/change/medicalnetwork/eligibility/v3') && seenReq.opts.headers.Authorization === 'test_unit-key-123', seenReq?.opts?.headers);
  const sentBody = JSON.parse(seenReq.opts.body);
  check('stediCheck: wire body matches builder shape', sentBody.subscriber.dateOfBirth === '19500101' && sentBody.tradingPartnerServiceId === 'CMS' && /^\d{9}$/.test(sentBody.controlNumber), sentBody);
  const log1 = stediLog(run1.lines);
  check('metering: test mode logged billable=false with org + payer', !!log1 && log1.billable === false && log1.mode === 'test' && log1.org_id === 42 && log1.payer === 'CMS', log1);

  // (d) Payers API fallback resolution + cache (production-mode key)
  vendors._stediPayerCache.clear();
  let payerCalls = 0;
  const run2 = await withEnv('unit-prod-key', async () => {
    global.fetch = async (url) => {
      if (String(url).includes('/payers/search')) {
        payerCalls++;
        return jsonRes({ items: [
          { payer: { displayName: 'Cigna Health', primaryPayerId: '99999', stediId: 'XXXXX' } },
          { payer: { displayName: 'Cigna', primaryPayerId: '62308', stediId: 'CIGNA1' } },
        ] });
      }
      return jsonRes(ACTIVE);
    };
    const cfg = { ...ORG, eligibility_availity_payer_map: '{}' };
    const inp = { ...INPUT, payer: 'Cigna' };
    const first = await vendors.stediCheck(cfg, inp);
    const second = await vendors.stediCheck(cfg, inp);
    return { first, second };
  });
  check('resolution: exact displayName match wins over fuzzy first hit', run2.result.first.raw_request.tradingPartnerServiceId === '62308', run2.result.first.raw_request);
  check('resolution: second check served from cache (1 Payers API call)', payerCalls === 1 && run2.result.second.raw_request.payer_resolution === 'payers_api_cache', { payerCalls, src: run2.result.second.raw_request.payer_resolution });
  check('resolution path maps active coverage', run2.result.first.coverage_active === 1, run2.result.first);

  // (c) AAA classes in production mode
  const run3 = await withEnv('unit-prod-key', async () => {
    global.fetch = async () => jsonRes({ errors: [{ field: 'AAA', code: '42', description: 'Payer system unavailable' }] });
    return vendors.stediCheck(ORG, { ...INPUT, payer: 'Aetna' });
  });
  const log3 = stediLog(run3.lines);
  check('AAA 42 (payer down): result not thrown, coverage 0, billable=false in production', run3.result.coverage_active === 0 && !!log3 && log3.billable === false && log3.mode === 'production', { r: run3.result.coverage_active, log3 });
  const run4 = await withEnv('unit-prod-key', async () => {
    global.fetch = async () => jsonRes({ subscriber: { aaaErrors: [{ field: 'AAA', code: '75', description: 'Subscriber not found' }] } });
    return vendors.stediCheck(ORG, { ...INPUT, payer: 'Aetna' });
  });
  const log4 = stediLog(run4.lines);
  check('AAA 75 (not found): coverage 0 but billable=true in production', run4.result.coverage_active === 0 && run4.result.raw_response.aaa_errors[0]?.code === '75' && !!log4 && log4.billable === true, { log4 });

  // (d) unconfigured: no env key -> precise error, never synthetic data
  let unconfErr = null;
  await withEnv(null, async () => {
    try { await vendors.stediCheck(ORG, INPUT); } catch (e) { unconfErr = e; }
  });
  check('unconfigured: throws STEDI_API_KEY error', !!unconfErr && /STEDI_API_KEY/.test(unconfErr.message), unconfErr?.message);

  // unreachable vendor -> clean thrown error (route turns it into a 502)
  let unreachErr = null;
  await withEnv('test_unit-key-123', async () => {
    global.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
    try { await vendors.stediCheck(ORG, INPUT); } catch (e) { unreachErr = e; }
  });
  check('unreachable: clean "unreachable" error', !!unreachErr && /unreachable/i.test(unreachErr.message), unreachErr?.message);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR', e); process.exit(1); });
