// connect-payments-test.cjs — Stripe Connect (Express) statement payouts.
// Verifies the founder's money-direction rule: patient payments settle to
// the PRACTICE's own Stripe account, never ClaimPaid's platform account.
//   A (HTTP, fake Stripe): connect creates an Express account with the
//     right capabilities, stores the id, returns an onboarding URL; status
//     reflects accounts.retrieve; re-connect mints a fresh link without a
//     second account; disconnect clears the id (Stripe account NOT deleted).
//   B (HTTP, fake Stripe): pay link for a NON-connected org -> 409
//     STRIPE_NOT_CONNECTED with ZERO Stripe calls; for a connected org the
//     price + link are created with the Stripe-Account header, the
//     Managed Payments opt-out, and the pinned API version.
//   C (webhook): a signed checkout.session.completed on the Connect
//     endpoint settles the statement via recordPayment; redelivery is a
//     no-op; an event from a DIFFERENT connected account does not settle;
//     a bad signature is rejected; without STRIPE_CONNECT_WEBHOOK_SECRET
//     the endpoint answers 503 JSON instead of crashing.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const APP_PORT = 4120;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const FAKE_PORT = 4121;
const APP2_PORT = 4122;
const BASE2 = `http://127.0.0.1:${APP2_PORT}`;
const TMP = '/tmp/connect-pay-test';
const DB = path.join(TMP, 'test.db');
const DB2 = path.join(TMP, 'test2.db');
const CONNECT_SECRET = 'whsec_connect_test';
let server, server2, fakeStripe;

// Fake Stripe state: accounts keyed by id so the test can simulate
// onboarding completion between calls.
const fake = {
  accounts: new Map(),
  acctSeq: 0,
  calls: { accountsCreate: [], accountLinks: [], accountsRetrieve: 0, prices: [], links: [] },
};

function startFakeStripe() {
  fakeStripe = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      const params = Object.fromEntries(new URLSearchParams(body).entries());
      const send = (code, obj) => { res.statusCode = code; res.end(JSON.stringify(obj)); };

      if (req.method === 'POST' && req.url === '/v1/accounts') {
        fake.acctSeq += 1;
        const id = `acct_fake${100 + fake.acctSeq}`;
        const acct = {
          id, object: 'account', type: 'express',
          charges_enabled: false, payouts_enabled: false, details_submitted: false,
          requirements: { currently_due: ['external_account'], eventually_due: [], past_due: [] },
        };
        fake.accounts.set(id, acct);
        fake.calls.accountsCreate.push(params);
        return send(200, acct);
      }
      const acctMatch = req.url.match(/^\/v1\/accounts\/(acct_[A-Za-z0-9]+)$/);
      if (req.method === 'GET' && acctMatch) {
        fake.calls.accountsRetrieve += 1;
        const acct = fake.accounts.get(acctMatch[1]);
        if (!acct) return send(404, { error: { message: 'No such account' } });
        return send(200, acct);
      }
      if (req.method === 'POST' && req.url === '/v1/account_links') {
        fake.calls.accountLinks.push(params);
        return send(200, { object: 'account_link', url: 'https://connect.stripe.com/setup/fake_link', expires_at: 9999999999 });
      }
      if (req.method === 'POST' && req.url === '/v1/prices') {
        fake.calls.prices.push({ params, acct: req.headers['stripe-account'] || null, version: req.headers['stripe-version'] || null });
        return send(200, { id: 'price_fake', object: 'price' });
      }
      if (req.method === 'POST' && req.url === '/v1/payment_links') {
        fake.calls.links.push({ params, acct: req.headers['stripe-account'] || null, version: req.headers['stripe-version'] || null });
        return send(200, { id: 'plink_fake', object: 'payment_link', url: 'https://buy.stripe.com/fake_connect', active: true });
      }
      return send(404, { error: { message: 'fake stripe: unhandled ' + req.method + ' ' + req.url } });
    });
  });
  return new Promise((r) => fakeStripe.listen(FAKE_PORT, r));
}

