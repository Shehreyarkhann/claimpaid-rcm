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
  ['/api/agent/brief', {
    brief: {
      id: 11, brief_date: '2026-10-28', timezone: 'America/New_York',
      summary: 'Six new denials landed overnight and one follow-up is overdue — start there.',
      while_away: {
        since: '2026-10-27 14:00:00',
        new_denials: { count: 6, highlights: [{ claim_id: 9, claim_number: 'CLM-2005', patient_name: 'Pat', amount: 900, denial_reason: 'CO-50' }] },
        era_postings: { count: 1, total_paid: 250.5 },
        era_exceptions: { new_count: 1, on_hold_count: 3 },
        followups_passed: { count: 1 },
      },
      plan: [
        { rank: 1, key: 'followup-25', type: 'followup', title: 'Follow up appeal — CLM-2005', subtitle: 'Pat · Aetna', reason: 'Follow-up was due Oct 27', amount: 900, due: '2026-10-27', claim_id: 9, appeal_id: 25 },
        { rank: 2, key: 'denial-6', type: 'denial', title: 'Denied: CLM-1002', subtitle: 'Pat · Aetna', reason: 'CO-50 not medically necessary', amount: 700, due: null, claim_id: 6, appeal_id: null },
      ],
      proposed_draft_action_ids: [21],
      created_at: '2026-10-28 12:00:00',
    },
    actions: [{
      id: 21, kind: 'draft_appeal', title: 'Draft appeal — claim CLM-1002', status: 'pending',
      preview: 'October 28, 2026\n\nAppeals Department\nAetna\n\nRe: Formal Appeal — Denied Claim CLM-1002\n\nWe are writing to formally appeal the denial of the above-referenced claim on the basis of medical necessity.',
      payload: { claim_id: 6, claim_number: 'CLM-1002', payer: 'Aetna', category: 'medical_necessity', subject: 'Appeal of Denied Claim CLM-1002' },
      result: null, created_at: '2026-10-28 12:00:00', decided_at: null, executed_at: null,
    }],
  }],
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
  // Phase 3 surfaces: dashboard insights card + claim analysis panel.
  ['/api/agent/insights', {
    filing_risk_14d: { claims: 3, amount: 12400 },
    expected_collections_30d: { amount: 8200, claims_with_estimate: 9, open_claims: 12, sample_size: 4, label: 'early estimate', note: "Open A/R balances weighted by each payer's historical paid-rate in this workspace. An estimate, not a guarantee." },
    denial_trend_watch: [{ payer: 'Aetna', current_rate: 0.31, prior_rate: 0.18, delta_points: 13, sample_size: 16, label: 'established' }],
    exception_backlog: { count: 6, amount: 675 },
    recovered_via_agent_appeals: { amount: 4825, appeals: 3 },
  }],
  // Phase 4: watchdog alerts strip on the Agent page.
  ['/api/agent/alerts', {
    items: {
      pending_approvals: { count: 1, highlights: ['Draft appeal — claim CLM-1002'] },
      followups_overdue: { count: 0, highlights: [] },
      filing_risk: { count: 1, amount: 410, highlights: ['CLM-1013 — 10 days left'] },
      era_exceptions: { count: 0, amount: 0 },
      total: 2,
    },
  }],
  ['/api/agent/claims/5/analysis', {
    claim: { id: 5, claim_number: 'CLM-9001', patient_name: 'Pat Smoke', payer: 'Aetna', status: 'denied', billed_amount: 900, paid_amount: 0, denial_reason: 'CO-50' },
    filing_risk: { filing_deadline: '2026-11-07', days_left: 9, filing_days: 90, state: 'critical' },
    appeal_overturn: { value: 0.75, sampleSize: 4, basis: 'payer + denial reason', label: 'early estimate', angle: 'medical_necessity' },
    angle: { angle: 'medical_necessity', label: 'Medical necessity', value: 0.833, sampleSize: 6 },
    pay_likelihood: null,
    era_exceptions: [],
    scrub: { score: 92, status: 'warnings', band: 'ready', band_label: 'Ready to submit', errors: 0, warnings: 1 },
    recommendations: [{ kind: 'draft_appeal', spawnable: true, label: 'Draft an appeal for this denial', detail: 'Appeals like this overturn 75% of the time here (n=4, early estimate).' }],
  }],
  ['/api/analytics/kpis', { totalBilled: 50000, totalClaims: 40, totalCollected: 30000, totalAR: 20000, avgDaysInAR: 33, cleanClaimRate: 91, denialRate: 12 }],
  ['/api/analytics/ar-aging', []],
  ['/api/analytics/revenue-trend', []],
  ['/api/analytics/denials-by-reason', []],
  ['/api/analytics/payer-mix', []],
  ['/api/analytics/appeal-stats', { byStatus: {}, winRate: 40 }],
  ['/api/analytics/claim-quality', { total_claims: 0, by_payer: [], first_pass_rate: null, denial_rate: null, avg_readiness: null, scrubbed_claims: 0 }],
  ['/api/filing/risk', { expired: 0, critical: 0, warning: 0, expiredAmount: 0, criticalAmount: 0 }],
  ['/api/claims/meta/payers', [{ id: 1, name: 'Aetna' }]],
  ['/api/claims/5', {
    id: 5, claim_number: 'CLM-9001', patient_name: 'Pat Smoke', payer: 'Aetna', service_date: '2026-10-20',
    billed_amount: 900, paid_amount: 0, status: 'denied', denial_reason: 'CO-50', readiness_score: 92,
    days_until_filing: 9, days_in_ar: 8, cpt_codes: '99213', icd_codes: 'M54.5', rendering_npi: '', rendering_provider: '',
    activity: [],
  }],
  ['/api/claims', {
    total: 1,
    claims: [{
      id: 5, claim_number: 'CLM-9001', patient_name: 'Pat Smoke', payer: 'Aetna', service_date: '2026-10-20',
      billed_amount: 900, paid_amount: 0, status: 'denied', denial_reason: 'CO-50', readiness_score: 92,
      days_until_filing: 9, days_in_ar: 8,
    }],
  }],
  ['/api/auth/me', fakeUser],
  ['/api/auth/orgs', [{ id: 1, name: 'Gate Test Co.', role: 'owner' }]],
  ['/api/billing/status', { plan: 'pro', plan_status: 'active', products: { rcm: true, ai: true }, access: 'full' }],
  ['/api/onboarding/status', { needed: false }],
  ['/api/authz/stats', { expiringSoon: 0, expiredUnhandled: 0, byStatus: {} }],
  ['/api/appeals/due', []],
  ['/api/worklist', { items: [], summary: { total: 0, totalAtStake: 0 } }],
];
let disabledMode = false;
const fakeFetch = (url, options) => {
  const u = String(url);
  // Phase 4 wizard engine: the response depends on which tool was run.
  if (!disabledMode && u.includes('/api/agent/tools/run')) {
    let tool = '';
    try { tool = JSON.parse((options && options.body) || '{}').tool; } catch { /* keep default */ }
    const out = tool === 'check_eligibility'
      ? { tool, is_error: false, output: { claim_id: 5, claim_number: 'CLM-9001', mode: 'live', vendor: 'rest', coverage_active: true, plan_name: 'Stub PPO Gold', checks: [], lookup_id: 9 }, event: null, action: null }
      : { tool, is_error: false, output: { score: 92, status: 'warnings', errors: [], warnings: [{ id: 'NPI-001', severity: 'warning', name: 'Missing rendering NPI', fix: 'Add the rendering provider NPI.' }], run_id: 5 }, event: { tool, label: 'Scrubbed claim' }, action: null };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(out) });
  }
  if (!disabledMode && u.includes('/api/agent/actions/propose')) {
    return Promise.resolve({
      ok: true, status: 201,
      json: () => Promise.resolve({ action: { id: 31, kind: 'draft_appeal', status: 'pending', title: 'Draft appeal — claim CLM-9001', preview: 'Dear Aetna — appeal letter.', payload: { claim_id: 5, claim_number: 'CLM-9001', category: 'medical_necessity', angle_source: 'learned', angle_stat: { value: 0.833, sampleSize: 6 } }, result: null, created_at: '2026-10-28 12:05:00', decided_at: null, executed_at: null } }),
    });
  }
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
  // jsdom lacks these; Recharts (Dashboard) needs them. Same polyfill as
  // deploy/rcm-tabs-era.cjs — a harness shim, not app behavior.
  dom.window.matchMedia = dom.window.matchMedia || (() => ({ matches: false, addListener: () => {}, removeListener: () => {} }));
  if (!dom.window.ResizeObserver) {
    dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  }
  global.ResizeObserver = dom.window.ResizeObserver;
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
    // Phase 4 motion pack: the built CSS must carry the stamp keyframes
    // behind the reduced-motion guard.
    const assetsDir = path.join(distDir, 'assets');
    const cssAll = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.css'))
      .map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf8')).join('\n');
    if (!cssAll.includes('prefers-reduced-motion')) fail('built CSS missing the prefers-reduced-motion guard');
    if (!cssAll.includes('cp-stamp-in')) fail('built CSS missing the stamp-in keyframes');
    console.log('  PASS motion pack present in built CSS (stamp keyframes behind prefers-reduced-motion)');

    // Logged-out: login page must render.
    const out = await render({ loggedIn: false });
    await until(() => out.dom.window.document.getElementById('root').childElementCount > 0, 9000, 'logged-out render');
    console.log('  PASS logged-out render non-empty');

    // Logged-in: app shell, then navigate into the Agent page.
    const app = await render({ loggedIn: true });
    const doc = app.dom.window.document;
    await until(() => doc.getElementById('root').childElementCount > 0 && doc.body.textContent.includes('My Work'), 9000, 'logged-in shell');
    console.log('  PASS logged-in render non-empty with app shell');

    // Dashboard (Phase 3): the Agent insights card renders from the
    // mocked /api/agent/insights in its real shape.
    const dashTab = await until(() => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Dashboard'), 9000, 'Dashboard sidebar tab');
    dashTab.dispatchEvent(new app.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await until(() => doc.body.textContent.includes('Agent insights'), 9000, 'dashboard agent insights card');
    await until(() => doc.body.textContent.includes('$4,825'), 9000, 'recovered count-up settle');
    const dashText = doc.body.textContent;
    if (!dashText.includes('At filing risk')) fail('insights card filing-risk tile missing');
    if (!dashText.includes('$12,400')) fail('insights card filing-risk amount missing');
    if (!dashText.includes('Expected collections')) fail('insights card expected-collections tile missing');
    if (!dashText.includes('early estimate')) fail('insights card thin-data label missing');
    if (!dashText.includes('ERA exceptions open')) fail('insights card exception backlog tile missing');
    if (!dashText.includes('Aetna')) fail('insights card denial-watch payer missing');
    if (!dashText.includes('Recovered via agent-assisted appeals')) fail('insights card recovered band missing (Phase 4)');
    if (!dashText.includes('$4,825')) fail('insights card recovered amount missing (Phase 4)');
    if (!dashText.includes('3 overturned appeals')) fail('insights card recovered appeal count missing (Phase 4)');
    console.log('  PASS Dashboard agent insights card renders (recovered band + risk + expected + watch + backlog, thin-data labeled)');

    // Claims (Phase 3): open the claim modal — the Agent analysis panel
    // renders predictions + a spawnable recommendation.
    const claimsTab = await until(() => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Claims'), 9000, 'Claims sidebar tab');
    claimsTab.dispatchEvent(new app.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await until(() => doc.body.textContent.includes('CLM-9001'), 9000, 'claims list row');
    const editBtn = await until(() => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Edit'), 9000, 'claim Edit button');
    editBtn.dispatchEvent(new app.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await until(() => doc.body.textContent.includes('Agent analysis'), 9000, 'claim agent analysis panel');
    const panelText = doc.body.textContent;
    if (!panelText.includes('Appeal overturn')) fail('claim panel overturn prediction missing');
    if (!panelText.includes('75%')) fail('claim panel overturn value missing');
    if (!panelText.includes('Scrub readiness')) fail('claim panel scrub summary missing');
    if (!panelText.includes('Draft an appeal for this denial')) fail('claim panel recommendation missing');
    if (!panelText.includes('Create draft')) fail('claim panel spawn button missing');
    console.log('  PASS Claim agent analysis panel renders (predictions + scrub + spawnable recommendation)');

    // Denial Rescue wizard (Phase 4): launched from the claim modal,
    // walks all five steps against the mocked tools/run + propose
    // endpoints, and finishes on the stamp completion screen.
    const clickBtn = async (label, match = 'exact') => {
      const btn = await until(() => [...doc.querySelectorAll('button')].find((b) => (match === 'exact' ? b.textContent.trim() === label : b.textContent.includes(label))), 9000, `button "${label}"`);
      btn.dispatchEvent(new app.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      return btn;
    };
    await clickBtn('Rescue', 'includes');
    await until(() => doc.body.textContent.includes('Denial Rescue') && doc.body.textContent.includes('Claim snapshot'), 9000, 'wizard step 1');
    if (!doc.body.textContent.includes('Appeal overturn')) fail('wizard snapshot prediction missing');
    await clickBtn('Continue →');
    await until(() => doc.body.textContent.includes('Eligibility — was coverage'), 9000, 'wizard step 2');
    await clickBtn('Run eligibility check', 'includes');
    await until(() => doc.body.textContent.includes('Coverage active'), 9000, 'wizard eligibility result');
    if (!doc.body.textContent.includes('Live · rest')) fail('wizard eligibility mode label missing');
    await clickBtn('Continue →');
    await until(() => doc.body.textContent.includes('Scrub — what would bounce'), 9000, 'wizard step 3');
    await until(() => doc.body.textContent.includes('Missing rendering NPI'), 9000, 'wizard scrub findings');
    await clickBtn('Continue →');
    await until(() => doc.body.textContent.includes('Appeal draft — proposed'), 9000, 'wizard step 4');
    if (!doc.body.textContent.includes('The draft will argue the')) fail('wizard best-angle line missing');
    if (!doc.body.textContent.includes('medical necessity')) fail('wizard best-angle name missing');
    await clickBtn('Create appeal draft', 'includes');
    await until(() => doc.body.textContent.includes('Draft created'), 9000, 'wizard draft created state');
    if (!doc.body.textContent.includes('Angle: medical necessity — overturns 83% here (n=6).')) fail('wizard learned-angle stat missing on the created draft');
    await clickBtn('Continue →');
    await until(() => doc.body.textContent.includes('Submission checklist'), 9000, 'wizard step 5');
    if (!doc.body.textContent.includes('Submit via your clearinghouse')) fail('wizard honest manual-submission step missing');
    await clickBtn('Finish', 'includes');
    await until(() => doc.body.textContent.includes('Rescue pass complete'), 9000, 'wizard completion screen');
    if (!doc.querySelector('.motion-stamp')) fail('wizard completion stamp element (motion-stamp class) missing');
    console.log('  PASS Denial Rescue wizard walks all five steps to the stamped completion screen');
    await clickBtn('Done');
    await sleep(300);

    const cancelBtn = [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancel');
    if (cancelBtn) cancelBtn.dispatchEvent(new app.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(300);

    const agentTab = await until(() => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Agent'), 9000, 'Agent sidebar tab');
    agentTab.dispatchEvent(new app.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    await until(() => doc.body.textContent.includes('Reads your queue, drafts the work'), 9000, 'Agent page header');
    console.log('  PASS Agent page renders (header + composer shell)');

    // Morning brief (Phase 2): section renders above the thread from the
    // mocked /api/agent/brief — dated header, narrative, while-you-were-
    // away tiles, ranked plan, and the brief's own approval card.
    await until(() => doc.body.textContent.includes('Morning brief'), 9000, 'morning brief section');
    const briefText = doc.body.textContent;
    if (!briefText.includes('Six new denials landed overnight')) fail('brief narrative summary missing');
    if (!briefText.includes('New denials')) fail('brief while-away tiles missing');
    if (!briefText.includes("Today's plan")) fail('brief plan section missing');
    if (!briefText.includes('Follow up appeal — CLM-2005')) fail('brief plan top item missing');
    if (!briefText.includes('Drafts ready for your approval')) fail('brief drafts header missing');
    if (!briefText.includes('Draft appeal — claim CLM-1002')) fail('brief approval card missing');
    console.log('  PASS morning brief renders (narrative + tiles + plan + inline approval card)');

    // Watchdog alerts strip (Phase 4): today's computed items above the brief.
    await until(() => doc.body.textContent.includes('Needs attention'), 9000, 'watchdog alerts strip');
    if (!doc.body.textContent.includes('1 approval waiting')) fail('alerts strip approvals part missing');
    if (!doc.body.textContent.includes('$410 at filing risk')) fail('alerts strip filing-risk part missing');
    console.log('  PASS watchdog alerts strip renders (approvals + filing risk)');

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

    // Disabled mode: the Dashboard must render WITHOUT the agent card.
    const disDash = await until(() => [...ddoc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Dashboard'), 9000, 'Dashboard tab (disabled mode)');
    disDash.dispatchEvent(new dis.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await until(() => ddoc.body.textContent.includes('Revenue cycle at a glance'), 9000, 'disabled-mode dashboard');
    await sleep(1500); // let the insights fetch fail + settle
    if (ddoc.body.textContent.includes('Agent insights')) fail('agent insights card must be hidden when the agent is disabled');
    console.log('  PASS Dashboard hides the agent insights card when disabled');
    if (dis.errs.length) fail('React errors during disabled dashboard render: ' + dis.errs.slice(0, 3).join(' || ').slice(0, 400));

    pass(`bundle ${entrySrc} renders logged-out, logged-in, the full Agent page, and the disabled state`);
  } catch (e) {
    fail(e.message);
  }
})();
