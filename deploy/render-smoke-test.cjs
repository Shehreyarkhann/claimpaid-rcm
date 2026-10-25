#!/usr/bin/env node
/**
 * render-smoke-test.cjs — fail-closed render check for Vite SPA builds.
 *
 * Catches the class of bug Vite's build does NOT catch: a bundle that builds
 * cleanly but throws at runtime and blank-screens the app (e.g. `useState`
 * used without importing it — 2026-10-22, blanked claimpaid.io/app for every
 * logged-in user). Also catches asset-base mismatches (the /ai/app/ 404 bug).
 *
 * Usage: node render-smoke-test.cjs <dist-dir> <expected-asset-base> [--ai]
 *   <dist-dir>            path to the Vite dist directory
 *   <expected-asset-base> e.g. /app/ or /ai/app/ — every absolute asset ref in
 *                         index.html must start with this
 *   --ai                 lighter checks for the AI client (asset base + no-crash
 *                         eval + non-empty root). Without it, runs the full RCM
 *                         checks: logged-out render AND logged-in render with
 *                         realistic API mocks, asserting app-shell markers and
 *                         zero React errors.
 *
 * Exit 0 = PASS. Exit 1 = FAIL (reason printed). Designed to gate deploys:
 * on FAIL the deploy must abort BEFORE restarting services so the last good
 * build keeps serving.
 *
 * NOTE: assumes a single-file JS bundle (no Vite code-splitting). If the build
 * ever emits multiple chunks, the entry eval will throw on `import` and this
 * script must be updated to handle chunk graphs — the failure message says so.
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const [distDir, expectedBase, flag] = process.argv.slice(2);
const isAI = flag === '--ai';

function fail(reason) {
  console.log('SMOKE TEST: FAIL — ' + reason);
  process.exit(1);
}
function pass(detail) {
  console.log('SMOKE TEST: PASS — ' + detail);
  process.exit(0);
}

if (!distDir || !expectedBase) fail('usage: render-smoke-test.cjs <dist-dir> <expected-asset-base> [--ai]');
if (!expectedBase.endsWith('/')) fail('expected-asset-base must end with /');

const indexHtml = path.join(distDir, 'index.html');
if (!fs.existsSync(indexHtml)) fail('dist/index.html not found at ' + indexHtml);
const html = fs.readFileSync(indexHtml, 'utf8');

// ---- check 1: every absolute asset ref must use the expected base ----
const refs = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map(m => m[1]);
if (!refs.length) fail('no absolute asset refs found in index.html');
for (const r of refs) {
  if (!r.startsWith(expectedBase)) {
    fail(`asset ref "${r}" does not start with expected base "${expectedBase}" (wrong Vite base?)`);
  }
  const diskPath = path.join(distDir, r.slice(expectedBase.length));
  if (!fs.existsSync(diskPath)) fail(`referenced asset missing on disk: ${r}`);
}

// ---- check 2: find the entry JS bundle ----
const entryMatch = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"|<script[^>]*src="([^"]+)"[^>]*type="module"/);
const entrySrc = entryMatch && (entryMatch[1] || entryMatch[2]);
if (!entrySrc) fail('no module script entry found in index.html');
const entryPath = path.join(distDir, entrySrc.slice(expectedBase.length));
if (!fs.existsSync(entryPath)) fail('entry bundle missing on disk: ' + entrySrc);
const jsFiles = fs.readdirSync(path.join(distDir, 'assets')).filter(f => f.endsWith('.js'));
if (jsFiles.length > 1) {
  fail(`build is code-split into ${jsFiles.length} JS chunks; this harness only handles single-file bundles and must be updated (see header)`);
}
const bundle = fs.readFileSync(entryPath, 'utf8');

// ---- check 3: jsdom render ----
function makeDom() {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
    { url: 'https://claimpaid.io' + expectedBase, runScripts: 'outside-only', pretendToBeVisual: true }
  );
  for (const k of ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history']) {
    global[k] = dom.window[k];
  }
  const errs = [];
  dom.window.console.error = (...a) => { errs.push(a.map(x => String(x).slice(0, 150)).join(' ')); };
  return { dom, errs };
}

// Realistic mock shapes per endpoint (must match real API shapes — an [] mock
// for an object-shaped endpoint produces false crashes).
const fakeUser = { id: 1, org_id: 1, email: 'gate@smoke.local', name: 'Gate User', role: 'owner', orgName: 'Gate Test Co.' };
const mocks = {
  '/api/auth/me': fakeUser,
  '/api/auth/orgs': [{ id: 1, name: 'Demo Billing Co.', role: 'owner' }],
  '/api/authz/stats': { expiringSoon: 0, expiredUnhandled: 0, byStatus: {} },
  '/api/appeals/due': [],
  '/api/demo/requests': [],
  '/api/worklist': { items: [], summary: { totalAtStake: 0 } },
  '/api/claims': { claims: [], total: 0 },
  '/api/dashboard': {},
};
const fakeFetch = (url) => {
  const u = String(url);
  const key = Object.keys(mocks).find(k => u.includes(k));
  const body = key ? mocks[key] : [];
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
};

function renderOnce({ loggedIn }) {
  const { dom, errs } = makeDom();
  if (loggedIn) dom.window.localStorage.setItem('pulse_token', 'fake-token');
  global.fetch = fakeFetch;
  dom.window.fetch = fakeFetch;
  try {
    dom.window.eval(bundle);
  } catch (e) {
    return { ok: false, reason: 'bundle threw on eval: ' + String(e.message).slice(0, 200) };
  }
  return new Promise((resolve) => {
    setTimeout(() => {
      const root = dom.window.document.getElementById('root');
      const inner = root.innerHTML;
      if (root.childElementCount === 0) {
        resolve({ ok: false, reason: (loggedIn ? 'logged-in' : 'logged-out') + ' render left #root empty (blank screen)' });
        return;
      }
      resolve({ ok: true, inner, reactErrors: errs });
    }, 5000);
  });
}

(async () => {
  if (isAI) {
    const r = await renderOnce({ loggedIn: false });
    if (!r.ok) fail('AI client: ' + r.reason);
    if (r.reactErrors.length) fail('AI client: React errors on render: ' + r.reactErrors.slice(0, 3).join(' || ').slice(0, 400));
    pass(`AI client renders (${entrySrc}); ${refs.length} asset refs under ${expectedBase}, all on disk`);
  }

  // RCM: logged-out must render (login page), logged-in must render app shell.
  const out = await renderOnce({ loggedIn: false });
  if (!out.ok) fail('RCM: ' + out.reason);

  const app = await renderOnce({ loggedIn: true });
  if (!app.ok) fail('RCM: ' + app.reason);
  const markers = ['ClaimPaid', 'My Work'];
  const missing = markers.filter(m => !app.inner.includes(m));
  if (missing.length) fail('RCM: logged-in render missing app markers: ' + missing.join(', '));
  if (app.reactErrors.length) {
    fail('RCM: React errors on logged-in render: ' + app.reactErrors.slice(0, 3).join(' || ').slice(0, 400));
  }
  pass(`RCM renders logged-out + logged-in (${entrySrc}); ${refs.length} asset refs under ${expectedBase}, all on disk`);
})();
