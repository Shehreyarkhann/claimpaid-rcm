// Deploy #100 test: the ACCOUNT-level workspace/plan/team model + pooled quotas.
// - The plan belongs to the account: workspace creation inherits plan+trial,
//   onboarding on a later workspace mirrors the account plan (submitted plan
//   ignored), and no path sets a per-workspace plan.
// - Workspace limit gates CREATION only (403 WORKSPACE_LIMIT); over-limit
//   accounts are grandfathered (access untouched).
// - Seats = unique people on the account roster across the owner's
//   workspaces; cross-workspace grants consume no seat; a new person at the
//   cap is blocked (402 seat_limit_reached).
// - Share-team: backfill on enable, auto-add on workspace creation, stops
//   propagating when off, revokes nothing.
// - Quota POOLS: claims/month + AI uses/month sum across the account's
//   workspaces; workspace B blocks on workspace A's consumption; the
//   billing usage payload shows account totals + used_by_workspace.
// Run: node deploy/account-model-test.cjs
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'acct100-'));
const DB = path.join(TMP, 't.db'); const PORT = 4123;
let passed = 0, failed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log('  ok -', n); } else { failed++; console.log('  FAIL -', n, x !== undefined ? JSON.stringify(x).slice(0, 300) : ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp(tries = 60) { for (let i = 0; i < tries; i++) { try { const r = await fetch(`http://localhost:${PORT}/api/health`); if (r.ok) return true; } catch {} await sleep(500); } return false; }
async function call(method, p, body, token) {
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, body: j };
}
const MONTH = new Date().toISOString().slice(0, 7);
function sql(fn) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB);
  try { return fn(db); } finally { db.close(); }
}

