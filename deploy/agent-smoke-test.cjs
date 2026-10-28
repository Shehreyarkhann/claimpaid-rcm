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
    // Phase 5: payer-call history inside the analysis payload.
    call_history: [{
      id: 1, outcome: 'promised_payment', outcome_label: 'Payment promised', agent_name: 'Rep Dana',
      reference_number: 'RF-9', promised_date: '2026-11-10', follow_up_date: '2026-11-10',
      notes: 'Will reprocess', created_at: '2026-10-27 09:00:00', user_name: 'Gate User',
    }],
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
// Phase 5 mocks (real endpoint shapes).
const intakeDocSummary = {
  id: 3, filename: 'eob-oct.pdf', media_type: 'application/pdf', size_bytes: 4321,
  kind: 'remittance', status: 'needs_review',
  problems: ['Line 2: no claim in this workspace matches "CLM-999" — pick the right claim, or it will be held unmatched in the ERA inbox.'],
  action_id: null, era_id: null, created_at: '2026-10-28 09:00:00', updated_at: '2026-10-28 09:00:00',
  payer: 'Aetna', line_count: 2, matched_count: 1,
};
const intakeDocDetail = {
  ...intakeDocSummary,
  action: null,
  extracted: {
    payer: 'Aetna', check_number: 'CHK-9', pay_date: '2026-10-20', payment_amount: 180,
    lines: [
      { claim_number: 'CLM-9001', patient: 'Pat Smoke', service_date: '2026-10-20', billed: 200, paid: 150, adjustments: [{ group: 'CO', code: '45', text: 'Contractual adjustment', amount: 50 }], patient_resp: 0, matched_claim_id: 5, suggested_claim_id: null, match_method: 'control_number' },
      { claim_number: 'CLM-999', patient: 'Ghost Pat', service_date: '2026-10-21', billed: 100, paid: 30, adjustments: [{ group: 'CO', code: '45', text: 'Contractual adjustment', amount: 70 }], patient_resp: 0, matched_claim_id: null, suggested_claim_id: null, match_method: null },
    ],
  },
};
const intakeAction = {
  id: 41, kind: 'apply_intake', title: 'Apply intake — remittance (eob-oct.pdf)', status: 'pending',
  preview: 'Document intake — remittance from Aetna · check/EFT CHK-9 · paid 2026-10-20\nFile: eob-oct.pdf · 2 lines · billed $300.00 · paid $180.00',
  payload: { document_id: 3, doc_kind: 'remittance', filename: 'eob-oct.pdf', payer: 'Aetna' },
  result: null, created_at: '2026-10-28 12:00:00', decided_at: null, executed_at: null,
};
const teamInsightsMock = {
  users: [{
    user_id: 1, name: 'Gate User', email: 'gate@smoke.local', role: 'owner',
    open_worklist_items: 4, overdue_followups: 1, overdue_amount: 900, pending_approvals: 2,
    appeals_decided: 10, appeals_won: 7, win_rate: 0.7, agent_drafts_approved: 3, agent_drafts_rejected: 1,
  }],
  stalled: [{ claim_id: 9, claim_number: 'CLM-2005', patient_name: 'Pat', payer: 'Aetna', status: 'denied', balance: 900, idle_days: 12, owner_id: 1, owner_name: 'Gate User' }],
  suggestions: [],
};
const callBriefMock = {
  claim: { id: 5, claim_number: 'CLM-9001', patient_name: 'Pat Smoke', payer: 'Aetna', status: 'denied', denial_reason: 'CO-50', billed_amount: 900, paid_amount: 0 },
  family: 'medical_necessity', family_label: 'Medical necessity',
  opening_line: "I'm calling about claim CLM-9001 for Pat Smoke, date of service 2026-10-20, denied for: CO-50.",
  have_ready: [{ label: 'Claim number', value: 'CLM-9001' }, { label: 'Patient', value: 'Pat Smoke' }],
  questions: [
    'Which clinical criteria set was applied to this denial, and which element did the documentation fail to meet?',
    'Can we schedule a peer-to-peer review? What is the direct number for the reviewing clinician?',
    'Please confirm your name and a reference number for this call that I can cite.',
  ],
  good_outcome: 'A peer-to-peer is scheduled — with a reference number.',
  escalation: 'If the rep cannot resolve it: "Please transfer me to a claims supervisor or the provider-relations escalation line."',
  playbook: [],
  filing_risk: { filing_deadline: '2026-11-07', days_left: 9, filing_days: 90, state: 'critical' },
  open_appeal: null, recent_calls: [],
};
const importPreviewMock = {
  id: 9, filename: 'claims.csv',
  headers: ['Claim ID', 'Patient', 'Insurance', 'DOS', 'Charges'],
  mapping: { claim_number: 'Claim ID', patient_name: 'Patient', payer: 'Insurance', service_date: 'DOS', billed_amount: 'Charges' },
  fields: [
    { key: 'claim_number', label: 'Claim number', required: true },
    { key: 'patient_name', label: 'Patient name', required: true },
    { key: 'payer', label: 'Payer', required: true },
    { key: 'service_date', label: 'Service date', required: true },
    { key: 'billed_amount', label: 'Billed amount', required: true },
    { key: 'paid_amount', label: 'Paid amount', required: false },
  ],
  row_count: 1,
  validation: {
    rows: [{
      row: 2, payer_status: 'existing', duplicate: false, errors: [], warnings: [], valid: true,
      values: { claim_number: 'CLM-7001', patient_name: 'Pat New', payer: 'Aetna', service_date: '2026-10-01', billed_amount: 250, paid_amount: 0, denial_reason: null, patient_dob: null, member_id: null, cpt_codes: null, icd_codes: null },
    }],
    summary: { total: 1, valid: 1, with_warnings: 0, with_errors: 0, duplicates: 0, new_payers: [] },
  },
  created_at: '2026-10-28 09:00:00',
};
const auditMock = {
  id: 5, source: 'workspace', source_label: 'This workspace', created_at: '2026-10-28 14:00:00',
  result: {
    source: 'workspace', source_label: 'This workspace', workspace: 'Gate Test Co.',
    generated_at: '2026-10-28T14:00:00.000Z',
    horizons: { d14: { days: 14, count: 2, amount: 5000 }, d30: { days: 30, count: 3, amount: 8300 }, d60: { days: 60, count: 4, amount: 10400 } },
    expired: { count: 0, amount: 0 },
    by_payer: [{ payer: 'Aetna', count: 4, amount: 10400, earliest_days: 6 }],
    top: [{ claim_number: 'CLM-9001', patient: 'Pat Smoke', payer: 'Aetna', status: 'denied', balance: 900, deadline: '2026-11-03', days_left: 6 }],
    audited_claims: 4, skipped_rows: 0,
  },
};
let teamMode = 'owner';
let intakeProposed = false;

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
  // Phase 5 endpoints (stateful where the flow depends on it).
  if (!disabledMode && u.includes('/api/agent/documents/3/propose-apply')) {
    intakeProposed = true;
    return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ action: intakeAction }) });
  }
  if (!disabledMode && u.includes('/api/agent/documents/3')) {
    const doc = { ...intakeDocDetail, action: intakeProposed ? intakeAction : null, action_id: intakeProposed ? 41 : null };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ document: doc }) });
  }
  if (!disabledMode && u.includes('/api/agent/documents')) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ documents: [intakeDocSummary] }) });
  }
  if (!disabledMode && u.includes('/api/agent/team-insights')) {
    if (teamMode === 'member') {
      return Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({ error: 'Owner access required' }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(teamInsightsMock) });
  }
  if (!disabledMode && u.includes('/api/agent/claims/5/call-brief')) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ brief: callBriefMock }) });
  }
  if (!disabledMode && u.includes('/api/agent/import/preview')) {
    // Covers the preview upload AND the /mapping revalidation (same shape).
    return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ preview: importPreviewMock }) });
  }
  if (!disabledMode && u.includes('/api/agent/import/commit')) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ result: { created: 1, skipped: 0, errors: [], created_claim_ids: [77], payers_created: [] } }) });
  }
  if (!disabledMode && u.includes('/api/agent/audit/run')) {
    return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ audit: auditMock }) });
  }
  if (!disabledMode && u.includes('/api/agent/audit')) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ audits: [] }) });
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

    // Deadline audit (Phase 5): the insights card button opens the
    // runner; the workspace run renders the branded leave-behind report.
    const auditBtn = await until(() => [...doc.querySelectorAll('button')].find((b) => b.textContent.includes('Run deadline audit')), 9000, 'Run deadline audit button');
    auditBtn.dispatchEvent(new app.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await until(() => doc.body.textContent.includes('How much money dies at a filing deadline'), 9000, 'audit runner modal');
    const runWsBtn = await until(() => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Audit this workspace'), 9000, 'audit workspace button');
    runWsBtn.dispatchEvent(new app.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await until(() => doc.body.textContent.includes('Expiring in 14 days'), 9000, 'audit report horizons');
    const auditText = doc.body.textContent;
    if (!auditText.includes("We don't replace your system. We collect what it leaves behind.")) fail('audit report standing line missing');
    if (!auditText.includes('$5,000')) fail('audit report 14-day total missing');
    if (!auditText.includes('By payer')) fail('audit report payer table missing');
    if (!auditText.includes('The work list')) fail('audit report ranked list missing');
    console.log('  PASS deadline audit report renders (standing line + horizon totals + payer table + ranked list)');
    const auditClose = [...doc.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Close').pop();
    auditClose.dispatchEvent(new app.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(300);

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

    // Payer-call copilot (Phase 5): history inside the panel, then the
    // brief -> log modal in the Rescue language.
    if (!panelText.includes('Payer calls')) fail('claim panel payer-calls block missing');
    if (!panelText.includes('Payment promised')) fail('claim panel call history outcome missing');
    if (!panelText.includes('ref RF-9')) fail('claim panel call history reference missing');
    console.log('  PASS claim panel renders payer-call history');
    const callBtn = await until(() => [...doc.querySelectorAll('button')].find((b) => b.textContent.includes('Call payer')), 9000, 'Call payer button');
    callBtn.dispatchEvent(new app.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await until(() => doc.body.textContent.includes('Open with'), 9000, 'call brief step');
    const callText = doc.body.textContent;
    if (!callText.includes('peer-to-peer')) fail('call brief family question missing');
    if (!callText.includes('A good outcome looks like')) fail('call brief good-outcome block missing');
    if (!callText.includes('claims supervisor')) fail('call brief escalation line missing');
    console.log('  PASS payer-call brief renders (opening + family questions + good outcome + escalation)');
    const logStepBtn = await until(() => [...doc.querySelectorAll('button')].find((b) => b.textContent.includes('Log the outcome')), 9000, 'log outcome button');
    logStepBtn.dispatchEvent(new app.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await until(() => doc.body.textContent.includes('Save call log'), 9000, 'call log form');
    console.log('  PASS call-log form renders (outcome pills + promised date + notes)');
    const callClose = [...doc.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Close').pop();
    callClose.dispatchEvent(new app.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(300);

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

    // Document intake (Phase 5): the section lists the document, the
    // review shows problems + matched highlight + the unmatched claim
    // picker, and Propose apply renders the standard approval card.
    await until(() => doc.body.textContent.includes('Document intake'), 9000, 'document intake section');
    const docRow = await until(() => [...doc.querySelectorAll('button')].find((b) => b.textContent.includes('eob-oct.pdf')), 9000, 'intake document row');
    docRow.dispatchEvent(new app.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await until(() => doc.body.textContent.includes('Check before applying'), 9000, 'intake review problems');
    const intakeText = doc.body.textContent;
    if (!intakeText.includes('CLM-999')) fail('intake review unmatched line missing');
    if (!intakeText.includes('Matched')) fail('intake review matched badge missing');
    if (!intakeText.includes('Not matched — pick a claim')) fail('intake review claim picker missing');
    console.log('  PASS document intake review renders (problems + matched highlight + unmatched picker)');
    const proposeBtn = await until(() => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Propose apply'), 9000, 'propose apply button');
    proposeBtn.dispatchEvent(new app.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await until(() => doc.body.textContent.includes('Apply intake — remittance (eob-oct.pdf)'), 9000, 'apply_intake card');
    if (!doc.body.textContent.includes('Approve & apply')) fail('apply_intake approve button missing');
    console.log('  PASS apply_intake proposal renders as the standard approval card');

    // Team section (Phase 5): the owner sees it because the owner-gated
    // endpoint succeeds for this user.
    await until(() => doc.body.textContent.includes('Computed from the worklist, appeals'), 9000, 'team section');
    if (!doc.body.textContent.includes('Win rate')) fail('team table win-rate column missing');
    if (!doc.body.textContent.includes('Stalled — no activity in 7+ days')) fail('team stalled list missing');
    console.log('  PASS team section renders for the owner (per-user table + stalled list)');

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

    // Import wizard (Phase 5): launched from My Work, walks source ->
    // upload -> mapping -> validation -> commit summary against the
    // mocked preview/commit endpoints.
    const workTab = await until(() => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'My Work'), 9000, 'My Work sidebar tab');
    workTab.dispatchEvent(new app.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const importBtn = await until(() => [...doc.querySelectorAll('button')].find((b) => b.textContent.includes('Import claims')), 9000, 'Import claims button');
    importBtn.dispatchEvent(new app.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await until(() => doc.body.textContent.includes('CSV spreadsheet'), 9000, 'import wizard source step');
    const csvStart = await until(() => [...doc.querySelectorAll('button')].find((b) => b.textContent.includes('Start with CSV')), 9000, 'start CSV button');
    csvStart.dispatchEvent(new app.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await until(() => doc.body.textContent.includes('Drop the CSV here'), 9000, 'import wizard upload step');
    const fileInput = await until(() => doc.querySelector('input[type="file"]'), 9000, 'wizard file input');
    const csvFile = new app.dom.window.File(['Claim ID,Patient\nCLM-7001,Pat New\n'], 'claims.csv', { type: 'text/csv' });
    Object.defineProperty(fileInput, 'files', { value: [csvFile], configurable: true });
    fileInput.dispatchEvent(new app.dom.window.Event('change', { bubbles: true }));
    await until(() => doc.body.textContent.includes('Column mapping'), 9000, 'import wizard mapping step');
    const validateBtn = await until(() => [...doc.querySelectorAll('button')].find((b) => b.textContent.includes('Validate rows')), 9000, 'validate rows button');
    validateBtn.dispatchEvent(new app.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await until(() => doc.body.textContent.includes('Validation — what will happen'), 9000, 'import wizard validation step');
    if (!doc.body.textContent.includes('CLM-7001')) fail('wizard validation row missing');
    const commitBtn = await until(() => [...doc.querySelectorAll('button')].find((b) => b.textContent.includes('Import 1 valid claim')), 9000, 'wizard commit button');
    commitBtn.dispatchEvent(new app.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await until(() => doc.body.textContent.includes('Import complete'), 9000, 'import wizard done step');
    console.log('  PASS import wizard advances source -> upload -> mapping -> validation -> commit summary');
    const wizDone = await until(() => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Done'), 9000, 'wizard Done button');
    wizDone.dispatchEvent(new app.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(300);
    if (app.errs.length) fail('React errors during import wizard render: ' + app.errs.slice(0, 3).join(' || ').slice(0, 400));

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

    // Member pass (Phase 5): team-insights refuses (403), so the Team
    // section must never render — while the rest of the Agent page
    // (intake included) works normally.
    disabledMode = false;
    teamMode = 'member';
    const mem = await render({ loggedIn: true });
    const mdoc = mem.dom.window.document;
    await until(() => mdoc.getElementById('root').childElementCount > 0 && mdoc.body.textContent.includes('My Work'), 9000, 'member shell');
    const memTab = await until(() => [...mdoc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Agent'), 9000, 'Agent tab (member)');
    memTab.dispatchEvent(new mem.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await until(() => mdoc.body.textContent.includes('Document intake'), 9000, 'member agent page (intake renders)');
    await sleep(1500); // let the team-insights fetch refuse + settle
    if (mdoc.body.textContent.includes('Computed from the worklist, appeals')) fail('team section must be hidden when team-insights refuses');
    console.log('  PASS team section hidden for members (endpoint-gated, not role-guessed)');
    if (mem.errs.length) fail('React errors during member render: ' + mem.errs.slice(0, 3).join(' || ').slice(0, 400));

    pass(`bundle ${entrySrc} renders logged-out, logged-in, the full Agent page, and the disabled state`);
  } catch (e) {
    fail(e.message);
  }
})();
