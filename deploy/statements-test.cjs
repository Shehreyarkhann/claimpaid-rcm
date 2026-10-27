// statements-test.cjs — deploy #50 verification.
// Part A (unit): payment allocation idempotency (webhook redelivery),
// Stripe payment-link construction with a fake client, PDF bytes.
// Part B (HTTP): balances -> generate -> lock -> PDF -> manual payments
// (partial, overpay guard, payoff) -> void releases balances -> isolation.
// Part C (HTTP, fake Stripe): payment-link route end-to-end via
// STRIPE_API_BASE — price for the remaining balance, link metadata,
// URL persisted, draft -> open.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- Part A: core unit tests -----------------------------------
async function partA() {
  console.log('Part A — statements core (unit)');
  const { DatabaseSync } = require('node:sqlite');
  const core = require('../server/src/statements-core');
  const dir = '/tmp/stmt-unit';
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const raw = new DatabaseSync(path.join(dir, 'u.db'));
  raw.exec(`
    CREATE TABLE orgs (id INTEGER PRIMARY KEY, name TEXT, billing_npi TEXT);
    CREATE TABLE claims (id INTEGER PRIMARY KEY, patient_paid_amount REAL NOT NULL DEFAULT 0);
    CREATE TABLE patient_statements (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER, statement_number TEXT,
      patient_name TEXT, member_id TEXT, amount_due REAL, amount_paid REAL DEFAULT 0, status TEXT DEFAULT 'draft',
      payment_link_id TEXT, payment_link_url TEXT, due_date TEXT, created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now')), sent_at TEXT, paid_at TEXT);
    CREATE TABLE statement_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, statement_id INTEGER, claim_id INTEGER,
      claim_number TEXT, service_date TEXT, payer_name TEXT, billed REAL, insurance_paid REAL, adjustments REAL,
      patient_resp REAL, amount REAL, allocated_paid REAL DEFAULT 0);
    CREATE TABLE statement_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, statement_id INTEGER, org_id INTEGER,
      amount REAL, method TEXT, external_id TEXT UNIQUE, created_at TEXT DEFAULT (datetime('now')));
    INSERT INTO orgs VALUES (1, 'Test Practice', '1234567893');
    INSERT INTO claims (id) VALUES (11), (12);
    INSERT INTO patient_statements (id, org_id, statement_number, patient_name, amount_due, status)
      VALUES (1, 1, 'STMT-00001', 'Pat One', 65, 'open');
    INSERT INTO statement_lines (statement_id, claim_id, claim_number, service_date, payer_name, billed, insurance_paid, adjustments, patient_resp, amount)
      VALUES (1, 11, 'C-1', '2026-09-01', 'Aetna', 100, 60, 15, 25, 25),
             (1, 12, 'C-2', '2026-09-15', 'Aetna', 120, 60, 20, 40, 40);
  `);
  const db = {
    prepare: (sql) => { const s = raw.prepare(sql); return { get: (...p) => s.get(...p), all: (...p) => s.all(...p), run: (...p) => s.run(...p) }; },
    exec: (sql) => raw.exec(sql),
  };

  // Webhook-style settle + redelivery must not double-apply.
  const p1 = core.recordPayment(db, { orgId: 1, statementId: 1, amount: 65, method: 'stripe', externalId: 'stripe:pi_1' });
  check('stripe settle pays the statement in full', p1.statement.status === 'paid' && p1.statement.amount_paid === 65, JSON.stringify(p1.statement).slice(0, 160));
  const p2 = core.recordPayment(db, { orgId: 1, statementId: 1, amount: 65, method: 'stripe', externalId: 'stripe:pi_1' });
  check('redelivered webhook is a duplicate, not a second payment', p2.duplicate === true, JSON.stringify(p2).slice(0, 120));
  const claimPaid = raw.prepare('SELECT SUM(patient_paid_amount) t FROM claims').get().t;
  check('claims allocated exactly once (25 + 40)', claimPaid === 65, `got ${claimPaid}`);

  // Payment link construction: one-off price for the REMAINING balance.
  const calls = {};
  const fakeStripe = {
    prices: { create: async (a) => { calls.price = a; return { id: 'price_x' }; } },
    paymentLinks: { create: async (a) => { calls.link = a; return { id: 'plink_x', url: 'https://buy.stripe.com/test_x' }; } },
  };
  const link = await core.createStripePaymentLink(fakeStripe,
    { id: 7, org_id: 3, statement_number: 'STMT-00007', amount_due: 100, amount_paid: 30 }, 'Test Practice');
  check('link charges the remaining balance ($70 -> 7000c)', calls.price.unit_amount === 7000, JSON.stringify(calls.price));
  check('link metadata carries statement + org', calls.link.metadata.statement_id === '7' && calls.link.metadata.org_id === '3', JSON.stringify(calls.link.metadata));
  check('link uses after_completion (not the rejected after_payment)', !!calls.link.after_completion && calls.link.after_completion.type === 'redirect' && !('after_payment' in calls.link), JSON.stringify(Object.keys(calls.link)));
  check('link opts out of Managed Payments (patient statements are never MoR-eligible)', !!calls.link.managed_payments && calls.link.managed_payments.enabled === false, JSON.stringify(calls.link.managed_payments));
  check('link returns id + url', link.id === 'plink_x' && link.url.includes('buy.stripe.com'));

  // PDF: valid header, carries the statement number, multi-line content.
  const out = core.statementPdf(db, 1, 1);
  const head = out.buffer.slice(0, 5).toString('latin1');
  const body = out.buffer.toString('latin1');
  check('PDF header + EOF', head === '%PDF-' && body.includes('%%EOF'), head);
  check('PDF shows statement number + patient', body.includes('STMT-00001') && body.includes('Pat One'));
  check('PDF shows the total due', body.includes('65.00'));
  raw.close();
}

