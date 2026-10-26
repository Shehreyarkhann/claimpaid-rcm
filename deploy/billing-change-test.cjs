// Deploy #60 test: plan switching — trial flip (no card), in-place Stripe
// price swap with proration (against a fake Stripe API), scheduled-cancel
// clearing, checkout mode for canceled orgs, owner-only + enterprise guards.
// Run: node deploy/billing-change-test.cjs
const fs = require('fs'); const os = require('os'); const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chg60-'));
const DB = path.join(TMP, 't.db'); const PORT = 4117; const STRIPE_PORT = 4199;
let passed = 0, failed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log('  ok -', n); } else { failed++; console.log('  FAIL -', n, x !== undefined ? JSON.stringify(x) : ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp(tries = 60) { for (let i = 0; i < tries; i++) { try { const r = await fetch(`http://localhost:${PORT}/api/health`); if (r.ok) return true; } catch {} await sleep(500); } return false; }
async function call(method, p, body, token) {
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, body: j };
}

// ---- Fake Stripe ----
const fakeSub = {
  id: 'sub_test', status: 'active', cancel_at_period_end: false,
  current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, trial_end: null,
  metadata: { org_id: '0', plan: 'starter' },
  items: { data: [{ id: 'si_1', price: { id: 'price_starter' } }] },
};
let lastUpdateBody = '';
const fakeStripe = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/v1/subscriptions/')) {
      if (req.method === 'GET') return res.end(JSON.stringify(fakeSub));
      if (req.method === 'POST') {
        lastUpdateBody = decodeURIComponent(body);
        const m = lastUpdateBody.match(/items\[0\]\[price\]=([A-Za-z0-9_]+)/);
        if (m) fakeSub.items.data[0].price.id = m[1];
        if (/cancel_at_period_end=false/.test(lastUpdateBody)) fakeSub.cancel_at_period_end = false;
        return res.end(JSON.stringify(fakeSub));
      }
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
});

