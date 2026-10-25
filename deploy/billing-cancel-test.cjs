// Deploy #54 test: self-serve cancellation + super-admin unlimited bypass.
// - trial (no Stripe sub) cancel ends access immediately (products lock)
// - canceled orgs lose product access (pre-#54 gap: canceled kept products)
// - cancel with a Stripe sub but billing unconfigured -> graceful 503
// - reactivate with nothing scheduled -> 400
// - super-admin: status reports enterprise/active even on an expired org,
//   claim quota never 402s, product gates stay open
// Run: node deploy/billing-cancel-test.cjs
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn, execSync } = require('child_process');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bill54-'));
const DB = path.join(TMP, 't.db'); const PORT = 4113;
let passed = 0, failed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log('  ok -', n); } else { failed++; console.log('  FAIL -', n, x !== undefined ? JSON.stringify(x) : ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp(tries = 60) { for (let i = 0; i < tries; i++) { try { const r = await fetch(`http://localhost:${PORT}/api/health`); if (r.ok) return true; } catch {} await sleep(500); } return false; }
async function call(method, p, body, token) {
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, body: j };
}
const CLAIM = { claim_number: 'T54-1', patient_name: 'Test Patient', payer: 'Aetna', service_date: '2026-10-01', billed_amount: 100 };

(async () => {
  const env = { ...process.env, PORT: String(PORT), DB_PATH: DB, NODE_ENV: 'test', SUPERADMIN_EMAIL: 'admin54@test.co' };
  delete env.STRIPE_SECRET_KEY; // billing unconfigured for the 503 case
  const srv = spawn('node', ['src/index.js'], { cwd: path.join(__dirname, '..', 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; srv.stderr.on('data', (d) => { err += d; });
  try {
    check('server up', await waitUp(), err.slice(-300));

    // Trial org: signup -> onboarding (starter) -> cancel ends everything.
    const su = await call('POST', '/api/auth/signup', { name: 'Trial Org', email: 'trial54@test.co', password: 'Test1234!', orgName: 'Trial Co' });
    const tTok = su.body?.token;
    await call('POST', '/api/onboarding/complete', { plan: 'starter' }, tTok);
    check('trial org can create claims before cancel', (await call('POST', '/api/claims', CLAIM, tTok)).status === 201);
    const cx = await call('POST', '/api/billing/cancel', {}, tTok);
    check('trial cancel succeeds (no Stripe sub -> immediate)', cx.status === 200 && cx.body?.mode === 'immediate', cx);
    const st = await call('GET', '/api/billing/status', null, tTok);
    check('status reports canceled + products locked', st.body?.plan_status === 'canceled' && st.body?.products?.rcm === false, st.body);
    check('canceled org loses product access (claims 403)', (await call('GET', '/api/claims', null, tTok)).status === 403);
    check('double cancel -> 400', (await call('POST', '/api/billing/cancel', {}, tTok)).status === 400);
    check('reactivate with nothing scheduled -> 400', (await call('POST', '/api/billing/reactivate', {}, tTok)).status === 400);

    // Paid org with a Stripe sub id but no key configured -> graceful 503.
    const su2 = await call('POST', '/api/auth/signup', { name: 'Paid Org', email: 'paid54@test.co', password: 'Test1234!', orgName: 'Paid Co' });
    const pTok = su2.body?.token;
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB);
    db.prepare("UPDATE orgs SET plan = 'pro', plan_status = 'active', stripe_customer_id = 'cus_fake', stripe_subscription_id = 'sub_fake' WHERE id = (SELECT org_id FROM users WHERE email = 'paid54@test.co')").run();
    const cx2 = await call('POST', '/api/billing/cancel', {}, pTok);
    check('cancel with sub but Stripe unreachable -> graceful error, no crash', cx2.status === 502 || cx2.status === 503, cx2);
    const stillActive = db.prepare("SELECT plan_status FROM orgs WHERE id = (SELECT org_id FROM users WHERE email = 'paid54@test.co')").get();
    check('failed cancel leaves the org active (no partial state)', stillActive.plan_status === 'active', stillActive);
    db.close();

    // Super-admin: expired starter org — still enterprise, uncapped, ungated.
    const su3 = await call('POST', '/api/auth/signup', { name: 'Admin', email: 'admin54@test.co', password: 'Test1234!', orgName: 'HQ' });
    const aTok = su3.body?.token;
    await call('POST', '/api/onboarding/complete', { plan: 'starter' }, aTok);
    const db2 = new DatabaseSync(DB);
    const hq = db2.prepare("SELECT org_id FROM users WHERE email = 'admin54@test.co'").get().org_id;
    db2.prepare("UPDATE orgs SET trial_ends_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(hq); // expired trial
    // Fill the starter claim quota (1000) directly so a normal org would 402.
    const now = new Date(); const iso = now.toISOString().slice(0, 10);
    const payerHq = db2.prepare('SELECT id FROM payers WHERE org_id = ? LIMIT 1').get(hq).id;
    const ins = db2.prepare("INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date, billed_amount, status) VALUES (?, ?, 'P', ?, ?, 1, 'pending')");
    for (let i = 0; i < 1000; i++) ins.run(hq, 'F' + i, payerHq, iso);
    db2.close();
    const ast = await call('GET', '/api/billing/status', null, aTok);
    check('super-admin status: enterprise/active/unlimited despite expired trial',
      ast.body?.plan === 'enterprise' && ast.body?.plan_status === 'active' && ast.body?.unlimited === true && ast.body?.products?.rcm === true, ast.body);
    check('super-admin claim create bypasses the 402 quota', (await call('POST', '/api/claims', CLAIM, aTok)).status === 201);
    check('super-admin keeps product access on an expired org', (await call('GET', '/api/claims', null, aTok)).status === 200);

    // Control: a NON-admin starter org at quota gets the 402.
    const su4 = await call('POST', '/api/auth/signup', { name: 'Normal', email: 'norm54@test.co', password: 'Test1234!', orgName: 'Norm Co' });
    const nTok = su4.body?.token;
    await call('POST', '/api/onboarding/complete', { plan: 'starter' }, nTok);
    const db3 = new DatabaseSync(DB);
    const no = db3.prepare("SELECT org_id FROM users WHERE email = 'norm54@test.co'").get().org_id;
    const payerNo = db3.prepare('SELECT id FROM payers WHERE org_id = ? LIMIT 1').get(no).id;
    const ins2 = db3.prepare("INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date, billed_amount, status) VALUES (?, ?, 'P', ?, ?, 1, 'pending')");
    for (let i = 0; i < 1000; i++) ins2.run(no, 'F' + i, payerNo, iso);
    db3.close();
    check('non-admin starter org at quota still gets 402', (await call('POST', '/api/claims', CLAIM, nTok)).status === 402);
  } catch (e) {
    console.error('ERROR', e); failed++;
  } finally {
    try { srv.kill(); } catch {}
    await sleep(300);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
