#!/usr/bin/env node
/**
 * account-model-smoke.cjs — jsdom render checks for Deploy #100.
 *
 * Scenario 1 (wizard, existing-plan account): onboarding status carries an
 * accountPlan — the wizard must show NO plan picker, only the read-only
 * line "On your RCM Pro + AI plan · 2 of 3 workspaces", and completing
 * posts WITHOUT a plan (server mirrors the account plan).
 *
 * Scenario 2 (Team page, account holder): the Account team section renders
 * the roster with per-workspace access chips + Grant buttons, the usage
 * line "2 of 15 seats · 2 of 3 workspaces", and the share switch — flipping
 * it calls the share endpoint and the roster re-renders backfilled.
 *
 * Usage: node deploy/account-model-smoke.cjs [dist-dir]  (default client/dist)
 * Exit 0 = PASS, 1 = FAIL.
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const distDir = process.argv[2] || path.join(__dirname, '..', 'client', 'dist');
const BASE = '/app/';

function fail(reason) { console.log('ACCOUNT MODEL SMOKE: FAIL — ' + reason); process.exit(1); }

const indexHtml = path.join(distDir, 'index.html');
if (!fs.existsSync(indexHtml)) fail(`dist/index.html not found at ${indexHtml} — build first`);
const html = fs.readFileSync(indexHtml, 'utf8');
const entryMatch = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"|<script[^>]*src="([^"]+)"[^>]*type="module"/);
const entrySrc = entryMatch && (entryMatch[1] || entryMatch[2]);
if (!entrySrc) fail('no module script entry found in index.html');
const entryPath = path.join(distDir, entrySrc.slice(BASE.length));
if (!fs.existsSync(entryPath)) fail('entry bundle missing on disk: ' + entrySrc);
const bundle = fs.readFileSync(entryPath, 'utf8');

const ok = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
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
const btnContaining = (doc, text) => [...doc.querySelectorAll('button')].find((b) => b.textContent.includes(text));

(async () => {
  try {
    // ── Scenario 1: wizard for an existing-plan account ──────────────────
    {
      const fakeUser = { id: 1, org_id: 2, email: 'owner@smoke.local', name: 'Olivia Owner', role: 'owner', orgName: 'Second Practice' };
      let completeBody = null;
      const fakeFetch = (url, options) => {
        const u = String(url);
        const method = (options && options.method) || 'GET';
        if (u.includes('/api/onboarding/complete') && method === 'POST') {
          completeBody = JSON.parse(options.body);
          return ok({ plan: 'pro', plan_status: 'trialing', is_trialing: true, trial_ends_at: '2026-11-26T00:00:00.000Z', access: 'full' });
        }
        if (u.includes('/api/onboarding/status')) return ok({
          needed: true, noOrg: false, orgName: 'Second Practice', plan: null,
          accountPlan: { plan: 'pro', plan_status: 'trialing', trial_ends_at: '2026-11-26T00:00:00.000Z', workspaces: { used: 2, limit: 3 } },
        });
        if (u.includes('/api/auth/me')) return ok(fakeUser);
        if (u.includes('/api/auth/orgs')) return ok([{ id: 2, name: 'Second Practice', role: 'owner' }]);
        if (u.includes('/api/billing/status')) return ok({ plan: 'pro', plan_status: 'trialing', products: { rcm: true, ai: true }, access: 'full' });
        return ok([]);
      };
      const { dom, errs } = makeDom();
      dom.window.localStorage.setItem('pulse_token', 'fake-token');
      global.fetch = fakeFetch;
      dom.window.fetch = fakeFetch;
      dom.window.eval(bundle);
      const doc = dom.window.document;

      await until(() => doc.body.textContent.includes('Welcome to ClaimPaid'), 9000, 'wizard welcome');
      if (!doc.body.textContent.includes('Your plan carries over')) fail('welcome step should say the plan carries over for an existing-plan account');
      click(dom, btnByText(doc, 'Get started →'));
      await until(() => doc.body.textContent.includes('Tell us about your workspace'), 9000, 'workspace step');
      click(dom, btnByText(doc, 'Continue →'));
      await until(() => doc.body.textContent.includes('What should ClaimPaid do for you?'), 9000, 'goals step');
      click(dom, btnContaining(doc, 'Reduce denials'));
      await sleep(300); // let React apply the goal toggle before Continue reads it
      click(dom, btnByText(doc, 'Continue →'));
      await until(() => doc.body.textContent.includes('Your plan'), 9000, 'account plan step');
      const bodyText = doc.body.textContent;
      if (!bodyText.includes('On your RCM Pro + AI plan')) fail('plan step must show the read-only account plan line');
      if (!bodyText.includes('2 of 3 workspaces')) fail('plan step must show workspace usage from the payload');
      if (bodyText.includes('Choose your plan')) fail('plan step must NOT be a picker for an existing-plan account');
      if (btnByText(doc, 'Start 30-day free trial')) fail('no trial-start plan buttons may render for an existing-plan account');
      console.log('  PASS wizard: existing-plan account sees the read-only plan line, no picker');
      click(dom, btnContaining(doc, 'Continue with RCM Pro + AI'));
      await until(() => doc.body.textContent.includes("You're all set"), 9000, 'done step');
      if (!completeBody || 'plan' in completeBody) fail('wizard must complete WITHOUT submitting a plan in account mode');
      if (!doc.body.textContent.includes('RCM Pro + AI')) fail('done step should name the account plan');
      if (errs.length) fail('React errors during wizard render: ' + errs.slice(0, 3).join(' || ').slice(0, 300));
      console.log('  PASS wizard: completes without a plan field; server mirror mode owns the plan');
    }

    // ── Scenario 2: Team page account roster ─────────────────────────────
    {
      const fakeUser = { id: 1, org_id: 1, email: 'owner@smoke.local', name: 'Olivia Owner', role: 'owner', orgName: 'Main Street Billing' };
      const orgs = [{ id: 1, name: 'Main Street Billing' }, { id: 2, name: 'Second Practice' }];
      const patWorkspaces = (shared) => shared
        ? [{ org_id: 1, name: 'Main Street Billing', role: 'biller' }, { org_id: 2, name: 'Second Practice', role: 'biller' }]
        : [{ org_id: 1, name: 'Main Street Billing', role: 'biller' }];
      let shared = false;
      const accountPayload = () => ({
        plan: 'pro', plan_status: 'trialing', share_team: shared,
        seats: { used: 2, limit: 15, plan: 'pro', atCap: false },
        workspaces: { used: 2, limit: 3 },
        orgs,
        members: [
          { id: 1, name: 'Olivia Owner', email: 'owner@smoke.local', is_account_owner: true, workspaces: orgs.map((o) => ({ org_id: o.id, name: o.name, role: 'owner' })) },
          { id: 2, name: 'Pat Biller', email: 'pat@smoke.local', is_account_owner: false, workspaces: patWorkspaces(shared) },
        ],
      });
      const fakeFetch = (url, options) => {
        const u = String(url);
        const method = (options && options.method) || 'GET';
        if (u.includes('/api/auth/account/team/share') && method === 'PUT') { shared = JSON.parse(options.body).enabled; return ok(accountPayload()); }
        if (u.includes('/api/auth/account/team')) return ok(accountPayload());
        if (u.includes('/api/auth/team')) return ok([
          { id: 1, name: 'Olivia Owner', email: 'owner@smoke.local', role: 'owner', created_at: '2026-01-01', has_avatar: 0 },
          { id: 2, name: 'Pat Biller', email: 'pat@smoke.local', role: 'biller', created_at: '2026-01-02', has_avatar: 0 },
        ]);
        if (u.includes('/api/settings/seats')) return ok({ used: 2, limit: 15, plan: 'pro', atCap: false });
        if (u.includes('/api/auth/mfa/status')) return ok({ enabled: false, email: 'owner@smoke.local' });
        if (u.includes('/api/org/edi-settings')) return ok({});
        if (u.includes('/api/auth/me')) return ok(fakeUser);
        if (u.includes('/api/auth/orgs')) return ok(orgs.map((o) => ({ ...o, role: 'owner' })));
        if (u.includes('/api/billing/status')) return ok({ plan: 'pro', plan_status: 'trialing', products: { rcm: true, ai: true }, access: 'full' });
        if (u.includes('/api/onboarding/status')) return ok({ needed: false });
        if (u.includes('/api/authz/stats')) return ok({ expiringSoon: 0, expiredUnhandled: 0, byStatus: {} });
        if (u.includes('/api/worklist')) return ok({ items: [], summary: { total: 0, totalAtStake: 0 } });
        return ok([]);
      };
      const { dom, errs } = makeDom();
      dom.window.localStorage.setItem('pulse_token', 'fake-token');
      global.fetch = fakeFetch;
      dom.window.fetch = fakeFetch;
      dom.window.eval(bundle);
      const doc = dom.window.document;

      await until(() => doc.getElementById('root').childElementCount > 0 && doc.body.textContent.includes('My Work'), 9000, 'logged-in shell');
      // Team lives under the sidebar's Settings expander.
      const settingsToggle = await until(() => btnContaining(doc, 'Settings'), 9000, 'Settings expander');
      click(dom, settingsToggle);
      const tab = await until(() => btnByText(doc, 'Team'), 9000, 'Team tab');
      click(dom, tab);
      await until(() => doc.body.textContent.includes('Account team'), 9000, 'account team section');
      const bodyText = doc.body.textContent;
      if (!/2\s+of\s+15\s+seats/.test(bodyText)) fail('account section must show seat usage from the payload');
      if (!bodyText.includes('2 of 3 workspaces')) fail('account section must show workspace usage from the payload');
      if (!bodyText.includes('Share team across all my workspaces')) fail('share switch missing');
      if (!bodyText.includes('Pat Biller')) fail('roster must list Pat Biller');
      if (!bodyText.includes('Main Street Billing · Biller')) fail('Pat should carry a Main Street Billing · Biller chip');
      if (!btnContaining(doc, 'Second Practice · Grant')) fail('Pat should have a Grant button for Second Practice');
      console.log('  PASS team page: roster renders with usage line, chips and grant buttons');
      const sw = await until(() => doc.querySelector('button[role="switch"]'), 9000, 'share switch');
      click(dom, sw);
      await until(() => doc.querySelector('button[role="switch"]')?.getAttribute('aria-checked') === 'true', 9000, 'share on state');
      await until(() => doc.body.textContent.includes('Second Practice · Biller'), 9000, 'backfilled chip');
      if (errs.length) fail('React errors during team render: ' + errs.slice(0, 3).join(' || ').slice(0, 300));
      console.log('  PASS team page: share switch flips on and the roster re-renders backfilled');
    }

    // ── Scenario 3: Billing page — pooled usage + breakdown render ──────
    {
      const fakeUser = { id: 1, org_id: 1, email: 'owner@smoke.local', name: 'Olivia Owner', role: 'owner', orgName: 'Main Street Billing' };
      const entitlements = { plan: 'pro', price: 499, rcm: true, ai: true, agent: true, claimsPerMonth: 10000, seats: 15, aiUsesPerMonth: 2000, workspaces: 3 };
      const fakeFetch = (url, options) => {
        const u = String(url);
        if (u.includes('/api/billing/usage')) return ok({
          plan: 'pro',
          claims: { used: 4321, limit: 10000, pct: 0.43 },
          seats: { used: 2, limit: 15, pct: 0.13 },
          aiQueries: { used: 321, limit: 2000, pct: 0.16, unknown: false, agentTurns: 12 },
          workspaces: { used: 2, limit: 3 },
          used_by_workspace: [
            { org_id: 1, name: 'Main Street Billing', claims: 4000, aiQueries: 300 },
            { org_id: 2, name: 'Second Practice', claims: 321, aiQueries: 21 },
          ],
          warn: [], entitlements,
        });
        if (u.includes('/api/billing/status')) return ok({
          plan: 'pro', plan_status: 'trialing', is_trialing: true, trial_ends_at: '2026-11-26T00:00:00.000Z', trial_days_left: 28,
          products: { rcm: true, ai: true }, access: 'full', entitlements,
          entitlements_by_plan: { starter: { ...entitlements, plan: 'starter' }, pro: entitlements, ai: { ...entitlements, plan: 'ai' }, enterprise: { ...entitlements, plan: 'enterprise' } },
          workspaces: { used: 2, limit: 3 }, seats: { used: 2, limit: 15 },
          plans: { starter: { name: 'RCM Starter', amount: 19900, available: true }, pro: { name: 'RCM Pro + AI', amount: 49900, available: true }, ai: { name: 'ClaimPaid AI', amount: 9900, available: true } },
        });
        if (u.includes('/api/billing/invoices')) return ok({ invoices: [] });
        if (u.includes('/api/auth/me')) return ok(fakeUser);
        if (u.includes('/api/auth/orgs')) return ok([{ id: 1, name: 'Main Street Billing', role: 'owner' }]);
        if (u.includes('/api/onboarding/status')) return ok({ needed: false });
        if (u.includes('/api/authz/stats')) return ok({ expiringSoon: 0, expiredUnhandled: 0, byStatus: {} });
        if (u.includes('/api/worklist')) return ok({ items: [], summary: { total: 0, totalAtStake: 0 } });
        return ok([]);
      };
      const { dom, errs } = makeDom();
      dom.window.localStorage.setItem('pulse_token', 'fake-token');
      global.fetch = fakeFetch;
      dom.window.fetch = fakeFetch;
      dom.window.eval(bundle);
      const doc = dom.window.document;

      await until(() => doc.getElementById('root').childElementCount > 0 && doc.body.textContent.includes('My Work'), 9000, 'logged-in shell');
      click(dom, await until(() => btnContaining(doc, 'Settings'), 9000, 'Settings expander'));
      click(dom, await until(() => btnByText(doc, 'Billing & Plan'), 9000, 'Billing tab'));
      await until(() => doc.body.textContent.includes('Usage this month'), 9000, 'usage card');
      const bodyText = doc.body.textContent;
      if (!bodyText.includes('Workspaces')) fail('billing usage must include a Workspaces meter');
      if (!bodyText.includes('By workspace')) fail('billing usage must show the per-workspace breakdown');
      if (!bodyText.includes('Main Street Billing')) fail('breakdown must name workspace 1');
      if (!bodyText.includes('4,000 claims · 300 AI uses')) fail('breakdown must show workspace 1 consumption');
      if (!bodyText.includes('Second Practice')) fail('breakdown must name workspace 2');
      if (!bodyText.includes('321 claims · 21 AI uses')) fail('breakdown must show workspace 2 consumption');
      if (!bodyText.includes('pooled across your workspaces')) fail('entitlements must describe pooled quotas');
      if (errs.length) fail('React errors during billing render: ' + errs.slice(0, 3).join(' || ').slice(0, 300));
      console.log('  PASS billing page: workspaces meter + pooled breakdown render from the payload');
    }

    console.log('ACCOUNT MODEL SMOKE: PASS — wizard account-plan mode + team roster + billing pools render and act correctly');
    process.exit(0);
  } catch (e) {
    fail(e.message);
  }
})();