// ---------------- Part B: HTTP lifecycle ------------------------------------
const PORT = 4110;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = '/tmp/stmt-api';
const DB = path.join(TMP, 'test.db');
let server;

async function api(method, p, body, token, raw) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') };
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function partB() {
  console.log('Part B — statements lifecycle (HTTP)');
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  server = spawn('node', ['src/index.js'], {
    cwd: path.join(__dirname, '..', 'server'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret', EHR_AUTOPULL: 'off', STRIPE_SECRET_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch { /* wait */ }
    await sleep(500);
  }
  const s = await api('POST', '/api/auth/signup', { orgName: 'Stmt Org', name: 'Owner', email: 'stmt@test.co', password: 'Test1234!' });
  const t = s.data.token;
  check('signup', s.status === 201, JSON.stringify(s.data).slice(0, 150));

  // Seed: payer + claims carrying ERA patient responsibility.
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(DB);
  const orgId = raw.prepare("SELECT id FROM orgs WHERE name = 'Stmt Org'").get().id;
  raw.prepare("INSERT INTO payers (name, type) VALUES ('Aetna', 'commercial')").run();
  const payerId = raw.prepare("SELECT id FROM payers WHERE name = 'Aetna'").get().id;
  const insClaim = raw.prepare(`INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date,
    billed_amount, paid_amount, status, adjustment_amount, patient_resp_amount, member_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?)`);
  insClaim.run(orgId, 'CLM-A1', 'Alice Patient', payerId, '2026-08-01', 100, 60, 15, 25, 'MBR-A');
  insClaim.run(orgId, 'CLM-A2', 'Alice Patient', payerId, '2026-08-20', 120, 60, 20, 40, 'MBR-A');
  insClaim.run(orgId, 'CLM-B1', 'Bob Patient', payerId, '2026-09-02', 80, 40, 10, 30, 'MBR-B');
  raw.close();

  const unauth = await api('GET', '/api/statements/balances');
  check('balances require auth', unauth.status === 401, `got ${unauth.status}`);

  const bal = await api('GET', '/api/statements/balances', null, t);
  const alice = (bal.data.patients || []).find((p) => p.patient_name === 'Alice Patient');
  const bob = (bal.data.patients || []).find((p) => p.patient_name === 'Bob Patient');
  check('balances group by patient (Alice $65 over 2 claims, Bob $30)', !!alice && alice.total_due === 65 && alice.claims === 2 && !!bob && bob.total_due === 30, JSON.stringify(bal.data).slice(0, 220));

  const gen = await api('POST', '/api/statements/generate', { patient_name: 'Alice Patient', member_id: 'MBR-A' }, t);
  check('statement generated', gen.status === 201 && gen.data.amount_due === 65 && gen.data.lines.length === 2, JSON.stringify(gen.data).slice(0, 220));
  const stmtId = gen.data.id;
  check('statement number format', /^STMT-\d{5}$/.test(gen.data.statement_number), gen.data.statement_number);

  const bal2 = await api('GET', '/api/statements/balances', null, t);
  check('generated patient leaves balances (claims locked)', !(bal2.data.patients || []).some((p) => p.patient_name === 'Alice Patient'), JSON.stringify(bal2.data).slice(0, 160));
  const genDup = await api('POST', '/api/statements/generate', { patient_name: 'Alice Patient', member_id: 'MBR-A' }, t);
  check('double-billing the same claims is refused', genDup.status === 400, `got ${genDup.status}`);

  const pdf = await api('GET', `/api/statements/${stmtId}/pdf`, null, t, true);
  check('PDF downloads', pdf.status === 200 && pdf.type.includes('application/pdf') && pdf.buf.slice(0, 5).toString('latin1') === '%PDF-', `status ${pdf.status} type ${pdf.type}`);

  const link = await api('POST', `/api/statements/${stmtId}/payment-link`, {}, t);
  check('payment link 503s honestly without a Stripe key', link.status === 503 && /not configured/i.test(link.data.error || ''), `got ${link.status} ${JSON.stringify(link.data).slice(0, 140)}`);

  const part = await api('POST', `/api/statements/${stmtId}/payments`, { amount: 25, method: 'check' }, t);
  check('partial payment -> partially_paid, balance $40', part.status === 201 && part.data.status === 'partially_paid' && part.data.balance === 40, JSON.stringify(part.data).slice(0, 200));
  const over = await api('POST', `/api/statements/${stmtId}/payments`, { amount: 41, method: 'cash' }, t);
  check('overpayment refused', over.status === 400, `got ${over.status}`);
  const full = await api('POST', `/api/statements/${stmtId}/payments`, { amount: 40, method: 'cash' }, t);
  check('payoff -> paid with paid_at', full.status === 201 && full.data.status === 'paid' && !!full.data.paid_at, JSON.stringify(full.data).slice(0, 200));
  const bal3 = await api('GET', '/api/statements/balances', null, t);
  check('paid patient has no balance', !(bal3.data.patients || []).some((p) => p.patient_name === 'Alice Patient'));

  // Void releases the patient's claims back to balances.
  const genB = await api('POST', '/api/statements/generate', { patient_name: 'Bob Patient', member_id: 'MBR-B' }, t);
  const voided = await api('POST', `/api/statements/${genB.data.id}/void`, {}, t);
  check('void works on an unpaid statement', voided.status === 200 && voided.data.status === 'void', JSON.stringify(voided.data).slice(0, 140));
  const bal4 = await api('GET', '/api/statements/balances', null, t);
  check('voided claims return to balances', (bal4.data.patients || []).some((p) => p.patient_name === 'Bob Patient' && p.total_due === 30), JSON.stringify(bal4.data).slice(0, 160));
  const genB2 = await api('POST', '/api/statements/generate', { patient_name: 'Bob Patient', member_id: 'MBR-B' }, t);
  check('regenerate after void works', genB2.status === 201, `got ${genB2.status}`);

  // Cross-org isolation.
  const s2 = await api('POST', '/api/auth/signup', { orgName: 'Other Org', name: 'Owner', email: 'other@test.co', password: 'Test1234!' });
  const alien = await api('GET', `/api/statements/${stmtId}`, null, s2.data.token);
  check('another org cannot read the statement', alien.status === 404, `got ${alien.status}`);
  const list = await api('GET', '/api/statements', null, t);
  check('statement list returns both statements with balances', Array.isArray(list.data) && list.data.length === 3 && list.data.every((r) => 'balance' in r), JSON.stringify(list.data).slice(0, 160));
}

// ---------------- Part C: payment link against a fake Stripe API -----------
// The route's Stripe client must honor STRIPE_API_BASE exactly like
// billing.js, create a one-off Price for the remaining balance, then a
// Payment Link carrying statement metadata, and persist the URL + flip
// draft -> open. (Deploy #75: this path was previously untestable.)
const C_PORT = 4111;
const C_BASE = `http://127.0.0.1:${C_PORT}`;
const C_TMP = '/tmp/stmt-api-link';
const C_DB = path.join(C_TMP, 'test.db');
const FAKE_PORT = 4112;
let serverC, fakeStripe;

async function apiC(method, p, body, token) {
  const res = await fetch(C_BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function partC() {
  console.log('Part C — payment link (HTTP, fake Stripe)');
  const http = require('http');
  const seen = { prices: null, links: null };
  fakeStripe = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      const params = new URLSearchParams(body);
      if (req.method === 'POST' && req.url === '/v1/prices') {
        seen.prices = Object.fromEntries(params.entries());
        return res.end(JSON.stringify({ id: 'price_fake', object: 'price' }));
      }
      if (req.method === 'POST' && req.url === '/v1/payment_links') {
        seen.links = Object.fromEntries(params.entries());
        return res.end(JSON.stringify({ id: 'plink_fake', object: 'payment_link', url: 'https://buy.stripe.com/fake_123', active: true }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'fake stripe: unhandled ' + req.method + ' ' + req.url } }));
    });
  });
  await new Promise((r) => fakeStripe.listen(FAKE_PORT, r));

  fs.rmSync(C_TMP, { recursive: true, force: true });
  fs.mkdirSync(C_TMP, { recursive: true });
  serverC = spawn('node', ['src/index.js'], {
    cwd: path.join(__dirname, '..', 'server'),
    env: {
      ...process.env, PORT: String(C_PORT), DB_PATH: C_DB, JWT_SECRET: 'test-secret', EHR_AUTOPULL: 'off',
      STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_API_BASE: `http://127.0.0.1:${FAKE_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverC.stderr.on('data', (d) => process.stderr.write(`[serverC] ${d}`));
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(C_BASE + '/api/health'); if (r.ok) break; } catch { /* wait */ }
    await sleep(500);
  }
  const s = await apiC('POST', '/api/auth/signup', { orgName: 'Link Org', name: 'Owner', email: 'link@test.co', password: 'Test1234!' });
  const t = s.data.token;
  check('signup (link org)', s.status === 201, JSON.stringify(s.data).slice(0, 150));

  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(C_DB);
  const orgId = raw.prepare("SELECT id FROM orgs WHERE name = 'Link Org'").get().id;
  raw.prepare("INSERT INTO payers (name, type) VALUES ('Cigna', 'commercial')").run();
  const payerId = raw.prepare("SELECT id FROM payers WHERE name = 'Cigna'").get().id;
  raw.prepare(`INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date,
    billed_amount, paid_amount, status, adjustment_amount, patient_resp_amount, member_id)
    VALUES (?, 'CLM-C1', 'Carol Patient', ?, '2026-08-05', 100, 35, 'paid', 0, 65, 'MBR-C')`).run(orgId, payerId);
  raw.close();

  const gen = await apiC('POST', '/api/statements/generate', { patient_name: 'Carol Patient', member_id: 'MBR-C' }, t);
  check('statement generated (link org)', gen.status === 201 && gen.data.amount_due === 65, JSON.stringify(gen.data).slice(0, 200));
  const stmtId = gen.data.id;

  const link = await apiC('POST', `/api/statements/${stmtId}/payment-link`, {}, t);
  check('payment link created via Stripe API', link.status === 200 && link.data.payment_link_url === 'https://buy.stripe.com/fake_123',
    `got ${link.status} ${JSON.stringify(link.data).slice(0, 200)}`);
  check('statement flips draft -> open with link id stored', link.data.status === 'open' && link.data.payment_link_id === 'plink_fake',
    JSON.stringify(link.data).slice(0, 200));
  check('Stripe price charges the remaining balance ($65 -> 6500c)',
    !!seen.prices && seen.prices.unit_amount === '6500' && seen.prices.currency === 'usd', JSON.stringify(seen.prices));
  check('Stripe price uses the created price + statement metadata',
    !!seen.links && seen.links['line_items[0][price]'] === 'price_fake' && seen.links['metadata[statement_id]'] === String(stmtId),
    JSON.stringify(seen.links));

  const detail = await apiC('GET', `/api/statements/${stmtId}`, null, t);
  check('detail returns the stored pay link', detail.status === 200 && detail.data.payment_link_url === 'https://buy.stripe.com/fake_123');
  const list = await apiC('GET', '/api/statements', null, t);
  check('list returns the pay link for row actions', Array.isArray(list.data) && list.data[0]?.payment_link_url === 'https://buy.stripe.com/fake_123',
    JSON.stringify(list.data).slice(0, 160));

  serverC.kill(); serverC = null;
  fakeStripe.close(); fakeStripe = null;
}

(async () => {
  try { await partA(); } catch (e) { failed++; console.log('  FAIL Part A threw:', e.message); }
  try { await partB(); } catch (e) { failed++; console.log('  FAIL Part B threw:', e.message); }
  try { await partC(); } catch (e) { failed++; console.log('  FAIL Part C threw:', e.message); }
  if (server) server.kill();
  if (serverC) serverC.kill();
  if (fakeStripe) fakeStripe.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