(async () => {
  const env = {
    ...process.env, PORT: String(PORT), DB_PATH: DB, NODE_ENV: 'test',
    AI_DB_PATH: path.join(TMP, 'no-ai.db'),
    AGENT_ENABLED: '1', ANTHROPIC_API_KEY: 'test-key-not-real',
    APP_URL: 'http://localhost:' + PORT,
  };
  const srv = spawn('node', ['src/index.js'], { cwd: path.join(__dirname, '..', 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; srv.stderr.on('data', (d) => { err += d; });
  try {
    check('server up', await waitUp(), err.slice(-300));

    // ============ Account A: workspace lifecycle on Pro ============
    const A = await call('POST', '/api/auth/signup', { name: 'Owner A', email: 'a@test.co', password: 'Test1234!', orgName: 'A One' });
    const tokA1 = A.body.token; const wsA1 = A.body.user.org_id;
    await call('POST', '/api/onboarding/complete', { plan: 'pro' }, tokA1);
    const stA1 = await call('GET', '/api/billing/status', null, tokA1);
    const T1 = stA1.body?.trial_ends_at;
    check('A ws1: status carries workspaces {1 of 3} + seats {1 of 15}',
      stA1.body?.workspaces?.used === 1 && stA1.body?.workspaces?.limit === 3
      && stA1.body?.seats?.used === 1 && stA1.body?.seats?.limit === 15, stA1.body);

    const wsA2 = await call('POST', '/api/auth/orgs', { name: 'A Two' }, tokA1);
    check('A ws2 created, reports inherited plan', wsA2.status === 201 && wsA2.body?.plan === 'pro', wsA2);
    const tokA2 = (await call('POST', '/api/auth/switch', { org_id: wsA2.body.id }, tokA1)).body.token;
    const stA2pre = await call('GET', '/api/billing/status', null, tokA2);
    check('A ws2 inherits plan + trial window AT CREATION (before onboarding)',
      stA2pre.body?.plan === 'pro' && stA2pre.body?.trial_ends_at === T1, stA2pre.body);
    const onbA2 = await call('GET', '/api/onboarding/status', null, tokA2);
    check('A ws2 onboarding status exposes accountPlan (pro, 2 of 3 workspaces)',
      onbA2.body?.needed === true && onbA2.body?.accountPlan?.plan === 'pro'
      && onbA2.body?.accountPlan?.workspaces?.used === 2 && onbA2.body?.accountPlan?.workspaces?.limit === 3, onbA2.body);
    const compA2 = await call('POST', '/api/onboarding/complete', { plan: 'starter', companyName: 'A Two' }, tokA2);
    check('A ws2 onboarding with a DIFFERENT plan submitted still mirrors the account plan',
      compA2.status === 201 && compA2.body?.plan === 'pro' && compA2.body?.trial_ends_at === T1, compA2.body);

    const wsA3 = await call('POST', '/api/auth/orgs', { name: 'A Three' }, tokA1);
    check('A ws3 created (3 of 3)', wsA3.status === 201, wsA3);
    const wsA4 = await call('POST', '/api/auth/orgs', { name: 'A Four' }, tokA1);
    check('A ws4 blocked: 403 WORKSPACE_LIMIT with plan info',
      wsA4.status === 403 && wsA4.body?.code === 'WORKSPACE_LIMIT' && wsA4.body?.plan === 'pro'
      && wsA4.body?.workspaces?.used === 3 && wsA4.body?.workspaces?.limit === 3, wsA4);

    // ============ Account A: roster, grant / revoke ============
    const invP1 = await call('POST', '/api/auth/team', { name: 'Pat One', email: 'p1@test.co', password: 'Test1234!', role: 'biller' }, tokA1);
    check('invite p1 to A ws1', invP1.status === 201, invP1);
    const p1Id = invP1.body.id;
    let acct = await call('GET', '/api/auth/account/team', null, tokA1);
    check('account team: roster 2 people, seats {2 of 15}, p1 only in ws1',
      acct.body?.members?.length === 2 && acct.body?.seats?.used === 2
      && acct.body?.members?.find((m) => m.id === p1Id)?.workspaces?.length === 1, acct.body);
    const grant = await call('POST', '/api/auth/account/team/access', { user_id: p1Id, org_id: wsA2.body.id }, tokA1);
    check('grant p1 access to A ws2', grant.status === 201 && grant.body?.member?.workspaces?.length === 2, grant);
    acct = await call('GET', '/api/auth/account/team', null, tokA1);
    check('grant consumed NO seat (roster still 2)', acct.body?.seats?.used === 2, acct.body?.seats);
    const p1Login = await call('POST', '/api/auth/login', { email: 'p1@test.co', password: 'Test1234!' });
    const p1Orgs = await call('GET', '/api/auth/orgs', null, p1Login.body.token);
    check('p1 switcher lists BOTH workspaces after grant', p1Orgs.body?.length === 2, p1Orgs.body);
    const revokeSelf = await call('POST', '/api/auth/account/team/access/revoke', { user_id: A.body.user.id, org_id: wsA1 }, tokA1);
    check('account holder can never be revoked', revokeSelf.status === 400, revokeSelf);
    const revoke = await call('POST', '/api/auth/account/team/access/revoke', { user_id: p1Id, org_id: wsA2.body.id }, tokA1);
    check('revoke p1 from A ws2', revoke.status === 200 && revoke.body?.member?.workspaces?.length === 1, revoke);
    const p1Orgs2 = await call('GET', '/api/auth/orgs', null, p1Login.body.token);
    check('p1 switcher back to ws1 only after revoke', p1Orgs2.body?.length === 1 && p1Orgs2.body?.[0]?.id === wsA1, p1Orgs2.body);
    const revokeLast = await call('POST', '/api/auth/account/team/access/revoke', { user_id: p1Id, org_id: wsA1 }, tokA1);
    check('revoke p1 last membership ok', revokeLast.status === 200, revokeLast);
    const p1Login2 = await call('POST', '/api/auth/login', { email: 'p1@test.co', password: 'Test1234!' });
    check('p1 login SURVIVES losing last workspace (no purge)', p1Login2.status === 200 && !!p1Login2.body?.token, p1Login2);
    const p1Status = await call('GET', '/api/onboarding/status', null, p1Login2.body.token);
    check('p1 routed to the org-less flow', p1Status.body?.noOrg === true, p1Status.body);

    // ============ Account D: share-team propagation ============
    const D = await call('POST', '/api/auth/signup', { name: 'Owner D', email: 'd@test.co', password: 'Test1234!', orgName: 'D One' });
    const tokD1 = D.body.token; const wsD1 = D.body.user.org_id;
    await call('POST', '/api/onboarding/complete', { plan: 'pro' }, tokD1);
    const invQ1 = await call('POST', '/api/auth/team', { name: 'Quinn One', email: 'q1@test.co', password: 'Test1234!', role: 'biller' }, tokD1);
    const q1Id = invQ1.body.id;
    const shareOn = await call('PUT', '/api/auth/account/team/share', { enabled: true }, tokD1);
    check('share ON: payload share_team true', shareOn.body?.share_team === true, shareOn.body);
    const wsD2 = await call('POST', '/api/auth/orgs', { name: 'D Two' }, tokD1);
    let acctD = await call('GET', '/api/auth/account/team', null, tokD1);
    check('share ON: new workspace auto-adds the roster (q1 in 2 workspaces)',
      acctD.body?.members?.find((m) => m.id === q1Id)?.workspaces?.length === 2, acctD.body?.members);
    const shareOff = await call('PUT', '/api/auth/account/team/share', { enabled: false }, tokD1);
    check('share OFF revokes nothing (q1 keeps both workspaces)',
      shareOff.body?.members?.find((m) => m.id === q1Id)?.workspaces?.length === 2, shareOff.body?.members);
    const wsD3 = await call('POST', '/api/auth/orgs', { name: 'D Three' }, tokD1);
    acctD = await call('GET', '/api/auth/account/team', null, tokD1);
    check('share OFF: new workspace does NOT auto-add (q1 still in 2)',
      acctD.body?.members?.find((m) => m.id === q1Id)?.workspaces?.length === 2, acctD.body?.members);
    // Backfill proof: turn sharing back ON — q1 lands in ws3 too.
    const shareOn2 = await call('PUT', '/api/auth/account/team/share', { enabled: true }, tokD1);
    check('share ON again backfills (q1 in all 3 workspaces)',
      shareOn2.body?.members?.find((m) => m.id === q1Id)?.workspaces?.length === 3, shareOn2.body?.members);
    await call('PUT', '/api/auth/account/team/share', { enabled: false }, tokD1);

    // ============ Seat cap: new person blocked, roster member free ============
    const C = await call('POST', '/api/auth/signup', { name: 'Owner C', email: 'c@test.co', password: 'Test1234!', orgName: 'C One' });
    const tokC1 = C.body.token;
    await call('POST', '/api/onboarding/complete', { plan: 'starter' }, tokC1);
    for (let i = 2; i <= 5; i++) {
      const inv = await call('POST', '/api/auth/team', { name: `C Member ${i}`, email: `c${i}@test.co`, password: 'Test1234!', role: 'viewer' }, tokC1);
      check(`C invite #${i} (roster ${i} of 5)`, inv.status === 201, inv);
    }
    const invC6 = await call('POST', '/api/auth/team', { name: 'C Member 6', email: 'c6@test.co', password: 'Test1234!', role: 'viewer' }, tokC1);
    check('C invite #6 (new person at cap) → 402 seat_limit_reached',
      invC6.status === 402 && invC6.body?.error === 'seat_limit_reached' && invC6.body?.used === 5 && invC6.body?.limit === 5, invC6);

    // Downgrade D to Starter in the DB (roster 2, cap 5, 3 workspaces —
    // grandfathered) to prove cross-workspace moves are free at the cap.
    sql((db) => db.prepare("UPDATE orgs SET plan = 'starter' WHERE id IN (SELECT org_id FROM user_orgs WHERE user_id = ? AND role = 'owner')").run(D.body.user.id));
    for (let i = 2; i <= 4; i++) {
      const inv = await call('POST', '/api/auth/team', { name: `Dee ${i}`, email: `dq${i}@test.co`, password: 'Test1234!', role: 'viewer' }, tokD1);
      check(`D invite dq${i} (roster ${i + 1} of 5)`, inv.status === 201, inv);
    }
    const tokD3 = (await call('POST', '/api/auth/switch', { org_id: wsD3.body.id }, tokD1)).body.token;
    const crossInvite = await call('POST', '/api/auth/team', { email: 'dq2@test.co', role: 'biller' }, tokD3);
    check('at cap: inviting an EXISTING roster member into ws3 is allowed (no seat)',
      crossInvite.status === 201 && crossInvite.body?.addedToWorkspace === true, crossInvite);
    const newAtCap = await call('POST', '/api/auth/team', { name: 'Dee New', email: 'dqnew@test.co', password: 'Test1234!', role: 'viewer' }, tokD1);
    check('at cap: a NEW person is blocked (402)', newAtCap.status === 402 && newAtCap.body?.error === 'seat_limit_reached', newAtCap);
    const grantAtCap = await call('POST', '/api/auth/account/team/access', { user_id: q1Id, org_id: wsD3.body.id }, tokD1);
    check('at cap: account grant for a roster member still works', grantAtCap.status === 200 || grantAtCap.status === 201, grantAtCap);

    // ============ Grandfathering: over-limit account keeps access ============
    const B = await call('POST', '/api/auth/signup', { name: 'Owner B', email: 'b@test.co', password: 'Test1234!', orgName: 'B One' });
    const tokB1 = B.body.token; const wsB1 = B.body.user.org_id;
    await call('POST', '/api/onboarding/complete', { plan: 'starter' }, tokB1);
    const legacyOrgId = sql((db) => {
      const src = db.prepare('SELECT plan, plan_status, trial_started_at, trial_ends_at FROM orgs WHERE id = ?').get(wsB1);
      const id = Number(db.prepare('INSERT INTO orgs (name, plan, plan_status, trial_started_at, trial_ends_at) VALUES (?, ?, ?, ?, ?)')
        .run('B Legacy Extra', src.plan, src.plan_status, src.trial_started_at, src.trial_ends_at).lastInsertRowid);
      db.prepare("INSERT INTO user_orgs (user_id, org_id, role) VALUES (?, ?, 'owner')").run(B.body.user.id, id);
      return id;
    });
    const tokBLegacy = (await call('POST', '/api/auth/switch', { org_id: legacyOrgId }, tokB1)).body.token;
    check('grandfathered: switch into over-limit workspace works', !!tokBLegacy, null);
    const legacyClaims = await call('GET', '/api/claims', null, tokBLegacy);
    check('grandfathered: business API usable in the over-limit workspace', legacyClaims.status === 200, legacyClaims);
    const stB = await call('GET', '/api/billing/status', null, tokBLegacy);
    check('grandfathered: status reports 2 of 1 workspaces without blocking',
      stB.body?.workspaces?.used === 2 && stB.body?.workspaces?.limit === 1 && stB.body?.access === 'full', stB.body);
    const wsBNew = await call('POST', '/api/auth/orgs', { name: 'B New' }, tokB1);
    check('grandfathered: CREATION still gated at the limit', wsBNew.status === 403 && wsBNew.body?.code === 'WORKSPACE_LIMIT', wsBNew);

    // ============ Quota pools: claims sum across workspaces ============
    const payerA = sql((db) => db.prepare('SELECT id FROM payers WHERE org_id = ? ORDER BY id LIMIT 1').get(wsA1).id);
    sql((db) => db.exec(
      `INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date, billed_amount, created_at)
       WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 9999)
       SELECT ${wsA1}, 'POOL-' || n, 'Pool Patient', ${payerA}, '2026-10-01', 100, datetime('now') FROM seq`));
    const claimBody = { claim_number: 'POOL-LIVE-1', patient_name: 'Pool Live', payer: 'Aetna', service_date: '2026-10-15', billed_amount: 120 };
    const liveClaim = await call('POST', '/api/claims', claimBody, tokA2);
    check('pool: ws2 claim #10,000 (pool at 9,999) is allowed', liveClaim.status === 201, liveClaim);
    const overClaim = await call('POST', '/api/claims', { ...claimBody, claim_number: 'POOL-LIVE-2' }, tokA2);
    check('pool: next ws2 claim blocked by ws1 consumption → 402 claim_limit_reached',
      overClaim.status === 402 && overClaim.body?.error === 'claim_limit_reached' && overClaim.body?.used === 10000 && overClaim.body?.limit === 10000, overClaim);
    const usageA = await call('GET', '/api/billing/usage', null, tokA2);
    const bw = Object.fromEntries((usageA.body?.used_by_workspace || []).map((w) => [w.org_id, w]));
    check('pool: usage payload shows account total + per-workspace breakdown',
      usageA.body?.claims?.used === 10000 && usageA.body?.claims?.limit === 10000
      && bw[wsA1]?.claims === 9999 && bw[wsA2.body.id]?.claims === 1
      && usageA.body?.workspaces?.used === 3 && usageA.body?.workspaces?.limit === 3, usageA.body);

    // ============ Quota pools: AI uses sum across workspaces ============
    sql((db) => db.prepare('INSERT INTO agent_usage (org_id, month, turns, input_tokens, output_tokens) VALUES (?, ?, 2000, 0, 0)')
      .run(wsA1, MONTH));
    const toolRun = await call('POST', '/api/agent/tools/run', { tool: 'scrub_claim', claim_id: 1 }, tokA2);
    check('pool: agent tools/run in ws2 blocked by ws1 AI consumption → 402',
      toolRun.status === 402 && toolRun.body?.error === 'ai_query_limit_reached', toolRun);
    const usageA2 = await call('GET', '/api/billing/usage', null, tokA2);
    const bwAi = Object.fromEntries((usageA2.body?.used_by_workspace || []).map((w) => [w.org_id, w]));
    check('pool: AI usage payload pooled with breakdown (ws1 = 2,000)',
      usageA2.body?.aiQueries?.used === 2000 && bwAi[wsA1]?.aiQueries === 2000, usageA2.body?.aiQueries);

    // ============ A different account is unaffected ============
    const usageB = await call('GET', '/api/billing/usage', null, tokB1);
    check('isolation: B usage is its own (0 claims) while A sits at cap',
      usageB.body?.claims?.used === 0 && usageB.body?.claims?.limit === 1000, usageB.body?.claims);
    const bClaim = await call('POST', '/api/claims', { ...claimBody, claim_number: 'B-LIVE-1' }, tokB1);
    check('isolation: B can still create claims', bClaim.status === 201, bClaim);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  } catch (e) {
    console.log('  FAIL - exception:', e.stack || e.message);
    console.log(`\n${passed} passed, ${failed + 1} failed`);
    process.exit(1);
  } finally {
    srv.kill();
  }
})();
