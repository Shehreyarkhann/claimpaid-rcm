#!/usr/bin/env node
/**
 * consent-landing-test.cjs — Deploy #102 cookie consent checks.
 *
 * Static sweep: every landing HTML (claimpilot/landing source of truth,
 * its rcm-dashboard/landing mirror, and the AskBase AI landing) includes
 * /consent.css + /consent.js, carries NO unconditional Cloudflare beacon
 * snippet, and has a footer "Cookie settings" link. App shells must be
 * untouched (beacon retained, no consent assets).
 *
 * Behavior (jsdom, consent.js injected inline into the REAL page DOM —
 * no network): first-visit banner, accept/reject/customize flows, beacon
 * gating, stored-consent reload, footer reopen + Esc + focus trap,
 * policy-version re-prompt.
 *
 * Usage: NODE_PATH=~/workspace/smoke-test/node_modules node deploy/consent-landing-test.cjs
 * Exit 0 = PASS, 1 = FAIL.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HOME_DIR = process.env.HOME;
const SRC = path.join(HOME_DIR, 'workspace/claimpilot/landing');
const MIRROR = path.join(__dirname, '..', 'landing');
const AI_PAGE = path.join(HOME_DIR, 'workspace/portfolio/askbase/landing/index.html');
const RCM_APP_SHELL = path.join(__dirname, '..', 'client/index.html');
const AI_APP_SHELL = path.join(HOME_DIR, 'workspace/portfolio/askbase/client/index.html');
const PRIVACY_MD = path.join(__dirname, '..', 'server/legal/privacy-v1-draft.md');

const consentJs = fs.readFileSync(path.join(SRC, 'consent.js'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok  ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

function walkHtml(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkHtml(p));
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

/* ---------------- static sweep ---------------- */
function staticSweep() {
  console.log('== static sweep ==');
  const pages = [...walkHtml(SRC), AI_PAGE];
  // Deploy #103: +34 pages (audit tool, denial-code index, 31 code pages, deadlines hub)
  check('landing page count is 67 (66 claimpilot pages + AI landing)', pages.length === 67, 'got ' + pages.length);
  for (const p of pages) {
    const rel = path.relative(SRC, p).startsWith('..') ? 'AI landing' : path.relative(SRC, p);
    const html = fs.readFileSync(p, 'utf8');
    check(rel + ': consent.css included', html.includes('<link rel="stylesheet" href="/consent.css"/>'));
    check(rel + ': consent.js included', html.includes('<script src="/consent.js" defer></script>'));
    check(rel + ': no unconditional beacon', !html.includes('static.cloudflareinsights.com') && !html.includes('data-cf-beacon'));
    check(rel + ': footer Cookie settings link', html.includes('data-cp-consent-open') && html.includes('Cookie settings'));
    // parses + footer renders
    const dom = new JSDOM(html, { url: 'https://claimpaid.io/' });
    const foot = dom.window.document.querySelector('footer');
    check(rel + ': parses, footer has Cookie settings', !!foot && foot.textContent.includes('Cookie settings'));
    dom.window.close();
  }
  const tokenCount = consentJs.split('ff492d06eea9413ead0a4480407c7846').length - 1;
  check('consent.js holds the beacon token exactly once', tokenCount === 1, 'got ' + tokenCount);
  check('consent.css exists', fs.existsSync(path.join(SRC, 'consent.css')));

  for (const [label, shell] of [['RCM app shell', RCM_APP_SHELL], ['AI app shell', AI_APP_SHELL]]) {
    const html = fs.readFileSync(shell, 'utf8');
    check(label + ' untouched: beacon retained', html.includes('static.cloudflareinsights.com'));
    check(label + ' untouched: no consent assets', !html.includes('/consent.js') && !html.includes('/consent.css'));
  }
  check('privacy policy points to /cookies/', fs.readFileSync(PRIVACY_MD, 'utf8').includes('https://claimpaid.io/cookies/'));

  // mirror byte-identity across the whole landing tree
  const srcFiles = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else srcFiles.push(path.relative(SRC, p));
    }
  })(SRC);
  let mirrorOk = true;
  for (const rel of srcFiles) {
    const a = fs.readFileSync(path.join(SRC, rel));
    const b = fs.readFileSync(path.join(MIRROR, rel));
    if (!a.equals(b)) { mirrorOk = false; console.log('    mirror differs: ' + rel); }
  }
  check('rcm-dashboard/landing mirror is byte-identical (' + srcFiles.length + ' files)', mirrorOk);
}