(async () => {
  await new Promise((r) => fakeStripe.listen(STRIPE_PORT, r));
  const env = {
    ...process.env, PORT: String(PORT), DB_PATH: DB, NODE_ENV: 'test',
    STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_API_BASE: `http://127.0.0.1:${STRIPE_PORT}`,
    STRIPE_PRICE_STARTER: 'price_starter', STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_AI: 'price_ai',
  };
  const srv = spawn('node', ['src/index.js'], { cwd: path.join(__dirname, '..', 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; srv.stderr.on('data', (d) => { err += d; });
  try {
    check('server up', await waitUp(), err.slice(-300));
    const T = await call('POST', '/api/auth/signup', { name: 'Owner T', email: 't@test.co', password: 'Test1234!', orgName: 'Org T' });
    const tokT = T.body.token, orgT = T.body.user.org_id;
    const oc = await call('POST', '/api/onboarding/complete', { plan: 'starter' }, tokT);
    check('onboarding completes on starter', oc.status === 200 || oc.status === 201, oc);
    const st0 = await call('GET', '/api/billing/status', null, tokT);
    const trialEnds = st0.body?.trial_ends_at;
    check('trialing, no subscription yet', st0.body?.plan_status === 'trialing' && st0.body?.has_subscription === false, st0.body);

    // 1) Trial flip — instant, trial clock untouched
    const flip = await call('POST', '/api/billing/change-plan', { plan: 'ai' }, tokT);
    check('trial switch -> mode trial', flip.status === 200 && flip.body?.mode === 'trial', flip);
    const st1 = await call('GET', '/api/billing/status', null, tokT);
    check('plan is ai, trial end unchanged', st1.body?.plan === 'ai' && st1.body?.trial_ends_at === trialEnds, { plan: st1.body?.plan, end: st1.body?.trial_ends_at });

    // 2) Guards
    check('same plan -> 400', (await call('POST', '/api/billing/change-plan', { plan: 'ai' }, tokT)).status === 400);
    check('unknown plan -> 400', (await call('POST', '/api/billing/change-plan', { plan: 'gold' }, tokT)).status === 400);

    // 3) Non-owner -> 403
    const M = await call('POST', '/api/auth/signup', { name: 'Member M', email: 'm@test.co', password: 'Test1234!', orgName: 'Org M' });
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB);
    db.prepare('INSERT INTO user_orgs (user_id, org_id, role) VALUES (?, ?, ?)').run(M.body.user.id, orgT, 'biller');
    const swM = await call('POST', '/api/auth/switch', { org_id: orgT }, M.body.token);
    check('member switch ok', swM.status === 200 && !!swM.body?.token, swM);
    check('non-owner change-plan -> 403', (await call('POST', '/api/billing/change-plan', { plan: 'pro' }, swM.body.token)).status === 403);

    // 4) Live subscription swap (active)
    db.prepare("UPDATE orgs SET plan = 'starter', plan_status = 'active', stripe_customer_id = 'cus_1', stripe_subscription_id = 'sub_test' WHERE id = ?").run(orgT);
    fakeSub.status = 'active'; fakeSub.items.data[0].price.id = 'price_starter';
    const swap = await call('POST', '/api/billing/change-plan', { plan: 'pro' }, tokT);
    check('paid switch -> mode swapped', swap.status === 200 && swap.body?.mode === 'swapped', swap);
    check('stripe got price_pro + prorations + cancel cleared',
      lastUpdateBody.includes('items[0][price]=price_pro') && lastUpdateBody.includes('proration_behavior=create_prorations') && lastUpdateBody.includes('cancel_at_period_end=false'),
      lastUpdateBody.slice(0, 300));
    const st2 = await call('GET', '/api/billing/status', null, tokT);
    check('status shows pro + has_subscription', st2.body?.plan === 'pro' && st2.body?.has_subscription === true, st2.body);

    // 5) Scheduled cancel cleared by a switch
    db.prepare('UPDATE orgs SET stripe_cancel_at_period_end = 1 WHERE id = ?').run(orgT);
    const swap2 = await call('POST', '/api/billing/change-plan', { plan: 'ai' }, tokT);
    const flag = db.prepare('SELECT stripe_cancel_at_period_end f FROM orgs WHERE id = ?').get(orgT).f;
    check('switch clears scheduled cancellation', swap2.status === 200 && flag === 0, { swap2, flag });

    // 6) Trialing WITH a subscription swaps in Stripe, stays trialing
    db.prepare("UPDATE orgs SET plan_status = 'trialing' WHERE id = ?").run(orgT);
    fakeSub.status = 'trialing';
    const swap3 = await call('POST', '/api/billing/change-plan', { plan: 'starter' }, tokT);
    check('trialing-with-sub switch -> swapped + trial message', swap3.status === 200 && swap3.body?.mode === 'swapped' && /trial/i.test(swap3.body?.message || ''), swap3);
    db.close();

    // 7) Canceled org -> checkout mode
    const C = await call('POST', '/api/auth/signup', { name: 'Owner C', email: 'c@test.co', password: 'Test1234!', orgName: 'Org C' });
    await call('POST', '/api/onboarding/complete', { plan: 'starter' }, C.body.token);
    const db2 = new DatabaseSync(DB);
    db2.prepare("UPDATE orgs SET plan_status = 'canceled' WHERE id = ?").run(C.body.user.org_id);
    const co = await call('POST', '/api/billing/change-plan', { plan: 'pro' }, C.body.token);
    check('canceled org -> mode checkout', co.status === 200 && co.body?.mode === 'checkout' && co.body?.ok === false, co);
    // 8) Enterprise guard
    db2.prepare("UPDATE orgs SET plan = 'enterprise', plan_status = 'active' WHERE id = ?").run(C.body.user.org_id);
    check('enterprise plan -> 400 (managed)', (await call('POST', '/api/billing/change-plan', { plan: 'pro' }, C.body.token)).status === 400);
    db2.close();
  } catch (e) {
    failed++; console.log('  FAIL - exception:', e.stack || e.message);
  } finally {
    srv.kill(); fakeStripe.close();
    await sleep(300);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
