#!/usr/bin/env node
/**
 * agent-smoke-test.cjs — jsdom render check for the Agent page (Phase 1).
 *
 * The standard render-smoke-test.cjs only renders the default page; the
 * Agent page mounts lazily behind sidebar navigation, so this harness goes
 * further: logged-out render, logged-in render, CLICK into the Agent tab,
 * open the mocked conversation, and assert the thread, the tool-activity
 * chip, and the pending APPROVAL CARD all render — with the agent endpoints
 * mocked in their real shapes. Any React error fails the run (this is the
 * harness shape that catches build-clean/runtime-crash bugs like the
 * 2026-10-22 missing-import blank screen).
 *
 * Usage: node deploy/agent-smoke-test.cjs [dist-dir]   (default client/dist)
 * Exit 0 = PASS, 1 = FAIL.
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const distDir = process.argv[2] || path.join(__dirname, '..', 'client', 'dist');
const BASE = '/app/';

function fail(reason) { console.log('AGENT SMOKE: FAIL — ' + reason); process.exit(1); }
function pass(detail) { console.log('AGENT SMOKE: PASS — ' + detail); process.exit(0); }

const indexHtml = path.join(distDir, 'index.html');
if (!fs.existsSync(indexHtml)) fail(`dist/index.html not found at ${indexHtml} — build first`);
const html = fs.readFileSync(indexHtml, 'utf8');
const entryMatch = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"|<script[^>]*src="([^"]+)"[^>]*type="module"/);
const entrySrc = entryMatch && (entryMatch[1] || entryMatch[2]);
if (!entrySrc) fail('no module script entry found in index.html');
const entryPath = path.join(distDir, entrySrc.slice(BASE.length));
if (!fs.existsSync(entryPath)) fail('entry bundle missing on disk: ' + entrySrc);
const bundle = fs.readFileSync(entryPath, 'utf8');

// Realistic mocks (shapes match the real APIs — an [] mock for an
// object-shaped endpoint produces false crashes).
const fakeUser = { id: 1, org_id: 1, email: 'gate@smoke.local', name: 'Gate User', role: 'owner', orgName: 'Gate Test Co.' };
const agentConvo = { id: 7, title: 'What is on my worklist?', created_at: '2026-10-28 10:00:00', updated_at: '2026-10-28 10:01:00' };
const mocks = [
  ['/api/agent/conversations/7', {
    conversation: agentConvo,
    messages: [
      { id: 1, role: 'user', content: 'What is on my worklist?', tool_events: [], created_at: '2026-10-28 10:00:00' },
      { id: 2, role: 'assistant', content: 'Top item: Denied claim CLM-1001 — $900 at stake.', tool_events: [{ tool: 'get_worklist', label: 'Checked worklist · 1 items · $900 at stake' }], created_at: '2026-10-28 10:00:30' },
    ],
    actions: [{
      id: 3, kind: 'draft_appeal', title: 'Draft appeal — claim CLM-1001', status: 'pending',
      preview: 'October 28, 2026\n\nAppeals Department\nAetna\n\nRe: Formal Appeal — Denied Claim CLM-1001\n\nWe are writing to formally appeal the denial of the above-referenced claim on the basis of medical necessity.',
      payload: { claim_id: 5, claim_number: 'CLM-1001', payer: 'Aetna', category: 'medical_necessity', subject: 'Appeal of Denied Claim CLM-1001' },
      result: null, created_at: '2026-10-28 10:01:00', decided_at: null, executed_at: null,
    }],
  }],
  ['/api/agent/conversations', { conversations: [{ ...agentConvo, pending_actions: 1 }] }],
  ['/api/auth/me', fakeUser],
  ['/api/auth/orgs', [{ id: 1, name: 'Gate Test Co.', role: 'owner' }]],
  ['/api/billing/status', { plan: 'pro', plan_status: 'active', products: { rcm: true, ai: true }, access: 'full' }],
  ['/api/onboarding/status', { needed: false }],
  ['/api/authz/stats', { expiringSoon: 0, expiredUnhandled: 0, byStatus: {} }],
  ['/api/appeals/due', []],
  ['/api/worklist', { items: [], summary: { total: 0, totalAtStake: 0 } }],
];
let disabledMode = false;
const fakeFetch = (url) => {
  const u = String(url);
  if (disabledMode && u.includes('/api/agent/')) {
    return Promise.resolve({
      ok: false, status: 403,
      json: () => Promise.resolve({ code: 'AGENT_DISABLED', error: 'The ClaimPaid agent is not enabled on this server yet.' }),
    });
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
  const errs = [];
  dom.window.console.error = (...a) => { errs.push(a.map((x) => String(x).slice(0, 150)).join(' ')); };
  return { dom, errs };
}

async function render({ loggedIn }) {
  const { dom, errs } = makeDom();
  if (loggedIn) dom.window.localStorage.setItem('pulse_token', 'fake-token');
  global.fetch = fakeFetch;
  dom.window.fetch = fakeFetch;
  dom.window.eval(bundle);
  return { dom, errs };
}

(async () => {
  try {
    // Logged-out: login page must render.
    const out = await render({ loggedIn: false });
    await until(() => out.dom.window.document.getElementById('root').childElementCount > 0, 9000, 'logged-out render');
    console.log('  PASS logged-out render non-empty');

    // Logged-in: app shell, then navigate into the Agent page.
    const app = await render({ loggedIn: true });
    const doc = app.dom.window.document;
    await until(() => doc.getElementById('root').childElementCount > 0 && doc.body.textContent.includes('My Work'), 9000, 'logged-in shell');
    console.log('  PASS logged-in render non-empty with app shell');

    const agentTab = await until(() => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Agent'), 9000, 'Agent sidebar tab');
    agentTab.dispatchEvent(new app.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    await until(() => doc.body.textContent.includes('Reads your queue, drafts the work'), 9000, 'Agent page header');
    console.log('  PASS Agent page renders (header + composer shell)');

    await until(() => doc.body.textContent.includes('What is on my worklist?'), 9000, 'conversation list');
    const convoBtn = [...doc.querySelectorAll('button')].find((b) => b.textContent.includes('What is on my worklist?'));
    convoBtn.dispatchEvent(new app.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    await until(() => doc.body.textContent.includes('Draft appeal — claim CLM-1001'), 9000, 'approval card');
    const bodyText = doc.body.textContent;
    if (!bodyText.includes('Checked worklist · 1 items')) fail('tool-activity chip missing from thread');
    if (!bodyText.includes('Approve & save draft')) fail('approval card Approve button missing');
    if (!bodyText.includes('medical necessity')) fail('approval card letter preview missing');
    if (!doc.querySelector('textarea')) fail('composer textarea missing');
    console.log('  PASS thread + tool chip + pending approval card + composer all render');

    if (app.errs.length) fail('React errors during agent render: ' + app.errs.slice(0, 3).join(' || ').slice(0, 400));

    // Disabled mode (what production shows until the flag + key land): the
    // Agent page must render its clean "not enabled" state, not an error.
    disabledMode = true;
    const dis = await render({ loggedIn: true });
    const ddoc = dis.dom.window.document;
    await until(() => ddoc.getElementById('root').childElementCount > 0 && ddoc.body.textContent.includes('My Work'), 9000, 'disabled-mode shell');
    const disTab = await until(() => [...ddoc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Agent'), 9000, 'Agent tab (disabled mode)');
    disTab.dispatchEvent(new dis.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await until(() => ddoc.body.textContent.includes("isn't enabled on this workspace yet"), 9000, 'AGENT_DISABLED page state');
    console.log('  PASS AGENT_DISABLED renders the clean not-enabled state');
    if (dis.errs.length) fail('React errors during disabled render: ' + dis.errs.slice(0, 3).join(' || ').slice(0, 400));

    pass(`bundle ${entrySrc} renders logged-out, logged-in, the full Agent page, and the disabled state`);
  } catch (e) {
    fail(e.message);
  }
})();
