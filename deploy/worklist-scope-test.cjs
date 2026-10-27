// worklist-scope-test.cjs — deploy #75 verification for the My Work
// Team queue / Assigned to me scopes.
// Bug: scope=mine only filtered overdue follow-ups; the filing, denial and
// stale sections ignored the scope, so "Assigned to me" showed the whole
// team queue. Assignment lives on appeals (claims have no assignee), so a
// claim-derived item is "mine" only when an OPEN appeal on that claim is
// assigned to me; unworked denials (no appeal by construction) are
// team-queue only.
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
const dstr = (daysFromNow) => new Date(Date.now() + daysFromNow * 86400000).toISOString().slice(0, 10);

const PORT = 4120;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = '/tmp/worklist-scope';
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

(async () => {
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

  const s = await api('POST', '/api/auth/signup', { orgName: 'WL Org', name: 'Olivia Owner', email: 'owner@wl.test', password: 'Test1234!' });
  const ownerToken = s.data.token;
  check('owner signup', s.status === 201 && !!ownerToken, JSON.stringify(s.data).slice(0, 150));

  const add = await api('POST', '/api/auth/team', { name: 'Bee Biller', email: 'biller@wl.test', password: 'Test1234!', role: 'biller' }, ownerToken);
  check('biller added to org', add.status === 201, `got ${add.status} ${JSON.stringify(add.data).slice(0, 140)}`);
  const bl = await api('POST', '/api/auth/login', { email: 'biller@wl.test', password: 'Test1234!' });
  const billerToken = bl.data.token;
  check('biller login', !!billerToken, JSON.stringify(bl.data).slice(0, 140));

  // Seed the scenario directly (established suite pattern).
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(DB);
  const orgId = raw.prepare("SELECT id FROM orgs WHERE name = 'WL Org'").get().id;
  const ownerId = raw.prepare("SELECT id FROM users WHERE email = 'owner@wl.test'").get().id;
  const billerId = raw.prepare("SELECT id FROM users WHERE email = 'biller@wl.test'").get().id;
  raw.prepare("INSERT INTO payers (name, type) VALUES ('Aetna', 'commercial')").run();
  const payerId = raw.prepare("SELECT id FROM payers WHERE name = 'Aetna'").get().id;
  // Signup seeds default filing rules (Aetna = 120d); pin this org to 90d.
  raw.prepare('INSERT OR REPLACE INTO payer_filing_rules (org_id, payer_id, filing_days) VALUES (?, ?, 90)').run(orgId, payerId);

  const insClaim = raw.prepare(`INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date,
    billed_amount, paid_amount, status, denial_reason, created_at, last_touched_at)
    VALUES (?, ?, 'Pat', ?, ?, ?, 0, ?, ?, ?, ?)`);
  const insAppeal = raw.prepare(`INSERT INTO appeals (org_id, claim_id, assigned_to, status, priority, follow_up_date)
    VALUES (?, ?, ?, 'open', 'medium', ?)`);
  const mk = (num, serviceDays, status, createdDays, denial = null) => {
    const info = insClaim.run(orgId, num, payerId, dstr(serviceDays), status === 'denied' ? 900 : 500,
      status, denial, `${dstr(createdDays)} 00:00:00`, null);
    return Number(info.lastInsertRowid);
  };
  // C1: filing risk; open appeal assigned to BILLER (follow-up NOT overdue)
  const c1 = mk('C1', -80, 'in_ar', -80);
  insAppeal.run(orgId, c1, billerId, dstr(10));
  // C2: filing risk; no appeal at all
  const c2 = mk('C2', -80, 'in_ar', -80);
  // C3: denied, no appeal -> unworked denial (team only)
  const c3 = mk('C3', -10, 'denied', -10, 'CO-50 non-covered');
  // C4: stale A/R (untouched 60d, no filing risk); open appeal assigned to OWNER
  const c4 = mk('C4', -10, 'pending', -60);
  insAppeal.run(orgId, c4, ownerId, dstr(10));
  // C5: denied with appeal assigned to BILLER, follow-up overdue yesterday
  const c5 = mk('C5', -10, 'denied', -10, 'CO-97 bundled');
  insAppeal.run(orgId, c5, billerId, dstr(-1));
  raw.close();

  const keys = (d) => (d.items || []).map((i) => i.key);
  const has = (d, type, claimId) => (d.items || []).some((i) => i.type === type && i.claim_id === claimId);

  const all = await api('GET', '/api/worklist?scope=all', null, ownerToken);
  check('team queue lists every item', all.status === 200
    && has(all.data, 'filing', c1) && has(all.data, 'filing', c2)
    && has(all.data, 'denial', c3) && has(all.data, 'stale', c4) && has(all.data, 'followup', c5),
    JSON.stringify(keys(all.data)));
  const c1Item = (all.data.items || []).find((i) => i.claim_id === c1 && i.type === 'filing');
  check('team queue filing item names its assignee', !!c1Item && c1Item.assignee === 'Bee Biller', JSON.stringify(c1Item || {}).slice(0, 160));

  const mineOwner = await api('GET', '/api/worklist?scope=mine', null, ownerToken);
  check('owner "mine" = only the stale claim whose appeal is assigned to owner',
    mineOwner.status === 200 && mineOwner.data.items.length === 1 && has(mineOwner.data, 'stale', c4),
    JSON.stringify(keys(mineOwner.data)));
  check('owner "mine" excludes filing/denial/followup items owned by others or nobody',
    !has(mineOwner.data, 'filing', c1) && !has(mineOwner.data, 'filing', c2)
    && !has(mineOwner.data, 'denial', c3) && !has(mineOwner.data, 'followup', c5),
    JSON.stringify(keys(mineOwner.data)));
  check('owner "mine" summary matches its items',
    mineOwner.data.summary.total === mineOwner.data.items.length && mineOwner.data.summary.staleAR === 1,
    JSON.stringify(mineOwner.data.summary));

  const mineBiller = await api('GET', '/api/worklist?scope=mine', null, billerToken);
  check('biller "mine" = filing item + overdue follow-up on their appeals',
    mineBiller.status === 200 && mineBiller.data.items.length === 2
    && has(mineBiller.data, 'filing', c1) && has(mineBiller.data, 'followup', c5),
    JSON.stringify(keys(mineBiller.data)));
  check('biller "mine" excludes unassigned + owner-assigned work',
    !has(mineBiller.data, 'filing', c2) && !has(mineBiller.data, 'denial', c3) && !has(mineBiller.data, 'stale', c4),
    JSON.stringify(keys(mineBiller.data)));

  if (server) server.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); if (server) server.kill(); process.exit(1); });