/* ---------------- behavior ---------------- */
function loadPage(file, presetCookieValue) {
  let html = fs.readFileSync(file, 'utf8');
  if (!html.includes('<script src="/consent.js" defer></script>')) throw new Error('consent.js tag missing in ' + file);
  html = html.replace('<script src="/consent.js" defer></script>', () => '<script>\n' + consentJs + '\n</script>');
  const dom = new JSDOM(html, {
    url: 'https://claimpaid.io/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      if (presetCookieValue) {
        window.document.cookie = 'cp_consent=' + encodeURIComponent(JSON.stringify(presetCookieValue));
      }
    },
  });
  return new Promise((resolve) => {
    if (dom.window.document.readyState === 'complete') return resolve(dom);
    dom.window.addEventListener('load', () => resolve(dom));
    setTimeout(() => resolve(dom), 3000);
  });
}

function beaconCount(dom) {
  return dom.window.document.querySelectorAll('script[src="https://static.cloudflareinsights.com/beacon.min.js"]').length;
}
function storedConsent(dom) {
  const c = dom.window.document.cookie.split('; ').find((s) => s.startsWith('cp_consent='));
  return c ? JSON.parse(decodeURIComponent(c.slice('cp_consent='.length))) : null;
}
function buttonByText(root, text) {
  return [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
}

async function behavior() {
  console.log('== behavior ==');
  const HOME = path.join(SRC, 'index.html');
  const ARTICLE = path.join(SRC, 'blog/837p-vs-835-explained/index.html');

  // (a) first visit: banner, three actions, no beacon
  {
    const dom = await loadPage(HOME);
    const d = dom.window.document;
    const banner = d.querySelector('.cp-consent-banner');
    check('(a) first visit shows banner', !!banner);
    check('(a) Accept all present', !!buttonByText(banner, 'Accept all'));
    check('(a) Reject non-essential present', !!buttonByText(banner, 'Reject non-essential'));
    check('(a) Customize present', !!buttonByText(banner, 'Customize'));
    check('(a) banner links cookie policy', !!banner.querySelector('a[href="/cookies/"]'));
    check('(a) beacon absent before consent', beaconCount(dom) === 0);
    dom.window.close();
  }
  // (b) accept all
  {
    const dom = await loadPage(HOME);
    const d = dom.window.document;
    buttonByText(d.querySelector('.cp-consent-banner'), 'Accept all').click();
    const rec = storedConsent(dom);
    check('(b) consent cookie set', !!rec);
    check('(b) record shape: v=1, analytics=true, ts present',
      !!rec && rec.v === 1 && rec.choices.analytics === true && typeof rec.ts === 'string' && !Number.isNaN(Date.parse(rec.ts)));
    check('(b) beacon injected exactly once', beaconCount(dom) === 1);
    check('(b) banner removed', !d.querySelector('.cp-consent-banner'));
    const jarCookie = dom.cookieJar.getCookiesSync('https://claimpaid.io/').find((c) => c.key === 'cp_consent');
    check('(b) cookie carries 12-month Max-Age', !!jarCookie && (jarCookie.maxAge === 31536000 || jarCookie.maxAge === '31536000'),
      'maxAge=' + (jarCookie && jarCookie.maxAge));
    dom.window.close();
  }
  // (c) reject
  {
    const dom = await loadPage(AI_PAGE);
    const d = dom.window.document;
    buttonByText(d.querySelector('.cp-consent-banner'), 'Reject non-essential').click();
    const rec = storedConsent(dom);
    check('(c) reject stores analytics=false', !!rec && rec.choices.analytics === false);
    check('(c) beacon never injected', beaconCount(dom) === 0);
    check('(c) banner removed', !d.querySelector('.cp-consent-banner'));
    dom.window.close();
  }
  // (d1) customize: analytics on + save
  {
    const dom = await loadPage(ARTICLE);
    const d = dom.window.document;
    buttonByText(d.querySelector('.cp-consent-banner'), 'Customize').click();
    const modal = d.querySelector('.cp-consent-modal');
    check('(d) customize opens modal', !!modal);
    check('(d) modal has aria wiring', modal.getAttribute('role') === 'dialog' && modal.getAttribute('aria-modal') === 'true');
    const toggle = modal.querySelector('input[type="checkbox"]');
    check('(d) analytics toggle starts off', !!toggle && toggle.checked === false);
    toggle.checked = true;
    buttonByText(modal, 'Save choices').click();
    const rec = storedConsent(dom);
    check('(d1) save stores analytics=true', !!rec && rec.choices.analytics === true);
    check('(d1) beacon injected after save', beaconCount(dom) === 1);
    check('(d1) modal closed', !d.querySelector('.cp-consent-modal'));
    dom.window.close();
  }
  // (d2) customize: toggle on then off + save
  {
    const dom = await loadPage(ARTICLE);
    const d = dom.window.document;
    buttonByText(d.querySelector('.cp-consent-banner'), 'Customize').click();
    const modal = d.querySelector('.cp-consent-modal');
    const toggle = modal.querySelector('input[type="checkbox"]');
    toggle.checked = true;
    toggle.checked = false;
    buttonByText(modal, 'Save choices').click();
    const rec = storedConsent(dom);
    check('(d2) save stores analytics=false', !!rec && rec.choices.analytics === false);
    check('(d2) beacon not injected', beaconCount(dom) === 0);
    dom.window.close();
  }
  // (e) stored consent reload
  {
    const granted = { v: 1, ts: new Date().toISOString(), choices: { necessary: true, analytics: true, marketing: false, functional: false } };
    const dom = await loadPage(HOME, granted);
    check('(e) stored grant: no banner', !dom.window.document.querySelector('.cp-consent-banner'));
    check('(e) stored grant: beacon follows choice (on)', beaconCount(dom) === 1);
    dom.window.close();
    const denied = { v: 1, ts: new Date().toISOString(), choices: { necessary: true, analytics: false, marketing: false, functional: false } };
    const dom2 = await loadPage(HOME, denied);
    check('(e) stored rejection: no banner', !dom2.window.document.querySelector('.cp-consent-banner'));
    check('(e) stored rejection: beacon follows choice (off)', beaconCount(dom2) === 0);
    dom2.window.close();
  }
  // (f) footer reopen + Esc + focus trap
  {
    const denied = { v: 1, ts: new Date().toISOString(), choices: { necessary: true, analytics: false, marketing: false, functional: false } };
    const dom = await loadPage(HOME, denied);
    const d = dom.window.document;
    const link = d.querySelector('footer [data-cp-consent-open]');
    check('(f) footer settings link exists', !!link);
    link.click();
    const modal = d.querySelector('.cp-consent-modal');
    check('(f) footer link reopens modal', !!modal);
    // focus trap: focus last focusable, Tab wraps to first
    const focusables = modal.querySelectorAll('button, a[href], input:not([disabled])');
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    last.focus();
    d.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    check('(f) focus trap wraps Tab to first element', d.activeElement === first);
    d.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    check('(f) Esc closes modal', !d.querySelector('.cp-consent-modal'));
    check('(f) stored consent means no banner after Esc', !d.querySelector('.cp-consent-banner'));
    dom.window.close();
  }
  // (g) version bump re-prompts
  {
    const stale = { v: 999, ts: new Date().toISOString(), choices: { necessary: true, analytics: true, marketing: false, functional: false } };
    const dom = await loadPage(HOME, stale);
    check('(g) outdated policy version re-prompts', !!dom.window.document.querySelector('.cp-consent-banner'));
    check('(g) stale grant does not load beacon', beaconCount(dom) === 0);
    dom.window.close();
  }
}

(async () => {
  staticSweep();
  await behavior();
  if (failures) { console.log('\nCONSENT LANDING TEST: FAIL — ' + failures + ' check(s) failed'); process.exit(1); }
  console.log('\nCONSENT LANDING TEST: PASS');
})().catch((e) => { console.error('CONSENT LANDING TEST: ERROR — ' + e.stack); process.exit(1); });
