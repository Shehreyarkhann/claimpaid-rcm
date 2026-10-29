// Deploy #61 test: ONE 30-day trial per user, ever.
// - the trial window lives on the user; a second workspace mirrors the SAME
//   window (plan switches inside the trial included)
// - after the window, a new workspace starts expired/plans-only and its
//   Stripe checkout carries trial_period_days = 0 (no second free ride)
// Run: node deploy/trial-once-test.cjs
const fs = require('fs'); const os = require('os'); const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'trial61-'));
const DB = path.join(TMP, 't.db'); const PORT = 4118; const STRIPE_PORT = 4299;
let passed = 0, failed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log('  ok -', n); } else { failed++; console.log('  FAIL -', n, x !== undefined ? JSON.stringify(x) : ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp(tries = 60) { for (let i = 0; i < tries; i++) { try { const r = await fetch(`http://localhost:${PORT}/api/health`); if (r.ok) return true; } catch {} await sleep(500); } return false; }
async function call(method, p, body, token) {
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, body: j };
}

let lastCheckoutBody = '';
const fakeStripe = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url.startsWith('/v1/checkout/sessions')) {
      lastCheckoutBody = decodeURIComponent(body);
      return res.end(JSON.stringify({ id: 'cs_test', url: 'https://checkout.stripe.test/cs_test' }));
    }
    if (req.method === 'POST' && req.url.startsWith('/v1/customers')) {
      return res.end(JSON.stringify({ id: 'cus_test' }));
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: { message: 'not found ' + req.url } }));
  });
});

(async () => {
  await new Promise((r) => fakeStripe.listen(STRIPE_PORT, r));
  const env = {
    ...process.env, PORT: String(PORT), DB_PATH: DB, NODE_ENV: 'test',
    STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_API_BASE: `http://127.0.0.1:${STRIPE_PORT}`,
    STRIPE_PRICE_STARTER: 'price_starter', STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_AI: 'price_ai',
    APP_URL: 'http://localhost:' + PORT,
  };
  const srv = spawn('node', ['src/index.js'], { cwd: path.join(__dirname, '..', 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; srv.stderr.on('data', (d) => { err += d; });
  try {
    check('server up', await waitUp(), err.slice(-300));
    const U = await call('POST', '/api/auth/signup', { name: 'User U', email: 'u@test.co', password: 'Test1234!', orgName: 'U One' });
    const tok = U.body.token;
    // Deploy #100: the multi-workspace flow runs on Pro (3 workspaces) —
    // Starter now allows exactly 1 workspace per account.
    await call('POST', '/api/onboarding/complete', { plan: 'pro' }, tok);
    const st1 = await call('GET', '/api/billing/status', null, tok);
    const T1 = st1.body?.trial_ends_at;
    check('first workspace starts the trial', st1.body?.plan_status === 'trialing' && !!T1 && st1.body?.trial_days_left >= 29, st1.body);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB, { readOnly: true });
    const uRow = db.prepare('SELECT trial_ends_at FROM users WHERE email = ?').get('u@test.co');
    check('trial window recorded on the USER', uRow?.trial_ends_at === T1, uRow);
    db.close();

    // Second workspace: SAME window AND the account plan — deploy #100 made
    // the plan account-level, so submitting a different plan here is ignored
    // (the workspace mirrors the account's Pro plan, never its own Starter).
    const ws2 = await call('POST', '/api/auth/orgs', { name: 'U Two' }, tok);
    const sw2 = await call('POST', '/api/auth/switch', { org_id: ws2.body.id }, tok);
    await call('POST', '/api/onboarding/complete', { plan: 'starter' }, sw2.body.token);
    const st2 = await call('GET', '/api/billing/status', null, sw2.body.token);
    check('second workspace mirrors the account plan + same trial end (no extension)', st2.body?.trial_ends_at === T1 && st2.body?.plan === 'pro', { end: st2.body?.trial_ends_at, plan: st2.body?.plan });

    // Burn the window
    const db2 = new DatabaseSync(DB);
    db2.prepare("UPDATE users SET trial_ends_at = '2020-01-01T00:00:00.000Z' WHERE email = 'u@test.co'").run();
    db2.prepare("UPDATE orgs SET trial_ends_at = '2020-01-01T00:00:00.000Z'").run();
    db2.close();

    // Third workspace after the trial: starts expired, plans-only, and its
    // checkout must NOT carry trial days.
    const ws3 = await call('POST', '/api/auth/orgs', { name: 'U Three' }, tok);
    const sw3 = await call('POST', '/api/auth/switch', { org_id: ws3.body.id }, sw2.body.token);
    check('switch into third workspace', sw3.status === 200 && !!sw3.body?.token, sw3);
    await call('POST', '/api/onboarding/complete', { plan: 'starter' }, sw3.body.token);
    const st3 = await call('GET', '/api/billing/status', null, sw3.body.token);
    check('third workspace starts expired + plans_only (no second trial)',
      st3.body?.plan_status === 'expired' && st3.body?.access === 'plans_only', st3.body);
    const blocked = await call('GET', '/api/claims', null, sw3.body.token);
    check('business API blocked with PLAN_REQUIRED', blocked.status === 403 && blocked.body?.code === 'PLAN_REQUIRED', blocked);
    const baa = await call('POST', '/api/legal/baa/sign', { org_legal_name: 'U Three LLC', signed_by_name: 'User U', signed_by_title: 'Owner', agree: true }, sw3.body.token);
    check('BAA sign works in plans-only state', baa.status === 200 || baa.status === 201, baa);
    const co = await call('POST', '/api/billing/checkout', { plan: 'starter' }, sw3.body.token);
    check('checkout session created', co.status === 200 && !!co.body?.url, co);
    check('checkout carries NO trial days (trial already used)', !/trial_period_days/.test(lastCheckoutBody), lastCheckoutBody.slice(0, 300));

    // Control: a brand-new user DOES get trial days in checkout.
    const V = await call('POST', '/api/auth/signup', { name: 'User V', email: 'v@test.co', password: 'Test1234!', orgName: 'V One' });
    await call('POST', '/api/onboarding/complete', { plan: 'starter' }, V.body.token);
    await call('POST', '/api/legal/baa/sign', { org_legal_name: 'V LLC', signed_by_name: 'User V', signed_by_title: 'Owner', agree: true }, V.body.token);
    lastCheckoutBody = '';
    const co2 = await call('POST', '/api/billing/checkout', { plan: 'starter' }, V.body.token);
    check('fresh user checkout carries the trial', co2.status === 200 && /trial_period_days/.test(lastCheckoutBody), lastCheckoutBody.slice(0, 300));
  } catch (e) {
    failed++; console.log('  FAIL - exception:', e.stack || e.message);
  } finally {
    srv.kill(); fakeStripe.close();
    await sleep(300);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
