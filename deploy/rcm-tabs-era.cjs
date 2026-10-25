#!/usr/bin/env node
// rcm-tabs.cjs — click through EVERY tab of the RCM client in jsdom,
// proxying fetch to a REAL local server (throwaway DB), capturing
// console errors per tab. Usage: node rcm-tabs.cjs <dist-dir> <api-base>
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const distDir = process.argv[2] || '/home/hatch/workspace/portfolio/rcm-dashboard/client/dist';
const API = process.argv[3] || 'http://127.0.0.1:4101';
const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
const entrySrc = (html.match(/src="([^"]+\.js)"/) || [])[1];
const entryRel = entrySrc.replace(/^\/app\//, '');
const bundle = fs.readFileSync(path.join(distDir, entryRel), 'utf8');
const nativeFetch = global.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  // No demo account exists since deploy #52 — the harness uses its own
  // gate user: login if present, otherwise sign up (fresh local DBs).
  const creds = { email: 'gate@smoke.local', password: 'Gate1234!' };
  let res = await nativeFetch(API + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(creds),
  });
  let d = await res.json();
  if (!d.token) {
    res = await nativeFetch(API + '/api/auth/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgName: 'Gate Smoke Co', name: 'Gate User', ...creds }),
    });
    d = await res.json();
  }
  if (!d.token) throw new Error('login failed: ' + JSON.stringify(d).slice(0, 120));
  // A fresh gate org lands on the onboarding wizard, not the app shell —
  // complete it (idempotent: the endpoint returns already_completed).
  await nativeFetch(API + '/api/onboarding/complete', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + d.token },
    body: JSON.stringify({ plan: 'pro', goals: ['reduce-denials'] }),
  });
  return d.token;
}

let errs = [];
function makeDom(token) {
  errs = [];
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
    { url: 'https://claimpaid.io/app/', runScripts: 'outside-only', pretendToBeVisual: true }
  );
  for (const k of ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history']) {
    global[k] = dom.window[k];
  }
  global.fetch = (url, opts) => nativeFetch(API + String(url), opts);
  dom.window.fetch = global.fetch;
  dom.window.console.error = (...a) => { errs.push(a.map((x) => String(x).slice(0, 200)).join(' ')); };
  dom.window.matchMedia = dom.window.matchMedia || (() => ({ matches: false, addListener: () => {}, removeListener: () => {} }));
  if (!dom.window.ResizeObserver) {
    dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  }
  global.ResizeObserver = dom.window.ResizeObserver;
  if (!dom.window.HTMLElement.prototype.scrollIntoView) dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  if (token) dom.window.localStorage.setItem('pulse_token', token);
  return dom;
}

function findBtn(dom, text) {
  const btns = [...dom.window.document.querySelectorAll('button')];
  return btns.find((b) => (b.textContent || '').trim() === text) || btns.find((b) => (b.textContent || '').includes(text));
}
function click(dom, el) {
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}
const results = [];
function step(name, dom, check) {
  const before = errs.length;
  try { check(); } catch (e) {
    results.push({ name, ok: false, reason: 'check threw: ' + String(e.message).slice(0, 160) });
    return;
  }
  const newErrs = errs.slice(before).filter((m) => !/not implemented|navigation/i.test(m));
  const rootEmpty = dom.window.document.getElementById('root').childElementCount === 0;
  if (rootEmpty) results.push({ name, ok: false, reason: 'BLANK #root after step' });
  else if (newErrs.length) results.push({ name, ok: false, reason: 'console errors: ' + newErrs.slice(0, 2).join(' || ').slice(0, 320) });
  else results.push({ name, ok: true, reason: '' });
}

(async () => {
  const token = await login();
  console.log('logged in ok');

  const dom = makeDom(token);
  try { dom.window.eval(bundle); } catch (e) {
    console.log('FAIL — bundle eval: ' + String(e.message).slice(0, 200));
    process.exit(1);
  }
  await sleep(2500);
  step('initial: My Work renders', dom, () => {
    const t = dom.window.document.body.textContent;
    if (!t.includes('My Work')) throw new Error('My Work not rendered');
  });

  const tabs = [
    ['Daily Briefing', 'Daily Briefing'],
    ['Dashboard', 'Dashboard'],
    ['Claims', 'Claims'],
    ['Denial Appeals', 'Denial'],
    ['Authorizations', 'Authorizations'],
    ['Eligibility', 'Eligibility'],
    ['Transmission', 'Transmission'],
    ['ERA Posting', 'ERA Auto-Posting'],
    ['Patient Statements', 'Patient Statements'],
    ['EHR', 'EHR'],
    ['Reports', 'Reports'],
    ['Playbook', 'Playbook'],
    ['AI Assistant', 'AI'],
    ['Organization', 'Organization'],
    ['Filing Rules', 'Filing Rules'],
    ['Letter Templates', 'Letter'],
    ['Team', 'Team'],
    ['Audit Log', 'Audit'],
    ['Compliance', 'Compliance'],
    ['Billing & Plan', 'Billing'],
  ];
  const SETTINGS_LABELS = ['Organization', 'Filing Rules', 'Letter Templates', 'Team', 'Audit Log', 'Compliance', 'Billing & Plan'];
  for (const [label, marker] of tabs) {
    let b = findBtn(dom, label);
    if (!b && SETTINGS_LABELS.includes(label)) {
      const hdr = findBtn(dom, 'Settings');
      if (hdr) { click(dom, hdr); await sleep(400); b = findBtn(dom, label); }
    }
    if (!b) { results.push({ name: `tab: ${label}`, ok: false, reason: 'nav button not found' }); continue; }
    click(dom, b);
    await sleep(1800);
    step(`tab: ${label}`, dom, () => {
      const t = dom.window.document.body.textContent;
      if (!t.includes(marker)) throw new Error(`marker "${marker}" missing`);
    });
  }

  // deploy #51: Claims tab carries the 837 import entry points.
  {
    let b = findBtn(dom, 'Claims');
    if (b) { click(dom, b); await sleep(1500); }
    step('claims: Import 837 entry points', dom, () => {
      const doc = dom.window.document;
      const btn = [...doc.querySelectorAll('button')].some((x) => /Import 837/i.test(x.textContent || ''));
      if (!btn) throw new Error('Import 837 button missing');
      if (!doc.querySelector('input[accept*=".837"]')) throw new Error('837 file input missing');
    });
  }

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.name}${r.reason ? ' — ' + r.reason : ''}`);
    if (!r.ok) failed++;
  }
  console.log(failed ? `\n${failed} FAILURES` : '\nALL RCM TABS PASS');
  process.exit(failed ? 1 : 0);
})();
