// phase-d-analyst-test.cjs — Phase D (Commure parity): AI data analyst.
// Deterministic analyses over the org's own data:
//   1. suggestions chips exist and map to analyses
//   2. top denial reasons: counts/billed match the seeded claims exactly
//   3. A/R aging by payer: over-90 math from service dates
//   4. denial rate by payer
//   5. payer turnaround: avg days from seeded created/updated stamps
//   6. collections by month from posted ERA lines
//   7. free-text question matching + honest no-match
//   8. scope on every answer (workspace, period, n, basis) + org isolation
//   9. asks are metered as agent turns; analyst never writes claims
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
const PORT = 4132;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = '/tmp/phase-d-analyst';
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
function dbRead(sql, ...params) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB, { readOnly: true });
  const row = db.prepare(sql).get(...params);
  db.close();
  return row;
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

    const U = await api('POST', '/api/auth/signup', { name: 'Owner D', email: 'd@test.co', password: 'Test1234!', orgName: 'Phase D Clinic' });
    const tok = U.data.token;
    await api('POST', '/api/onboarding/complete', { plan: 'pro' }, tok);

    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(DB);
    const orgId = raw.prepare("SELECT id FROM orgs WHERE name = 'Phase D Clinic'").get().id;
    raw.prepare("INSERT INTO payers (name, type, org_id) VALUES ('Aetna', 'commercial', ?)").run(orgId);
    raw.prepare("INSERT INTO payers (name, type, org_id) VALUES ('UnitedHealthcare', 'commercial', ?)").run(orgId);
    const aetna = raw.prepare("SELECT id FROM payers WHERE name = 'Aetna'").get().id;
    const uhc = raw.prepare("SELECT id FROM payers WHERE name = 'UnitedHealthcare'").get().id;
    const ins = raw.prepare(`INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date,
      billed_amount, paid_amount, status, denial_reason, member_id, created_at, last_touched_at)
      VALUES (?, ?, 'Pat Q', ?, ?, ?, ?, ?, ?, 'MBR', ?, ?)`);
    // Aetna: 3 denied (2x CO-29, 1x CO-97), 1 paid, 1 old open (over 90)
    ins.run(orgId, 'D-1', aetna, '2026-10-05', 100, 0, 'denied', 'CO-29 — timely filing', '2026-10-01 00:00:00', '2026-10-11 00:00:00');
    ins.run(orgId, 'D-2', aetna, '2026-10-06', 200, 0, 'denied', 'CO-29 — timely filing', '2026-10-01 00:00:00', '2026-10-11 00:00:00');
    ins.run(orgId, 'D-3', aetna, '2026-10-07', 300, 0, 'denied', 'CO-97 — bundled', '2026-10-01 00:00:00', '2026-10-21 00:00:00');
    ins.run(orgId, 'D-4', aetna, '2026-10-08', 150, 150, 'paid', null, '2026-10-01 00:00:00', '2026-10-06 00:00:00');
    ins.run(orgId, 'D-5', aetna, '2026-07-01', 400, 0, 'in_ar', null, '2026-07-02 00:00:00', '2026-07-02 00:00:00');
    // UHC: 1 denied, 3 paid, decided slowly (30 days)
    ins.run(orgId, 'D-6', uhc, '2026-10-05', 500, 0, 'denied', 'CO-29 — timely filing', '2026-10-01 00:00:00', '2026-10-31 00:00:00');
    ins.run(orgId, 'D-7', uhc, '2026-10-06', 100, 100, 'paid', null, '2026-10-01 00:00:00', '2026-10-31 00:00:00');
    ins.run(orgId, 'D-8', uhc, '2026-10-07', 100, 100, 'paid', null, '2026-10-01 00:00:00', '2026-10-31 00:00:00');
    ins.run(orgId, 'D-9', uhc, '2026-10-08', 100, 100, 'paid', null, '2026-10-01 00:00:00', '2026-10-31 00:00:00');
    // ERA posted lines for collections (this month + last month)
    raw.prepare("INSERT INTO era_remittances (org_id, payer_name, total_paid) VALUES (?, 'Aetna', 0)").run(orgId);
    const eraId = raw.prepare('SELECT id FROM era_remittances').get().id;
    const insLine = raw.prepare(`INSERT INTO era_claim_lines (era_id, org_id, clp_ref, billed, paid, post_status, posted_at)
      VALUES (?, ?, ?, ?, ?, 'posted', ?)`);
    insLine.run(eraId, orgId, 'D-4', 150, 150, new Date().toISOString().slice(0, 10) + ' 10:00:00');
    insLine.run(eraId, orgId, 'D-7', 100, 100, new Date().toISOString().slice(0, 10) + ' 11:00:00');
    raw.close();

    // 1. suggestions
    const sug = await api('GET', '/api/agent/analyst/suggestions', null, tok);
    check('suggestions list the chip set', sug.status === 200 && sug.data.suggestions.length >= 5
      && sug.data.suggestions.some((s) => s.analysis === 'payer_turnaround'), sug.data);

    // 2. top denial reasons (all time)
    const tdr = await api('POST', '/api/agent/analyst/ask', { analysis: 'top_denial_reasons', period: 'all' }, tok);
    check('top denial reasons matched', tdr.status === 200 && tdr.data.matched === true && tdr.data.analysis === 'top_denial_reasons', tdr.data);
    const co29 = (tdr.data.rows || []).find((r) => r.label.startsWith('CO-29'));
    check('CO-29 counted exactly (3 claims, $800 billed)', !!co29 && co29.claims === 3 && co29.billed === 800, tdr.data.rows);
    check('scope rides along (workspace, period, n, basis)',
      tdr.data.scope.workspace === 'Phase D Clinic' && tdr.data.scope.period === 'All time'
      && tdr.data.scope.n === 4 && /service date/.test(tdr.data.scope.basis), tdr.data.scope);
    check('chart bars derive from the rows', Array.isArray(tdr.data.chart.bars) && tdr.data.chart.bars[0].value === 3, tdr.data.chart);

    // 3. A/R aging: Aetna has $400 over 90 (D-5) + denied balances are open A/R too:
    //    Aetna open = D-1..D-3 denied ($600, 0-30d old in Nov) + D-5 ($400 over 90)
    const aging = await api('POST', '/api/agent/analyst/ask', { analysis: 'ar_aging_by_payer' }, tok);
    const aetnaRow = (aging.data.rows || []).find((r) => r.label === 'Aetna');
    check('A/R aging: Aetna over-90 is exactly $400', !!aetnaRow && aetnaRow.over_90 === 400, aging.data.rows);
    check('A/R aging: Aetna total open A/R is $1000', !!aetnaRow && aetnaRow.total === 1000, aetnaRow);
    check('aging summary names the over-90 total', /\$400\.00 of open A\/R is over 90/.test(aging.data.summary || ''), aging.data.summary);

    // 4. denial rate
    const rate = await api('POST', '/api/agent/analyst/ask', { analysis: 'denial_rate_by_payer', period: 'all' }, tok);
    const aRate = (rate.data.rows || []).find((r) => r.label === 'Aetna');
    const uRate = (rate.data.rows || []).find((r) => r.label === 'UnitedHealthcare');
    check('denial rates exact (Aetna 60%, UHC 25%)',
      !!aRate && aRate.rate === 60 && !!uRate && uRate.rate === 25, rate.data.rows);

    // 5. turnaround: Aetna decided avg = (10+10+20+5)/4 = 11.3; UHC = 30
    const turn = await api('POST', '/api/agent/analyst/ask', { question: 'Which payer denies fastest?' }, tok);
    check('free-text question matched to turnaround', turn.data.matched === true && turn.data.analysis === 'payer_turnaround', turn.data);
    check('turnaround order + math (Aetna 11.3d fastest, UHC 30d)',
      turn.data.rows.length === 2 && turn.data.rows[0].label === 'Aetna' && turn.data.rows[0].avg_days === 11.3
      && turn.data.rows[1].avg_days === 30, turn.data.rows);
    check('turnaround basis is labeled an approximation', /approximation/.test(turn.data.scope.basis || ''), turn.data.scope);

    // 6. collections
    const coll = await api('POST', '/api/agent/analyst/ask', { analysis: 'collections_by_month' }, tok);
    const totalCollected = (coll.data.rows || []).reduce((s, r) => s + r.collected, 0);
    check('collections sum posted ERA lines ($250)', coll.data.matched === true && totalCollected === 250 && coll.data.scope.n === 2, coll.data);

    // 7. no-match honesty
    const nm = await api('POST', '/api/agent/analyst/ask', { question: 'What is the meaning of life?' }, tok);
    check('unmatched question says so (no invented answer)', nm.status === 200 && nm.data.matched === false && Array.isArray(nm.data.supported), nm.data);

    // 8. org isolation
    const U2 = await api('POST', '/api/auth/signup', { name: 'Other', email: 'd2@test.co', password: 'Test1234!', orgName: 'Other Clinic' });
    await api('POST', '/api/onboarding/complete', { plan: 'pro' }, U2.data.token);
    const iso = await api('POST', '/api/agent/analyst/ask', { analysis: 'top_denial_reasons', period: 'all' }, U2.data.token);
    check('org isolation: other workspace sees n=0, no rows', iso.data.scope.n === 0 && iso.data.rows.length === 0, iso.data);

    // 9. metering + read-only
    const usage = dbRead('SELECT turns FROM agent_usage WHERE org_id = ?', orgId);
    check('asks metered as agent turns (>= 5)', !!usage && usage.turns >= 5, usage);
    const claimCount = dbRead('SELECT COUNT(*) AS n FROM claims WHERE org_id = ?', orgId);
    check('analyst wrote nothing (claims untouched)', claimCount.n === 9, claimCount);
  } catch (e) {
    failed++;
    console.log('  FAIL exception:', e.stack);
  } finally {
    if (server) server.kill('SIGKILL');
    console.log(`\nphase-d-analyst: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
