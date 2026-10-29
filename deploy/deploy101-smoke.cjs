#!/usr/bin/env node
/**
 * deploy101-smoke.cjs — jsdom render checks for Deploy #101's new UI.
 *
 * Phase A (/app/): the Dashboard activation checklist renders its
 * derived steps; the shell notification bell renders with its unread
 * badge and opens a panel; the Agent page renders the batch-decide bar
 * and the Auto-approved stream (snapshot + policy form for the owner).
 * Phase B (/super): the Health tab renders the mocked /api/super/health
 * payload (status dots, cost, config presence).
 *
 * Usage: node deploy/deploy101-smoke.cjs [dist-dir]  (default client/dist)
 * Exit 0 = PASS, 1 = FAIL.
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const distDir = process.argv[2] || path.join(__dirname, '..', 'client', 'dist');
const BASE = '/app/';
let failures = 0;
function fail(reason) { failures++; console.log('  FAIL ' + reason); }
function ok(name) { console.log('  PASS ' + name); }

const indexHtml = path.join(distDir, 'index.html');
if (!fs.existsSync(indexHtml)) { console.log('DEPLOY101 SMOKE: FAIL — dist missing, build first'); process.exit(1); }
const html = fs.readFileSync(indexHtml, 'utf8');
const entryMatch = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"|<script[^>]*src="([^"]+)"[^>]*type="module"/);
const entrySrc = entryMatch && (entryMatch[1] || entryMatch[2]);
const entryPath = path.join(distDir, entrySrc.slice(BASE.length));
const bundle = fs.readFileSync(entryPath, 'utf8');

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
function makeDom(url) {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
    { url, runScripts: 'outside-only', pretendToBeVisual: true }
  );
  for (const k of ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history']) {
    global[k] = dom.window[k];
  }
  dom.window.matchMedia = dom.window.matchMedia || (() => ({ matches: false, addListener: () => {}, removeListener: () => {} }));
  if (!dom.window.ResizeObserver) dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  global.ResizeObserver = dom.window.ResizeObserver;
  const errs = [];
  dom.window.console.error = (...a) => { errs.push(a.map((x) => String(x).slice(0, 150)).join(' ')); };
  return { dom, errs };
}
const jsonRes = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

// ---------------- Phase A: the app ----------------
async function phaseA() {
  console.log('— smoke A: checklist + bell + agent surfaces —');
  const fakeUser = { id: 1, org_id: 1, email: 'gate@smoke.local', name: 'Gate User', role: 'owner', orgName: 'Gate Test Co.' };
  const pendingAction = (id, cn) => ({
    id, kind: 'draft_appeal', title: `Draft appeal — claim ${cn}`, status: 'pending',
    preview: 'October 29, 2026\n\nAppeals Department\nAetna\n\nRe: Formal Appeal',
    payload: { claim_id: id, claim_number: cn, payer: 'Aetna', category: 'medical_necessity' },
    result: null, created_at: '2026-10-29 08:00:00', decided_at: null, executed_at: null, auto_approved: false,
  });
  const autoAction = {
    id: 77, kind: 'draft_appeal', title: 'Draft appeal — claim CLM-AUTO', status: 'executed',
    preview: 'Letter', payload: { claim_id: 9, claim_number: 'CLM-AUTO', payer: 'Aetna' },
    result: { appeal_id: 91, appeal_created: true }, created_at: '2026-10-29 07:00:00',
    decided_at: '2026-10-29 07:00:01', executed_at: '2026-10-29 07:00:01', auto_approved: true,
    auto_snapshot: {
      policy: { max_amount: 1000, min_sample: 5, min_rate: 0.7 },
      prediction: { value: 0.833, sampleSize: 6, basis: 'payer + denial reason', label: 'overturn rate' },
      claim_amount: 500, decided_at: '2026-10-29 07:00:01',
    },
  };
  const mocks = [
    ['/api/analytics/kpis', { totalBilled: 50000, totalClaims: 40, totalCollected: 30000, totalAR: 20000, avgDaysInAR: 33, cleanClaimRate: 91, denialRate: 12 }],
    ['/api/analytics/ar-aging', []],
    ['/api/analytics/revenue-trend', []],
    ['/api/analytics/denials-by-reason', []],
    ['/api/analytics/payer-mix', []],
    ['/api/analytics/appeal-stats', { byStatus: {}, winRate: 40 }],
    ['/api/analytics/claim-quality', { total_claims: 0, by_payer: [], first_pass_rate: null, denial_rate: null, avg_readiness: null, scrubbed_claims: 0 }],
    ['/api/filing/risk', { expired: 0, critical: 0, warning: 0, expiredAmount: 0, criticalAmount: 0 }],
    ['/api/agent/checklist', {
      steps: [
        { key: 'claims', label: 'Bring in your claims', hint: 'Import a CSV or add claims', done: true, target: 'claims' },
        { key: 'audit', label: 'Run a free deadline audit', hint: 'See what is about to expire', done: true, target: 'audit' },
        { key: 'brief', label: 'Get your first morning brief', hint: 'Open the Agent tab', done: false, target: 'brief' },
        { key: 'appeal', label: 'Decide your first approval', hint: 'Approve a drafted appeal', done: false, target: 'appeal' },
      ],
      complete: false, dismissed: false,
    }],
    ['/api/agent/notifications', {
      items: [
        { id: 'approval-41', category: 'approval', title: '1 approval waiting', detail: 'Draft appeal — claim CLM-1', ts: '2026-10-29 08:00:00', target: { page: 'agent', section: 'approvals' } },
        { id: 'silent-7', category: 'payer_silent', title: 'Payer silent — claim CLM-OLD', detail: '40 days waiting · typical window 30 days', ts: '2026-09-19', target: { page: 'denials', appealId: 7 } },
      ],
      unread_count: 2, read_at: null, digest_opt_out: false,
    }],
    ['/api/agent/brief', {
      brief: {
        id: 1, brief_date: '2026-10-29', timezone: 'America/New_York', summary: null,
        while_away: { since: '2026-10-28 00:00:00', new_denials: { count: 0, highlights: [] }, era_postings: { count: 0, total_paid: 0 }, era_exceptions: { new_count: 0, on_hold_count: 0 }, followups_passed: { count: 0 } },
        plan: [], proposed_draft_action_ids: [], created_at: '2026-10-29 06:00:00',
      },
      actions: [],
    }],
    ['/api/agent/conversations', { conversations: [] }],
    ['/api/agent/alerts', { items: { pending_approvals: { count: 2, highlights: [] }, followups_overdue: { count: 0, highlights: [] }, filing_risk: { count: 0, amount: 0, highlights: [] }, era_exceptions: { count: 0, amount: 0, highlights: [] }, payer_silent: { count: 0, highlights: [] }, re_denied: { count: 0, highlights: [] }, total: 2 } }],
    ['/api/agent/documents', { documents: [] }],
    ['/api/agent/actions/pending', { actions: [pendingAction(41, 'CLM-1'), pendingAction(42, 'CLM-2')] }],
    ['/api/agent/actions/auto-approved', { actions: [autoAction] }],
    ['/api/agent/policy', { policy: { enabled: true, max_amount: 1000, min_sample: 5, min_rate: 0.7 } }],
    ['/api/auth/me', fakeUser],
    ['/api/auth/orgs', [{ id: 1, name: 'Gate Test Co.', role: 'owner' }]],
    ['/api/billing/status', { plan: 'pro', plan_status: 'active', products: { rcm: true, ai: true }, access: 'full' }],
    ['/api/onboarding/status', { needed: false }],
    ['/api/authz/stats', { expiringSoon: 0, expiredUnhandled: 0, byStatus: {} }],
    ['/api/appeals/due', []],
    ['/api/worklist', { items: [], summary: { total: 0, totalAtStake: 0 } }],
  ];
  const fakeFetch = (url) => {
    const u = String(url);
    if (u.includes('/api/agent/notifications/read')) return jsonRes({ ok: true, unread_count: 0 });
    const hit = mocks.find(([k]) => u.includes(k));
    return jsonRes(hit ? hit[1] : []);
  };
  const { dom, errs } = makeDom('https://claimpaid.io' + BASE);
  dom.window.localStorage.setItem('pulse_token', 'fake-token');
  global.fetch = fakeFetch;
  dom.window.fetch = fakeFetch;
  dom.window.eval(bundle);
  const doc = dom.window.document;

  const dashTab = await until(() => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Dashboard'), 9000, 'Dashboard tab');
  dashTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await until(() => doc.body.textContent.includes('Your path to the first recovered dollar'), 9000, 'checklist card');
  ok('activation checklist renders with the first-recovered-dollar framing');
  if (!doc.body.textContent.includes('2 of 4 done')) fail('checklist should show "2 of 4 done"');
  else ok('checklist progress + step states render');
  if (!doc.body.textContent.includes('Get your first morning brief')) fail('checklist open step missing');

  const bell = await until(() => doc.querySelector('[data-testid="notification-bell"]'), 9000, 'notification bell');
  if (!bell.textContent.includes('2')) fail('bell unread badge should show 2');
  else ok('notification bell renders with unread badge');
  const bellBtn = bell.querySelector('button');
  bellBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await until(() => doc.body.textContent.includes('Payer silent — claim CLM-OLD'), 9000, 'bell panel items');
  ok('bell panel opens and lists derived items (approval + payer silent)');
  if (!doc.body.textContent.includes('Email me the morning digest')) fail('bell digest toggle missing');
  else ok('bell carries the digest opt-out toggle');

  const agentTab = await until(() => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Agent'), 9000, 'Agent tab');
  agentTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await until(() => doc.body.textContent.includes('Auto-approved'), 9000, 'auto-approved section');
  ok('auto-approved stream renders');
  if (!doc.body.textContent.includes('Win history 83% (n=6)')) fail('auto-approved snapshot line missing (win history %)');
  else ok('auto-approved snapshot (policy + prediction) renders');
  if (!doc.body.textContent.includes('Void draft')) fail('void button missing on the auto-approved row');
  if (!doc.body.textContent.includes('Approve selected')) fail('batch decide bar missing');
  else ok('batch decide bar renders on the pending section');
  if (!doc.body.textContent.includes('Auto-approve appeal drafts that clear my bar') || !doc.body.textContent.includes('Save policy')) fail('owner policy form missing');
  else ok('owner policy form renders');
  if (errs.length) fail('React errors: ' + errs.slice(0, 3).join(' || ').slice(0, 300));
}

// ---------------- Phase B: /super health ----------------
async function phaseB() {
  console.log('— smoke B: /super health tab —');
  const fakeUser = { id: 1, org_id: 1, email: 'root@smoke.local', name: 'Root', role: 'owner', orgName: 'HQ', is_superadmin: true };
  const health = {
    server: { uptime_seconds: 90061, started_at: '2026-10-28T12:00:00Z', bundle_hash: 'DkeZY-Wu', node: 'v22.0.0' },
    traffic: { last_24h: { requests: 1234, errors: 12, error_rate: 0.0097 }, last_7d: { requests: 8000, errors: 60, error_rate: 0.0075 }, latency_p95_by_group: [{ group: 'api/agent', p95_ms: 420 }, { group: 'api/claims', p95_ms: 120 }] },
    agent: { turns: 100, input_tokens: 1000000, output_tokens: 200000, est_cost_usd: 2.0, pricing: { model_label: 'Haiku-class (agent default)', input_per_mtok_usd: 1, output_per_mtok_usd: 5 }, top_orgs: [{ org_id: 2, org_name: 'Plain Org', turns: 100, est_cost_usd: 2.0 }] },
    storage: { db_bytes: 5242880, disk: { free_bytes: 10000000000, total_bytes: 25000000000 }, latest_backup: { file: 'rcm-2026-10-29.db', age_hours: 5.5 } },
    services: { ai: 'up', ollama: 'down' },
    config: { anthropic_api_key: true, stedi_api_key: false, resend: true, stripe: true, agent_enabled: true },
    scheduler: { watchdog_last_run: '2026-10-29 12:00:00', brief_precompute_last_run: '2026-10-29 11:00:00', last_digest_attempt: '2026-10-29 12:00:01' },
    totals: { orgs: 7, users: 19 },
  };
  const fakeFetch = (url) => {
    const u = String(url);
    if (u.includes('/api/super/health')) return jsonRes(health);
    if (u.includes('/api/super/overview')) return jsonRes({ total_orgs: 7, total_users: 19, mrr: 0, trials_active: 0, by_plan: {}, recent_orgs: [], recent_users: [] });
    if (u.includes('/api/super/demos')) return jsonRes([]);
    if (u.includes('/api/super/tickets')) return jsonRes([]);
    if (u.includes('/api/super/subscriptions')) return jsonRes({ subscriptions: [] });
    if (u.includes('/api/auth/me')) return jsonRes(fakeUser);
    if (u.includes('/api/auth/orgs')) return jsonRes([{ id: 1, name: 'HQ', role: 'owner' }]);
    if (u.includes('/api/super/')) return jsonRes({});
    return jsonRes([]);
  };
  const { dom, errs } = makeDom('https://claimpaid.io/super');
  dom.window.localStorage.setItem('pulse_token', 'fake-token');
  global.fetch = fakeFetch;
  dom.window.fetch = fakeFetch;
  dom.window.eval(bundle);
  const doc = dom.window.document;

  const healthTab = await until(() => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Health'), 9000, 'Health tab');
  healthTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await until(() => doc.querySelector('[data-testid="super-health"]'), 9000, 'health tab body');
  ok('super health tab renders');
  const text = doc.body.textContent;
  if (!text.includes('Agent usage & cost')) fail('cost card missing');
  if (!text.includes('$2.00')) fail('estimated cost figure missing');
  if (!text.includes('Plain Org')) fail('top orgs row missing');
  if (!text.includes('Anthropic API key')) fail('config presence rows missing');
  if (!text.includes('index-DkeZY-Wu')) fail('bundle hash missing');
  if (!text.includes('Ollama')) fail('service probe rows missing');
  if (!text.includes('420 ms')) fail('p95 latency missing');
  else ok('health payload renders: cost, top orgs, config presence, bundle, probes, p95');
  if (errs.length) fail('React errors: ' + errs.slice(0, 3).join(' || ').slice(0, 300));
}

(async () => {
  try { await phaseA(); } catch (e) { fail('phase A: ' + e.message); }
  try { await phaseB(); } catch (e) { fail('phase B: ' + e.message); }
  if (failures) { console.log(`DEPLOY101 SMOKE: FAIL (${failures})`); process.exit(1); }
  console.log('DEPLOY101 SMOKE: PASS');
  process.exit(0);
})();
