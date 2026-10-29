#!/usr/bin/env node
/**
 * appeal-letter-smoke.cjs — jsdom render check for Deploy #98.
 *
 * Mocks an org with ONE open appeal that carries a saved letter (the
 * post-#98 shape) and asserts the founder-visible outcomes:
 *   - the appeals list marks it "📝 Drafted — not submitted"
 *   - the appeal drawer shows a document-style LETTER PANEL with that
 *     treatment + Edit letter / Print letter / Mark as submitted
 *   - the letter body renders EXACTLY ONCE on the page (it must not
 *     also sit in the notes timeline as a comment bubble)
 *   - "Claim details" opens the shared ClaimDetailsModal with patient
 *     DOB + member ID, the ERA denial adjustment chip (CO-50), the ERA
 *     check number, and the linked appeal's drafted state
 *   - Mark as submitted posts and the panel flips to "Submitted via …"
 *
 * Usage: node deploy/appeal-letter-smoke.cjs [dist-dir]  (default client/dist)
 * Exit 0 = PASS, 1 = FAIL.
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const distDir = process.argv[2] || path.join(__dirname, '..', 'client', 'dist');
const BASE = '/app/';

function fail(reason) { console.log('APPEAL LETTER SMOKE: FAIL — ' + reason); process.exit(1); }
function pass(detail) { console.log('APPEAL LETTER SMOKE: PASS — ' + detail); process.exit(0); }

const indexHtml = path.join(distDir, 'index.html');
if (!fs.existsSync(indexHtml)) fail(`dist/index.html not found at ${indexHtml} — build first`);
const html = fs.readFileSync(indexHtml, 'utf8');
const entryMatch = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"|<script[^>]*src="([^"]+)"[^>]*type="module"/);
const entrySrc = entryMatch && (entryMatch[1] || entryMatch[2]);
if (!entrySrc) fail('no module script entry found in index.html');
const entryPath = path.join(distDir, entrySrc.slice(BASE.length));
if (!fs.existsSync(entryPath)) fail('entry bundle missing on disk: ' + entrySrc);
const bundle = fs.readFileSync(entryPath, 'utf8');

const fakeUser = { id: 1, org_id: 1, email: 'gate@smoke.local', name: 'Gate User', role: 'owner', orgName: 'Gate Test Co.' };
const LETTER = [
  'October 29, 2026', '',
  'Gate Test Co.', '',
  'Re: Formal Appeal — Denied Claim HV-2001', 'Patient: Dana Draft', '',
  'Dear Appeals Reviewer:', '',
  'UNIQUE-LETTER-SENTENCE: we formally appeal this denial because the enclosed clinical documentation demonstrates medical necessity for every billed unit, and the cited reason does not reflect the treating record for this patient on the date of service in question.',
  '',
  'Sincerely,', 'Gate Test Co.',
].join('\n');

const appealRow = {
  id: 55, status: 'open', priority: 'high', follow_up_date: null, updated_at: '2026-10-28 10:00:00',
  submitted_via: null, submitted_at: null, has_letter: 1,
  claim_number: 'HV-2001', patient_name: 'Dana Draft', payer: 'Aetna',
  billed_amount: 640, paid_amount: 0, denial_reason: 'CO-50 not medically necessary',
  at_stake: 640, assignee_name: null, note_count: 1,
};
let submitted = false;
const appealDetail = () => ({
  id: 55, claim_id: 77, status: submitted ? 'submitted' : 'open', priority: 'high', angle: 'medical_necessity',
  follow_up_date: submitted ? '2026-11-08' : null, payer_response: null,
  submitted_via: submitted ? 'payer_portal' : null, submitted_at: submitted ? '2026-10-29 09:00:00' : null,
  has_letter: 1, letter: LETTER,
  claim_number: 'HV-2001', patient_name: 'Dana Draft', patient_dob: '1980-04-02', member_id: 'MBR-123',
  payer: 'Aetna', service_date: '2026-10-01', billed_amount: 640, paid_amount: 0,
  denial_reason: 'CO-50 not medically necessary', cpt_codes: '97110', icd_codes: 'M54.5',
  assignee_name: null, assigned_to: null,
  notes: [{ id: 1, note: 'Appeal draft saved via agent approval — the letter is in the letter panel.', author: 'Gate User', created_at: '2026-10-28 10:00:00' }],
  linked_auths: [],
});
const claimDetail = {
  id: 77, claim_number: 'HV-2001', patient_name: 'Dana Draft', patient_dob: '1980-04-02', member_id: 'MBR-123',
  payer_name: 'Aetna', payer_type: 'commercial', service_date: '2026-10-01', status: 'denied',
  billed_amount: 640, allowed_amount: 512, paid_amount: 0, adjustment_amount: 128,
  patient_resp_amount: 0, patient_paid_amount: 0,
  denial_reason: 'CO-50 not medically necessary', cpt_codes: '97110,97140', icd_codes: 'M54.5',
  rendering_provider: 'Dr. Test', rendering_npi: '1234567890', payer_icn: 'ICN1', days_in_ar: 28,
  filing_deadline: '2026-12-30', days_until_filing: 62,
  appeals: [{ id: 55, status: 'open', priority: 'high', has_letter: 1, submitted_via: null, submitted_at: null, follow_up_date: null, assignee_name: null, updated_at: '2026-10-28 10:00:00' }],
  era_lines: [{ id: 9, clp_ref: 'HV-2001', paid: 0, billed: 640, post_status: 'pending', adjustments: [{ group: 'CO', code: '50', amount: 128 }], check_number: 'CHK-L1', pay_date: '2026-10-20', era_payer: 'Aetna' }],
  activity: [],
};

const ok = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const fakeFetch = (url, options) => {
  const u = String(url);
  const method = (options && options.method) || 'GET';
  if (u.includes('/api/appeals/55/mark-submitted') && method === 'POST') { submitted = true; return ok(appealDetail()); }
  if (u.includes('/api/appeals/55')) return ok(appealDetail());
  if (u.includes('/api/appeals/unworked-denials')) return ok({ claims: [] });
  if (u.includes('/api/appeals/due')) return ok([]);
  if (u.includes('/api/appeals')) return ok([appealRow]);
  if (u.includes('/api/claims/77')) return ok(claimDetail);
  if (u.includes('/api/auth/team')) return ok([]);
  if (u.includes('/api/authz/find-for-claim')) return ok({ matches: [] });
  if (u.includes('/api/auth/me')) return ok(fakeUser);
  if (u.includes('/api/auth/orgs')) return ok([{ id: 1, name: 'Gate Test Co.', role: 'owner' }]);
  if (u.includes('/api/billing/status')) return ok({ plan: 'pro', plan_status: 'active', products: { rcm: true, ai: true }, access: 'full' });
  if (u.includes('/api/onboarding/status')) return ok({ needed: false });
  if (u.includes('/api/authz/stats')) return ok({ expiringSoon: 0, expiredUnhandled: 0, byStatus: {} });
  if (u.includes('/api/worklist')) return ok({ items: [], summary: { total: 0, totalAtStake: 0 } });
  return ok([]);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 9000, label = 'condition') {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(250);
  }
}

function makeDom() {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
    { url: 'https://claimpaid.io' + BASE, runScripts: 'outside-only', pretendToBeVisual: true }
  );
  for (const k of ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history']) {
    global[k] = dom.window[k];
  }
  dom.window.matchMedia = dom.window.matchMedia || (() => ({ matches: false, addListener: () => {}, removeListener: () => {} }));
  if (!dom.window.ResizeObserver) {
    dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  }
  global.ResizeObserver = dom.window.ResizeObserver;
  const errs = [];
  dom.window.console.error = (...a) => { errs.push(a.map((x) => String(x).slice(0, 150)).join(' ')); };
  return { dom, errs };
}

const click = (dom, el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

(async () => {
  try {
    const { dom, errs } = makeDom();
    dom.window.localStorage.setItem('pulse_token', 'fake-token');
    global.fetch = fakeFetch;
    dom.window.fetch = fakeFetch;
    dom.window.eval(bundle);
    const doc = dom.window.document;

    await until(() => doc.getElementById('root').childElementCount > 0 && doc.body.textContent.includes('My Work'), 9000, 'logged-in shell');
    const tab = await until(() => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Denial Appeals'), 9000, 'Denial Appeals tab');
    click(dom, tab);
    await until(() => doc.body.textContent.includes('HV-2001'), 9000, 'appeals list row');

    if (!doc.body.textContent.includes('📝 Drafted — not submitted')) fail('appeals list should mark the lettered open appeal as drafted — not submitted');
    console.log('  PASS list marks the appeal "📝 Drafted — not submitted"');

    const row = [...doc.querySelectorAll('tr')].find((tr) => tr.textContent.includes('HV-2001'));
    click(dom, row);
    await until(() => doc.body.textContent.includes('Saved on this appeal'), 9000, 'letter panel');
    if (!doc.body.textContent.includes('Appeal drafted — not submitted')) fail('drawer letter panel drafted treatment missing');
    for (const label of ['Edit letter', 'Print letter', 'Mark as submitted']) {
      if (![...doc.querySelectorAll('button')].some((b) => b.textContent.trim() === label)) fail(`letter action missing: ${label}`);
    }
    const letterOccurrences = (doc.body.textContent.match(/UNIQUE-LETTER-SENTENCE/g) || []).length;
    if (letterOccurrences !== 1) fail(`letter body should render exactly once (panel only, never a note bubble), saw ${letterOccurrences}`);
    console.log('  PASS letter panel: drafted treatment + Edit/Print/Mark-submitted; letter renders exactly once, not as a note');

    // Claim details modal from the drawer.
    const detailsBtn = await until(() => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Claim details'), 9000, 'Claim details button');
    click(dom, detailsBtn);
    await until(() => doc.body.textContent.includes('Filing deadline'), 9000, 'claim details modal');
    for (const needle of ['04/02/1980', 'MBR-123', 'CO-50', 'CHK-L1', 'Drafted — not submitted', 'Dr. Test']) {
      if (!doc.body.textContent.includes(needle)) fail(`claim details modal missing: ${needle}`);
    }
    console.log('  PASS ClaimDetailsModal: DOB, member ID, CO-50 chip, ERA check, appeal drafted state, provider');
    const doneBtn = [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Done');
    click(dom, doneBtn);
    await until(() => !doc.body.textContent.includes('Filing deadline'), 9000, 'modal closed');

    // Mark as submitted flips the panel treatment.
    const markBtn = [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Mark as submitted');
    click(dom, markBtn);
    const recordBtn = await until(() => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Record submission'), 9000, 'mark-submitted form');
    click(dom, recordBtn);
    await until(() => doc.body.textContent.includes('Submitted via Payer portal'), 9000, 'submitted treatment');
    console.log('  PASS mark-as-submitted records and the panel shows "Submitted via Payer portal"');

    if (errs.length) fail('React errors during render: ' + errs.slice(0, 3).join(' || ').slice(0, 400));
    pass('Denials letter panel + ClaimDetailsModal render and act correctly from mocked APIs');
  } catch (e) {
    fail(e.message);
  }
})();
