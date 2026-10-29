#!/usr/bin/env node
/**
 * appeal-letter-save-smoke.cjs — jsdom render check for Deploy #99.
 *
 * The Denials drawer's manually GENERATED letter used to be transient
 * (copy/print only). This smoke mocks an appeal with NO saved letter
 * and walks the founder-visible flow:
 *   1. Generate -> "Save to appeal letter" appears on the draft
 *   2. Save -> exactly one PUT /api/appeals/:id/letter with the
 *      generated text; the #98 letter panel appears ("Appeal drafted —
 *      not submitted") and the generated area shows its saved state
 *   3. Generate a SECOND draft -> Save -> the overwrite confirm
 *      appears and NO PUT fires yet
 *   4. "Replace saved letter" -> the PUT fires with the new text and
 *      the saved panel now carries the second draft
 *
 * Usage: node deploy/appeal-letter-save-smoke.cjs [dist-dir]  (default client/dist)
 * Exit 0 = PASS, 1 = FAIL.
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const distDir = process.argv[2] || path.join(__dirname, '..', 'client', 'dist');
const BASE = '/app/';

function fail(reason) { console.log('APPEAL LETTER SAVE SMOKE: FAIL — ' + reason); process.exit(1); }
function pass(detail) { console.log('APPEAL LETTER SAVE SMOKE: PASS — ' + detail); process.exit(0); }

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
const mkGen = (tag) => [
  'October 29, 2026', '',
  'Re: Formal Appeal — Denied Claim HV-2001', 'Patient: Dana Draft', '',
  'Dear Appeals Reviewer:', '',
  `${tag}: this generated draft argues medical necessity from the treating record and asks that the denial be overturned and the claim reprocessed and paid in full under the member plan.`,
  '',
  'Sincerely,', 'Gate Test Co.',
].join('\n');
const GEN1 = mkGen('UNIQUE-GEN-ONE');
const GEN2 = mkGen('UNIQUE-GEN-TWO');

let savedLetter = null;
let genCount = 0;
const putCalls = [];
const appealRow = () => ({
  id: 55, status: 'open', priority: 'high', follow_up_date: null, updated_at: '2026-10-28 10:00:00',
  submitted_via: null, submitted_at: null, has_letter: savedLetter ? 1 : 0,
  claim_number: 'HV-2001', patient_name: 'Dana Draft', payer: 'Aetna',
  billed_amount: 640, paid_amount: 0, denial_reason: 'CO-50 not medically necessary',
  at_stake: 640, assignee_name: null, note_count: 1,
});
const appealDetail = () => ({
  id: 55, claim_id: 77, status: 'open', priority: 'high', angle: 'medical_necessity',
  follow_up_date: null, payer_response: null,
  submitted_via: null, submitted_at: null,
  has_letter: savedLetter ? 1 : 0, letter: savedLetter,
  claim_number: 'HV-2001', patient_name: 'Dana Draft', patient_dob: '1980-04-02', member_id: 'MBR-123',
  payer: 'Aetna', service_date: '2026-10-01', billed_amount: 640, paid_amount: 0,
  denial_reason: 'CO-50 not medically necessary', cpt_codes: '97110', icd_codes: 'M54.5',
  assignee_name: null, assigned_to: null,
  notes: [{ id: 1, note: 'Working this one with the payer rep.', author: 'Gate User', created_at: '2026-10-28 10:00:00' }],
  linked_auths: [],
});

const ok = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const fakeFetch = (url, options) => {
  const u = String(url);
  const method = (options && options.method) || 'GET';
  if (u.includes('/api/appeals/55/letter') && method === 'PUT') {
    const body = JSON.parse(options.body || '{}');
    putCalls.push(body.letter);
    savedLetter = body.letter;
    return ok(appealDetail());
  }
  if (u.includes('/api/appeals/55/letter')) {
    genCount++;
    return ok({ subject: 'Appeal letter — HV-2001', text: genCount === 1 ? GEN1 : GEN2 });
  }
  if (u.includes('/api/appeals/55')) return ok(appealDetail());
  if (u.includes('/api/appeals/unworked-denials')) return ok({ claims: [] });
  if (u.includes('/api/appeals/due')) return ok([]);
  if (u.includes('/api/appeals')) return ok([appealRow()]);
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
const btnByText = (doc, text) => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const btnIncluding = (doc, text) => [...doc.querySelectorAll('button')].find((b) => b.textContent.includes(text));

(async () => {
  try {
    const { dom, errs } = makeDom();
    dom.window.localStorage.setItem('pulse_token', 'fake-token');
    global.fetch = fakeFetch;
    dom.window.fetch = fakeFetch;
    dom.window.eval(bundle);
    const doc = dom.window.document;

    await until(() => doc.getElementById('root').childElementCount > 0 && doc.body.textContent.includes('My Work'), 9000, 'logged-in shell');
    const tab = await until(() => btnByText(doc, 'Denial Appeals'), 9000, 'Denial Appeals tab');
    click(dom, tab);
    await until(() => doc.body.textContent.includes('HV-2001'), 9000, 'appeals list row');

    const row = [...doc.querySelectorAll('tr')].find((tr) => tr.textContent.includes('HV-2001'));
    click(dom, row);
    const genBtn = await until(() => btnIncluding(doc, 'Generate appeal letter'), 9000, 'drawer + generate button');
    if (doc.body.textContent.includes('Saved on this appeal')) fail('no saved-letter panel should exist before any save');
    console.log('  PASS drawer opens with no saved letter panel');

    // 1) Generate the first draft and save it (appeal has no letter yet).
    click(dom, genBtn);
    await until(() => doc.body.textContent.includes('UNIQUE-GEN-ONE'), 9000, 'generated draft 1');
    const saveBtn = btnByText(doc, 'Save to appeal letter');
    if (!saveBtn) fail('generated draft shows no "Save to appeal letter" action');
    click(dom, saveBtn);
    await until(() => putCalls.length === 1, 9000, 'PUT fires on save');
    if (putCalls[0] !== GEN1) fail('PUT body is not the generated text');
    await until(() => doc.body.textContent.includes('Saved on this appeal'), 9000, 'letter panel after save');
    if (!doc.body.textContent.includes('Appeal drafted — not submitted')) fail('saved panel drafted treatment missing after save');
    if (!doc.body.textContent.includes('✓ Saved to the appeal letter')) fail('generated area does not reflect the saved state');
    console.log('  PASS save: one PUT with the generated text; letter panel appears drafted; generated area shows saved state');

    // 2) Generate a second draft — saving now must demand confirmation
    //    BEFORE any PUT fires.
    click(dom, btnIncluding(doc, 'Generate appeal letter'));
    await until(() => doc.body.textContent.includes('UNIQUE-GEN-TWO'), 9000, 'generated draft 2');
    const saveBtn2 = btnByText(doc, 'Save to appeal letter');
    if (!saveBtn2) fail('second draft shows no "Save to appeal letter" action');
    click(dom, saveBtn2);
    await until(() => doc.body.textContent.includes('replace the current saved letter'), 9000, 'overwrite confirm');
    if (putCalls.length !== 1) fail(`PUT fired before overwrite confirmation (putCalls=${putCalls.length})`);
    console.log('  PASS overwrite: confirm appears first, no PUT fires before it');

    // 3) Confirm the replace — PUT fires with the new text.
    const replaceBtn = btnByText(doc, 'Replace saved letter');
    if (!replaceBtn) fail('overwrite confirm has no "Replace saved letter" button');
    click(dom, replaceBtn);
    await until(() => putCalls.length === 2, 9000, 'PUT fires on confirm');
    if (putCalls[1] !== GEN2) fail('overwrite PUT body is not the second generated text');
    await until(() => (doc.body.textContent.match(/UNIQUE-GEN-ONE/g) || []).length === 0, 9000, 'saved panel carries draft 2 only');
    if (!doc.body.textContent.includes('✓ Saved to the appeal letter')) fail('generated area lost its saved state after overwrite');
    console.log('  PASS overwrite confirmed: PUT carries draft 2; saved letter replaced; saved state shown');

    if (errs.length) fail('React errors during render: ' + errs.slice(0, 3).join(' || ').slice(0, 400));
    pass('generated letter saves to the appeal (with overwrite confirm) and lands in the #98 letter panel');
  } catch (e) {
    fail(e.message);
  }
})();
