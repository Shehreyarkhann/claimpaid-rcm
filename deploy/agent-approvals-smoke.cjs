#!/usr/bin/env node
/**
 * agent-approvals-smoke.cjs — jsdom render check for Deploy #97.
 *
 * Reproduces the live bug in mock form: the morning brief returns ZERO
 * actions (its dedupe correctly skipped claims that already have pending
 * drafts) while GET /api/agent/actions/pending returns one
 * conversation-less, wizard-proposed card. The card must render — in the
 * "Awaiting your approval" section (#agent-approvals) and nowhere else —
 * the plan row for that claim must read "Draft waiting ↑" instead of
 * offering a duplicate draft, and approving the card flips it to its
 * decided state in place.
 *
 * Usage: node deploy/agent-approvals-smoke.cjs [dist-dir]  (default client/dist)
 * Exit 0 = PASS, 1 = FAIL.
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const distDir = process.argv[2] || path.join(__dirname, '..', 'client', 'dist');
const BASE = '/app/';

function fail(reason) { console.log('AGENT APPROVALS SMOKE: FAIL — ' + reason); process.exit(1); }
function pass(detail) { console.log('AGENT APPROVALS SMOKE: PASS — ' + detail); process.exit(0); }

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
const wizardAction = {
  id: 33, kind: 'draft_appeal', title: 'Draft appeal — claim CLM-9001', status: 'pending',
  preview: 'October 28, 2026\n\nAppeals Department\nAetna\n\nRe: Formal Appeal — Denied Claim CLM-9001\n\nWe are writing to formally appeal the denial of the above-referenced claim.',
  payload: { claim_id: 5, claim_number: 'CLM-9001', payer: 'Aetna', category: 'medical_necessity', subject: 'Appeal of Denied Claim CLM-9001' },
  result: null, created_at: '2026-10-27 15:00:00', decided_at: null, executed_at: null,
};
let wizardApproved = false;

const mocks = [
  // The bug shape: brief proposes NOTHING today (dedupe) and returns no
  // actions — yet its plan still lists the denied claim.
  ['/api/agent/brief', {
    brief: {
      id: 12, brief_date: '2026-10-28', timezone: 'America/New_York',
      summary: 'One draft from yesterday is still waiting on you.',
      while_away: {
        since: '2026-10-27 14:00:00',
        new_denials: { count: 1, highlights: [{ claim_id: 5, claim_number: 'CLM-9001', patient_name: 'Pat Smoke', amount: 900, denial_reason: 'CO-50' }] },
        era_postings: { count: 0, total_paid: 0 },
        era_exceptions: { new_count: 0, on_hold_count: 0 },
        followups_passed: { count: 0 },
      },
      plan: [
        { rank: 1, key: 'denial-5', type: 'denial', title: 'Denied: CLM-9001', subtitle: 'Pat Smoke · Aetna', reason: 'CO-50 not medically necessary', amount: 900, due: null, claim_id: 5, appeal_id: null },
      ],
      proposed_draft_action_ids: [],
      created_at: '2026-10-28 12:00:00',
    },
    actions: [],
  }],
  ['/api/agent/conversations', { conversations: [] }],
  ['/api/agent/alerts', {
    items: {
      pending_approvals: { count: 1, highlights: ['Draft appeal — claim CLM-9001'] },
      followups_overdue: { count: 0, highlights: [] },
      filing_risk: { count: 0, amount: 0, highlights: [] },
      era_exceptions: { count: 0, amount: 0, highlights: [] },
      total: 1,
    },
  }],
  ['/api/agent/documents', { documents: [] }],
  ['/api/auth/me', fakeUser],
  ['/api/auth/orgs', [{ id: 1, name: 'Gate Test Co.', role: 'owner' }]],
  ['/api/billing/status', { plan: 'pro', plan_status: 'active', products: { rcm: true, ai: true }, access: 'full' }],
  ['/api/onboarding/status', { needed: false }],
  ['/api/authz/stats', { expiringSoon: 0, expiredUnhandled: 0, byStatus: {} }],
  ['/api/appeals/due', []],
  ['/api/worklist', { items: [], summary: { total: 0, totalAtStake: 0 } }],
];

const fakeFetch = (url, options) => {
  const u = String(url);
  if (u.includes('/api/agent/actions/pending')) {
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ actions: wizardApproved ? [] : [wizardAction] }),
    });
  }
  if (u.includes('/api/agent/actions/33/approve')) {
    wizardApproved = true;
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ action: { ...wizardAction, status: 'executed', result: { appeal_id: 55, appeal_status: 'open' }, decided_at: '2026-10-28 12:30:00', executed_at: '2026-10-28 12:30:00' } }),
    });
  }
  if (u.includes('/api/agent/team-insights')) {
    return Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({ error: 'Owner access required' }) });
  }
  const hit = mocks.find(([k]) => u.includes(k));
  const body = hit ? hit[1] : [];
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
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

(async () => {
  try {
    const { dom, errs } = makeDom();
    dom.window.localStorage.setItem('pulse_token', 'fake-token');
    global.fetch = fakeFetch;
    dom.window.fetch = fakeFetch;
    dom.window.eval(bundle);
    const doc = dom.window.document;

    await until(() => doc.getElementById('root').childElementCount > 0 && doc.body.textContent.includes('My Work'), 9000, 'logged-in shell');
    const agentTab = await until(() => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Agent'), 9000, 'Agent sidebar tab');
    agentTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await until(() => doc.body.textContent.includes('Reads your queue, drafts the work'), 9000, 'Agent page header');

    // The orphan card renders — in the approvals section, exactly once.
    const section = await until(() => doc.getElementById('agent-approvals'), 9000, 'approvals section (#agent-approvals)');
    if (!section.textContent.includes('Awaiting your approval')) fail('approvals section title missing');
    if (!section.textContent.includes('1 pending')) fail('approvals section pending count missing');
    if (!section.textContent.includes('Draft appeal — claim CLM-9001')) fail('wizard card missing from the approvals section');
    if (!section.textContent.includes('Approve & save draft')) fail('wizard card approve button missing');
    const occurrences = (doc.body.textContent.match(/Draft appeal — claim CLM-9001/g) || []).length;
    if (occurrences !== 1) fail(`the card title should render exactly once on the page, saw ${occurrences}`);
    if (doc.body.textContent.includes('Drafts ready for your approval')) fail('the brief must no longer embed its own approval cards');
    console.log('  PASS orphaned wizard card renders in #agent-approvals (brief returned 0 actions), exactly once');

    // The plan row for the same claim offers the waiting state, not a
    // duplicate draft; the alerts strip agrees a card is waiting.
    if (!doc.body.textContent.includes('Draft waiting ↑')) fail('plan row should show Draft waiting ↑ for the claim with a pending draft');
    if (!doc.body.textContent.includes('Open claim')) fail('plan row Open claim button missing');
    if (!doc.body.textContent.includes('1 approval waiting on you')) fail('alerts strip should count the waiting approval');
    console.log('  PASS plan row shows Draft waiting ↑ + Open claim; strip count agrees');

    // Approving from the section flips the card to its decided state in
    // place (the endpoint then returns an empty pending list).
    const approveBtn = await until(() => [...section.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Approve & save draft'), 9000, 'approve button');
    approveBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await until(() => section.textContent.includes('Approved · saved'), 9000, 'card decided state');
    if (!section.textContent.includes('Saved as an appeal draft on the claim')) fail('executed note missing after approval');
    if (!section.textContent.includes('open it in Denial Appeals to edit, print, or mark submitted')) fail('executed note should point at the letter actions (deploy #98 copy)');
    console.log('  PASS approving in the section flips the card to Approved · saved in place');

    if (errs.length) fail('React errors during render: ' + errs.slice(0, 3).join(' || ').slice(0, 400));
    pass('brief-0-actions + pending-1-card renders, wires, and decides in the approvals section');
  } catch (e) {
    fail(e.message);
  }
})();