async function api(base, method, p, body, token) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function bootServer(port, dbPath, extraEnv) {
  fs.mkdirSync(TMP, { recursive: true });
  const srv = spawn('node', ['src/index.js'], {
    cwd: path.join(__dirname, '..', 'server'),
    env: {
      ...process.env, PORT: String(port), DB_PATH: dbPath, JWT_SECRET: 'test-secret', EHR_AUTOPULL: 'off',
      STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_API_BASE: `http://127.0.0.1:${FAKE_PORT}`,
      APP_URL: `http://127.0.0.1:${port}`,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => process.stderr.write(`[server:${port}] ${d}`));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch { /* wait */ }
    await sleep(500);
  }
  return srv;
}

function signConnectWebhook(payloadObj) {
  const payload = JSON.stringify(payloadObj);
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', CONNECT_SECRET).update(`${ts}.${payload}`, 'utf8').digest('hex');
  return { payload, header: `t=${ts},v1=${sig}` };
}

async function postWebhook(base, payload, header) {
  const res = await fetch(base + '/api/billing/webhook/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header },
    body: payload,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, text: JSON.stringify(data) };
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  await startFakeStripe();
  try {
    server = await bootServer(APP_PORT, DB, { STRIPE_CONNECT_WEBHOOK_SECRET: CONNECT_SECRET });

    console.log('Part A — Connect onboarding + status (HTTP, fake Stripe)');
    const s = await api(BASE, 'POST', '/api/auth/signup', { orgName: 'Connect Org', name: 'Owner', email: 'connect@test.co', password: 'Test1234!' });
    check('owner signup', s.status === 201, JSON.stringify(s.data).slice(0, 150));
    const t = s.data.token;
    const orgId = s.data.user.org_id;

    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(DB);
    const orgRow = () => raw.prepare('SELECT stripe_account_id FROM orgs WHERE id = ?').get(orgId);
    check('orgs.stripe_account_id column exists (migration)', 'stripe_account_id' in (orgRow() || {}), JSON.stringify(orgRow()));

    const unauth = await api(BASE, 'GET', '/api/settings/payments');
    check('payments status requires auth', unauth.status === 401, `got ${unauth.status}`);

    // Role gate: a biller member of the same org is refused (owner-only).
    const s2 = await api(BASE, 'POST', '/api/auth/signup', { orgName: 'Biller Home', name: 'Biller', email: 'biller@test.co', password: 'Test1234!' });
    const billerId = s2.data.user.id;
    raw.prepare('INSERT OR IGNORE INTO user_orgs (user_id, org_id, role) VALUES (?, ?, ?)').run(billerId, orgId, 'biller');
    const sw = await api(BASE, 'POST', '/api/auth/switch', { org_id: orgId }, s2.data.token);
    check('biller can switch into the org', sw.status === 200 && !!sw.data.token, `got ${sw.status} ${JSON.stringify(sw.data).slice(0, 120)}`);
    const billerStatus = await api(BASE, 'GET', '/api/settings/payments', null, sw.data.token);
    check('payments endpoints are owner-only', billerStatus.status === 403, `got ${billerStatus.status}`);

    const st0 = await api(BASE, 'GET', '/api/settings/payments', null, t);
    check('status: not connected initially', st0.status === 200 && st0.data.connected === false, JSON.stringify(st0.data));

    const c1 = await api(BASE, 'POST', '/api/settings/payments/connect', {}, t);
    check('connect returns a Stripe onboarding URL', c1.status === 200 && /connect\.stripe\.com/.test(c1.data.url || ''), `got ${c1.status} ${JSON.stringify(c1.data).slice(0, 160)}`);
    check('exactly one Express account created', fake.calls.accountsCreate.length === 1, `got ${fake.calls.accountsCreate.length}`);
    const createBody = fake.calls.accountsCreate[0] || {};
    check('account is Express + US with card_payments and transfers requested',
      createBody.type === 'express' && createBody.country === 'US'
      && createBody['capabilities[card_payments][requested]'] === 'true'
      && createBody['capabilities[transfers][requested]'] === 'true',
      JSON.stringify(createBody));
    check('account metadata carries the org id', createBody['metadata[org_id]'] === String(orgId), JSON.stringify(createBody));
    const acctId = orgRow().stripe_account_id;
    check('account id stored on the org', !!acctId && fake.accounts.has(acctId), `stored ${acctId}`);
    const linkBody = fake.calls.accountLinks[0] || {};
    check('onboarding link targets the account and returns to Settings -> Payments',
      linkBody.account === acctId && linkBody.type === 'account_onboarding'
      && /settings=payments/.test(linkBody.return_url || '') && /settings=payments/.test(linkBody.refresh_url || ''),
      JSON.stringify(linkBody));

    const c2 = await api(BASE, 'POST', '/api/settings/payments/connect', {}, t);
    check('re-connect (continue setup) mints a fresh link, no second account',
      c2.status === 200 && !!c2.data.url && fake.calls.accountsCreate.length === 1 && fake.calls.accountLinks.length === 2,
      `creates=${fake.calls.accountsCreate.length} links=${fake.calls.accountLinks.length}`);

    const st1 = await api(BASE, 'GET', '/api/settings/payments', null, t);
    check('status reflects retrieve (incomplete onboarding)',
      st1.status === 200 && st1.data.connected === true && st1.data.account_id === acctId
      && st1.data.charges_enabled === false && st1.data.details_submitted === false
      && Array.isArray(st1.data.requirements_due) && st1.data.requirements_due.includes('external_account'),
      JSON.stringify(st1.data));

    const acct = fake.accounts.get(acctId);
    acct.details_submitted = true; acct.charges_enabled = true; acct.payouts_enabled = true;
    acct.requirements.currently_due = [];
    const st2 = await api(BASE, 'GET', '/api/settings/payments', null, t);
    check('status reflects completed onboarding',
      st2.data.connected === true && st2.data.charges_enabled === true && st2.data.payouts_enabled === true
      && st2.data.details_submitted === true && st2.data.requirements_due.length === 0,
      JSON.stringify(st2.data));

    const auditRows = raw.prepare("SELECT action FROM audit_log WHERE org_id = ? AND action LIKE 'org.stripe_connect%'").all(orgId).map((r) => r.action);
    check('connect is audit-logged', auditRows.includes('org.stripe_connect.connected'), JSON.stringify(auditRows));

    console.log('Part B — pay-link gate + on-account creation');
    // Seed a payable statement for org A.
    raw.prepare("INSERT INTO payers (name, type) VALUES ('Aetna', 'commercial')").run();
    const payerId = raw.prepare("SELECT id FROM payers WHERE name = 'Aetna'").get().id;
    const insClaim = raw.prepare(`INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date,
      billed_amount, paid_amount, status, adjustment_amount, patient_resp_amount, member_id)
      VALUES (?, ?, ?, ?, '2026-08-01', 200, 100, 'paid', 20, ?, ?)`);
    insClaim.run(orgId, 'CLM-P1', 'Pat One', payerId, 80, 'MBR-P1');
    insClaim.run(orgId, 'CLM-P2', 'Pat Two', payerId, 50, 'MBR-P2');
    const gen1 = await api(BASE, 'POST', '/api/statements/generate', { patient_name: 'Pat One', member_id: 'MBR-P1' }, t);
    const gen2 = await api(BASE, 'POST', '/api/statements/generate', { patient_name: 'Pat Two', member_id: 'MBR-P2' }, t);
    check('statements generated', gen1.status === 201 && gen2.status === 201, `${gen1.status}/${gen2.status}`);
    const stmt1 = gen1.data.id, stmt2 = gen2.data.id;

    // Disconnect, then the pay link must refuse — with ZERO Stripe calls.
    const disc = await api(BASE, 'POST', '/api/settings/payments/disconnect', {}, t);
    check('disconnect returns connected:false and clears the stored id',
      disc.status === 200 && disc.data.connected === false && !orgRow().stripe_account_id,
      `got ${disc.status} ${JSON.stringify(disc.data)} stored=${orgRow().stripe_account_id}`);
    const auditRows2 = raw.prepare("SELECT action FROM audit_log WHERE org_id = ? AND action LIKE 'org.stripe_connect%'").all(orgId).map((r) => r.action);
    check('disconnect is audit-logged', auditRows2.includes('org.stripe_connect.disconnected'), JSON.stringify(auditRows2));
    check('disconnect did NOT delete the Stripe account', fake.accounts.has(acctId));
    const stDisc = await api(BASE, 'GET', '/api/settings/payments', null, t);
    check('status after disconnect: not connected', stDisc.data.connected === false, JSON.stringify(stDisc.data));

    const pricesBefore = fake.calls.prices.length, linksBefore = fake.calls.links.length;
    const gated = await api(BASE, 'POST', `/api/statements/${stmt1}/payment-link`, {}, t);
    check('pay link for a non-connected org -> 409 STRIPE_NOT_CONNECTED',
      gated.status === 409 && gated.data.code === 'STRIPE_NOT_CONNECTED' && /Connect a Stripe account/.test(gated.data.error || ''),
      `got ${gated.status} ${JSON.stringify(gated.data).slice(0, 160)}`);
    check('gate created NOTHING on Stripe (no price, no link, no platform fallback)',
      fake.calls.prices.length === pricesBefore && fake.calls.links.length === linksBefore,
      `prices ${pricesBefore}->${fake.calls.prices.length} links ${linksBefore}->${fake.calls.links.length}`);
    const stmtAfterGate = await api(BASE, 'GET', `/api/statements/${stmt1}`, null, t);
    check('statement unchanged by the refused link (still draft, no URL)',
      stmtAfterGate.data.status === 'draft' && !stmtAfterGate.data.payment_link_url, JSON.stringify(stmtAfterGate.data).slice(0, 160));

    // Reconnect: a NEW Express account is created (the old id was cleared).
    const c3 = await api(BASE, 'POST', '/api/settings/payments/connect', {}, t);
    const acctId2 = orgRow().stripe_account_id;
    check('reconnect after disconnect creates a fresh account', c3.status === 200 && !!acctId2 && acctId2 !== acctId && fake.calls.accountsCreate.length === 2,
      `stored ${acctId2} creates=${fake.calls.accountsCreate.length}`);

    const linked = await api(BASE, 'POST', `/api/statements/${stmt1}/payment-link`, {}, t);
    check('pay link created for the connected org', linked.status === 200 && linked.data.payment_link_url === 'https://buy.stripe.com/fake_connect' && linked.data.status === 'open',
      `got ${linked.status} ${JSON.stringify(linked.data).slice(0, 200)}`);
    const priceCall = fake.calls.prices[fake.calls.prices.length - 1];
    const linkCall = fake.calls.links[fake.calls.links.length - 1];
    check('price created ON the connected account', !!priceCall && priceCall.acct === acctId2, JSON.stringify(priceCall));
    check('link created ON the connected account', !!linkCall && linkCall.acct === acctId2, JSON.stringify(linkCall));
    check('link keeps the Managed Payments opt-out + pinned API version',
      !!linkCall && linkCall.params['managed_payments[enabled]'] === 'false' && linkCall.version === '2026-03-25.preview',
      JSON.stringify(linkCall));
    check('no application fee taken (practice gets the full amount)',
      !!linkCall && !('application_fee_amount' in linkCall.params) && !Object.keys(linkCall.params).some((k) => k.startsWith('application_fee')),
      JSON.stringify(linkCall && linkCall.params));
    check('link metadata carries statement + org',
      !!linkCall && linkCall.params['metadata[statement_id]'] === String(stmt1) && linkCall.params['metadata[org_id]'] === String(orgId),
      JSON.stringify(linkCall && linkCall.params));

    console.log('Part C — Connect webhook settlement');
    const evt = {
      id: 'evt_test_1', type: 'checkout.session.completed', account: acctId2,
      data: {
        object: {
          id: 'cs_test_1', object: 'checkout.session', payment_intent: 'pi_test_1', amount_total: 8000,
          metadata: { statement_id: String(stmt1), org_id: String(orgId), kind: 'patient_statement' },
        },
      },
    };
    const signed = signConnectWebhook(evt);
    const wh1 = await postWebhook(BASE, signed.payload, signed.header);
    check('connect webhook accepts a validly signed event', wh1.status === 200 && wh1.data.received === true, `got ${wh1.status} ${wh1.text}`);
    const afterPay = await api(BASE, 'GET', `/api/statements/${stmt1}`, null, t);
    check('webhook settles the statement (paid in full via recordPayment)',
      afterPay.data.status === 'paid' && afterPay.data.amount_paid === 80 && (afterPay.data.payments || []).length === 1
      && afterPay.data.payments[0].method === 'stripe',
      JSON.stringify(afterPay.data).slice(0, 240));

    const wh2 = await postWebhook(BASE, signed.payload, signed.header);
    const afterReplay = await api(BASE, 'GET', `/api/statements/${stmt1}`, null, t);
    check('redelivered event is idempotent (no double allocation)',
      wh2.status === 200 && afterReplay.data.amount_paid === 80 && (afterReplay.data.payments || []).length === 1,
      `paid=${afterReplay.data.amount_paid} payments=${(afterReplay.data.payments || []).length}`);

    const evtWrongAcct = JSON.parse(JSON.stringify(evt));
    evtWrongAcct.id = 'evt_test_2';
    evtWrongAcct.account = 'acct_someone_else';
    evtWrongAcct.data.object.id = 'cs_test_2';
    evtWrongAcct.data.object.payment_intent = 'pi_test_2';
    evtWrongAcct.data.object.amount_total = 5000;
    evtWrongAcct.data.object.metadata.statement_id = String(stmt2);
    const signedWrong = signConnectWebhook(evtWrongAcct);
    const wh3 = await postWebhook(BASE, signedWrong.payload, signedWrong.header);
    const stmt2After = await api(BASE, 'GET', `/api/statements/${stmt2}`, null, t);
    check("an event from a different connected account does NOT settle this org's statement",
      wh3.status === 200 && stmt2After.data.status === 'draft' && stmt2After.data.amount_paid === 0,
      `wh=${wh3.status} stmt status=${stmt2After.data.status} paid=${stmt2After.data.amount_paid}`);

    const whBad = await postWebhook(BASE, signed.payload, 't=1,v1=deadbeef');
    check('bad signature is rejected', whBad.status === 400, `got ${whBad.status}`);

    raw.close();
  } catch (e) {
    failed++;
    console.log('  FAIL suite threw:', e.stack || e.message);
  } finally {
    if (server) server.kill();
  }

  // Unconfigured secret: graceful 503 JSON, no crash.
  try {
    console.log('Part D — Connect webhook without a configured secret');
    server2 = await bootServer(APP2_PORT, DB2, {});
    const { payload, header } = signConnectWebhook({ id: 'evt_x', type: 'checkout.session.completed', data: { object: {} } });
    const r = await postWebhook(BASE2, payload, header);
    check('unset STRIPE_CONNECT_WEBHOOK_SECRET -> 503 JSON (graceful)',
      r.status === 503 && r.data.error === 'connect webhook not configured', `got ${r.status} ${r.text}`);
    const health = await fetch(BASE2 + '/api/health');
    check('server still healthy after the unconfigured webhook hit', health.ok);
  } catch (e) {
    failed++;
    console.log('  FAIL Part D threw:', e.stack || e.message);
  } finally {
    if (server2) server2.kill();
    if (fakeStripe) fakeStripe.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
