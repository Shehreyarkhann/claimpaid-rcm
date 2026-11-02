// phase-c-statements-test.cjs — Phase C (Commure parity): patient payment
// automation on statements.
//   1. reminder settings: defaults, save, cadence validation
//   2. patient email: set + validation
//   3. cadence sweep: day-0 send, dedupe on re-run, no-email skip,
//      stop-on-paid
//   4. payment plans: split math, installment derivation from recorded
//      payments, completion, second active plan refused, cancel
//   5. autodebit stays behind the Connect hold (403 FEATURE_HELD)
// NOTE: the server runs with the SHIPPED hold state (STATEMENT_PAYMENTS_HELD
// unset) — the held-state assertions are the point of section 5.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${typeof extra === 'object' ? JSON.stringify(extra).slice(0, 300) : extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 4131;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = '/tmp/phase-c-statements';
const DB = path.join(TMP, 'test.db');
let server;

async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
function dbExec(sql, ...params) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB);
  const r = db.prepare(sql).run(...params);
  db.close();
  return r;
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  try {
    server = spawn('node', ['src/index.js'], {
      cwd: path.join(__dirname, '..', 'server'),
      env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret', EHR_AUTOPULL: 'off', STRIPE_SECRET_KEY: '', AGENT_ENABLED: '1', ANTHROPIC_API_KEY: 'test-agent-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    let up = false;
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch { /* wait */ }
      await sleep(500);
    }
    check('server up', up);

    const U = await api('POST', '/api/auth/signup', { name: 'Owner C', email: 'c@test.co', password: 'Test1234!', orgName: 'Phase C Clinic' });
    const tok = U.data.token;
    check('signup', U.status === 201, U);
    await api('POST', '/api/onboarding/complete', { plan: 'pro' }, tok);

    // Seed patient responsibility: Alice owes $200 (one claim).
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(DB);
    const orgId = raw.prepare("SELECT id FROM orgs WHERE name = 'Phase C Clinic'").get().id;
    raw.prepare("INSERT INTO payers (name, type) VALUES ('Aetna', 'commercial')").run();
    const payerId = raw.prepare("SELECT id FROM payers WHERE name = 'Aetna'").get().id;
    const insClaim = raw.prepare(`INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date,
      billed_amount, paid_amount, status, adjustment_amount, patient_resp_amount, member_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?)`);
    insClaim.run(orgId, 'CLM-C1', 'Alice Patient', payerId, '2026-09-01', 300, 80, 20, 200, 'MBR-A');
    insClaim.run(orgId, 'CLM-C2', 'Bob Patient', payerId, '2026-09-05', 150, 40, 10, 100, 'MBR-B');
    raw.close();

    const gen = await api('POST', '/api/statements/generate', { patient_name: 'Alice Patient', member_id: 'MBR-A' }, tok);
    check('statement generated ($200)', gen.status === 201 && gen.data.amount_due === 200, gen);
    const stmtId = gen.data.id;

    // 1. settings
    const s0 = await api('GET', '/api/statements/reminder-settings', null, tok);
    check('settings default: disabled, cadence 0,7,14,28, autodebit held',
      s0.status === 200 && s0.data.enabled === 0 && s0.data.cadence_days === '0,7,14,28' && s0.data.autodebit?.held === true, s0.data);
    const sBad = await api('PUT', '/api/statements/reminder-settings', { enabled: true, cadence_days: 'abc' }, tok);
    check('invalid cadence refused', sBad.status === 400, sBad);
    const s1 = await api('PUT', '/api/statements/reminder-settings', { enabled: true, cadence_days: '0, 7' }, tok);
    check('settings saved (normalized)', s1.status === 200 && s1.data.enabled === 1 && s1.data.cadence_days === '0,7', s1.data);

    // 2. patient email
    const eBad = await api('POST', `/api/statements/${stmtId}/patient-email`, { email: 'not-an-email' }, tok);
    check('bad patient email refused', eBad.status === 400, eBad);
    const eOk = await api('POST', `/api/statements/${stmtId}/patient-email`, { email: 'alice@example.com' }, tok);
    check('patient email saved', eOk.status === 200 && eOk.data.patient_email === 'alice@example.com', eOk.data);

    // Sweep before the statement is "sent" (still draft) -> nothing.
    const sw0 = await api('POST', '/api/statements/reminders/run', {}, tok);
    check('draft statement is not reminded', sw0.status === 200 && sw0.data.sent === 0, sw0.data);

    // Mark it sent now; day-0 step is due immediately.
    dbExec("UPDATE patient_statements SET status = 'open', sent_at = datetime('now') WHERE id = ?", stmtId);
    const sw1 = await api('POST', '/api/statements/reminders/run', {}, tok);
    check('day-0 reminder sent', sw1.status === 200 && sw1.data.sent === 1, sw1.data);
    const rems = await api('GET', `/api/statements/${stmtId}/reminders`, null, tok);
    check('reminder recorded (sent, email, day 0)',
      rems.data.reminders.length === 1 && rems.data.reminders[0].status === 'sent'
      && rems.data.reminders[0].recipient === 'alice@example.com' && rems.data.reminders[0].cadence_day === 0, rems.data);
    const sw2 = await api('POST', '/api/statements/reminders/run', {}, tok);
    check('re-run dedupes (nothing sent)', sw2.data.sent === 0, sw2.data);

    // Bob: no email on file -> skipped with the honest reason.
    const genB = await api('POST', '/api/statements/generate', { patient_name: 'Bob Patient', member_id: 'MBR-B' }, tok);
    const bobId = genB.data.id;
    dbExec("UPDATE patient_statements SET status = 'open', sent_at = datetime('now', '-8 days') WHERE id = ?", bobId);
    const sw3 = await api('POST', '/api/statements/reminders/run', {}, tok);
    check('no-email statement is skipped, not sent', sw3.data.sent === 0 && sw3.data.skipped >= 1, sw3.data);
    const bobRems = await api('GET', `/api/statements/${bobId}/reminders`, null, tok);
    check('skip reasons recorded (day 0 superseded, day 7 no-email)',
      bobRems.data.reminders.length === 2
      && bobRems.data.reminders[0].status === 'skipped' && /Superseded/.test(bobRems.data.reminders[0].detail || '')
      && bobRems.data.reminders[1].status === 'skipped'
      && /No patient email/.test(bobRems.data.reminders[1].detail || '') && bobRems.data.reminders[1].cadence_day === 7, bobRems.data);

    // Stop-on-paid: pay Alice in full, age past day 7, sweep -> nothing.
    const pay = await api('POST', `/api/statements/${stmtId}/payments`, { amount: 200, method: 'check' }, tok);
    check('statement paid in full', pay.status === 201 && pay.data.status === 'paid', pay.data);
    dbExec("UPDATE patient_statements SET sent_at = datetime('now', '-10 days') WHERE id = ?", stmtId);
    const sw4 = await api('POST', '/api/statements/reminders/run', {}, tok);
    check('paid statement gets no further reminders', sw4.data.sent === 0, sw4.data);
    const rems2 = await api('GET', `/api/statements/${stmtId}/reminders`, null, tok);
    check('no day-7 row was created after payoff', rems2.data.reminders.length === 1, rems2.data);

    // 4. payment plans on Bob's $100 statement: 4 x $25 every 30 days.
    const plan = await api('POST', `/api/statements/${bobId}/plans`, { installments: 4, frequency_days: 30 }, tok);
    check('plan created', plan.status === 201 && plan.data.status === 'active' && plan.data.installments.length === 4, plan.data);
    check('installments sum to the balance',
      Math.abs(plan.data.installments.reduce((s, i) => s + i.amount, 0) - 100) < 0.001
      && plan.data.installments.every((i) => i.status === 'scheduled'), plan.data.installments);
    const planDup = await api('POST', `/api/statements/${bobId}/plans`, { installments: 2 }, tok);
    check('second active plan refused', planDup.status === 400, planDup);
    const planBad = await api('POST', `/api/statements/${stmtId}/plans`, { installments: 3 }, tok);
    check('plan on a paid statement refused', planBad.status === 400, planBad);
    const planId = plan.data.id;

    const pay1 = await api('POST', `/api/statements/${bobId}/payments`, { amount: 25, method: 'cash' }, tok);
    check('first installment payment recorded', pay1.status === 201, pay1.data);
    const after1 = await api('GET', `/api/statements/${bobId}`, null, tok);
    const planAfter1 = (after1.data.payment_plans || []).find((p) => p.id === planId);
    check('installment 1 derived paid from the payment',
      !!planAfter1 && planAfter1.installments[0].status === 'paid' && planAfter1.installments[1].status === 'scheduled'
      && planAfter1.status === 'active', planAfter1);

    const payRest = await api('POST', `/api/statements/${bobId}/payments`, { amount: 75, method: 'cash' }, tok);
    check('remaining balance recorded', payRest.status === 201 && payRest.data.status === 'paid', payRest.data);
    const after2 = await api('GET', `/api/statements/${bobId}`, null, tok);
    const planAfter2 = (after2.data.payment_plans || []).find((p) => p.id === planId);
    check('plan completes when the statement settles',
      !!planAfter2 && planAfter2.status === 'completed' && planAfter2.installments.every((i) => i.status === 'paid'), planAfter2);

    // Cancel path on a fresh statement/plan.
    dbExec(`INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date,
      billed_amount, paid_amount, status, adjustment_amount, patient_resp_amount, member_id)
      VALUES (?, 'CLM-C3', 'Carol Patient', ?, '2026-09-09', 90, 30, 'paid', 10, 50, 'MBR-C')`, orgId, payerId);
    const genC = await api('POST', '/api/statements/generate', { patient_name: 'Carol Patient', member_id: 'MBR-C' }, tok);
    const planC = await api('POST', `/api/statements/${genC.data.id}/plans`, { installments: 2, frequency_days: 14 }, tok);
    const cancel = await api('POST', `/api/statements/plans/${planC.data.id}/cancel`, {}, tok);
    check('plan cancel works', cancel.status === 200 && cancel.data.status === 'cancelled'
      && cancel.data.installments.every((i) => i.status === 'cancelled'), cancel.data);

    // 5. autodebit hold (shipped state)
    const ad = await api('POST', `/api/statements/${genC.data.id}/autodebit`, {}, tok);
    check('statement autodebit is HELD (403 FEATURE_HELD)', ad.status === 403 && ad.data.code === 'FEATURE_HELD', ad);
    const adp = await api('POST', `/api/statements/plans/${planC.data.id}/autodebit`, {}, tok);
    check('plan autodebit is HELD (403 FEATURE_HELD)', adp.status === 403 && adp.data.code === 'FEATURE_HELD', adp);

    // Org isolation: another org sees none of it.
    const U2 = await api('POST', '/api/auth/signup', { name: 'Other', email: 'c2@test.co', password: 'Test1234!', orgName: 'Other Clinic' });
    const plansOther = await api('GET', '/api/statements/plans', null, U2.data.token);
    check('plans are org-scoped', plansOther.status === 200 && plansOther.data.plans.length === 0, plansOther.data);
  } catch (e) {
    failed++;
    console.log('  FAIL exception:', e.stack);
  } finally {
    if (server) server.kill('SIGKILL');
    console.log(`\nphase-c-statements: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
