// demo-removal-test.cjs — deploy #52 verification (market-launch cleanup).
// Part A (fresh DB): no seeded orgs/users, demo login dead, demo EHR
// refused, eligibility has no demo vendor and refuses unconfigured checks.
// Part B (migration): a DB pre-filled with the production junk (demo org,
// abc, asd, AB Recoveries, demo EHR artifacts in a keeper org) boots and
// the junk is gone while real orgs + their data survive untouched.
// Part C (AskBase): the AI demo org is removed and the public handbook KB
// is MOVED (not deleted) to the founder's RCM-linked org.
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 4112;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = '/tmp/demo-removal-test';
const DB = path.join(TMP, 'test.db');
let server;

async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function boot() {
  server = spawn('node', ['src/index.js'], {
    cwd: path.join(__dirname, '..', 'server'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret', EHR_AUTOPULL: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch { /* wait */ }
    await sleep(500);
  }
  throw new Error('server did not start');
}
async function stop() { if (server) { server.kill(); await sleep(700); server = null; } }

async function partA() {
  console.log('Part A — fresh DB state');
  await boot();
  const raw = new DatabaseSync(DB);
  check('fresh DB has zero orgs and zero users (no seeding)',
    raw.prepare('SELECT COUNT(*) AS n FROM orgs').get().n === 0
    && raw.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0);
  const login = await api('POST', '/api/auth/login', { email: 'demo@pulsercm.com', password: 'demo1234' });
  check('demo login is dead (401)', login.status === 401, `got ${login.status}`);

  const s = await api('POST', '/api/auth/signup', { orgName: 'Fresh Org', name: 'Owner', email: 'fresh@test.co', password: 'Test1234!' });
  const t = s.data.token;
  check('signup still works', s.status === 201 && !!t, JSON.stringify(s.data).slice(0, 120));

  const conn = await api('POST', '/api/ehr/connect', { provider: 'demo' }, t);
  check('demo EHR connect refused (400)', conn.status === 400, `got ${conn.status}`);

  const cfg = await api('GET', '/api/eligibility/config', null, t);
  check('eligibility config has no vendor by default', cfg.status === 200 && !cfg.data.vendor, JSON.stringify(cfg.data).slice(0, 120));
  const put = await api('PUT', '/api/eligibility/config', { vendor: 'demo' }, t);
  check('saving vendor=demo rejected (400)', put.status === 400, `got ${put.status}`);
  const chk = await api('POST', '/api/eligibility/check', {
    patient_first: 'A', patient_last: 'B', dob: '1990-01-01', member_id: 'X1', payer: 'Aetna', date_of_service: '2026-10-01',
  }, t);
  check('unconfigured check -> 400 with configure guidance', chk.status === 400 && /No eligibility vendor configured/.test(chk.data.error || ''), JSON.stringify(chk.data).slice(0, 160));
  raw.close();
  await stop();
}

function seedJunk() {
  const raw = new DatabaseSync(DB);
  raw.exec('PRAGMA busy_timeout = 5000');
  raw.prepare("DELETE FROM data_migrations WHERE name = 'demo-junk-cleanup-52'").run();
  const insOrg = raw.prepare('INSERT INTO orgs (name, onboarding_completed_at) VALUES (?, datetime(\'now\'))');
  const insUser = raw.prepare('INSERT INTO users (org_id, email, password_hash, name) VALUES (?, ?, ?, ?)');
  const insUO = raw.prepare('INSERT INTO user_orgs (user_id, org_id, role) VALUES (?, ?, ?)');
  const payerId = Number(raw.prepare("INSERT INTO payers (org_id, name, type) VALUES (NULL, 'Aetna', 'Commercial')").run().lastInsertRowid);
  const insClaim = raw.prepare(`INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date, billed_amount, paid_amount, status, days_in_ar)
                                VALUES (?, ?, 'Pat', ${payerId}, '2026-10-01', 100, 0, 'pending', 1)`);
  const mkOrg = (name, email) => {
    const oid = Number(insOrg.run(name).lastInsertRowid);
    const uid = Number(insUser.run(oid, email, 'x', 'Owner').lastInsertRowid);
    insUO.run(uid, oid, 'owner');
    return { oid, uid };
  };
  // Production's ehr_connections table predates #52 and allows provider
  // 'demo' in its CHECK — fresh tables refuse it, so relax CHECK
  // enforcement on this connection just to stage the legacy demo rows
  // the migration must purge.
  raw.exec('PRAGMA ignore_check_constraints = ON');
  const demo = mkOrg('Demo Billing Co.', 'demo@pulsercm.com');
  insClaim.run(demo.oid, 'CLM-DEMO-1');
  mkOrg('abc', 'abc@test.co');
  mkOrg('asd', 'asd@test.co');
  mkOrg('AB Recoveries', 'ab@test.co');
  const keeper = mkOrg('Real Practice LLC', 'real@test.co');
  raw.prepare('UPDATE payers SET org_id = ? WHERE id = ?').run(keeper.oid, payerId);
  insClaim.run(keeper.oid, 'CLM-REAL-1');
  const hq = mkOrg('ClaimPaid HQ', 'shehreyarkhann@outlook.com');
  insClaim.run(hq.oid, 'CLM-HQ-1');
  // Demo artifacts inside the KEEPER org: demo EHR connection + encounter,
  // a demo-vendor eligibility lookup — alongside a real athena connection.
  const demoConnId = Number(raw.prepare(`INSERT INTO ehr_connections (org_id, provider, status, auth_mode, updated_at) VALUES (?, 'demo', 'connected', 'demo', datetime('now'))`).run(keeper.oid).lastInsertRowid);
  raw.prepare(`INSERT INTO ehr_connections (org_id, provider, status, auth_mode, updated_at) VALUES (?, 'athenahealth', 'connected', '2legged', datetime('now'))`).run(keeper.oid);
  raw.prepare(`INSERT INTO ehr_encounters (org_id, connection_id, ehr_encounter_id, patient_first, patient_last, payer_name, date_of_service, status)
               VALUES (?, ?, 'ENC-DEMO', 'Syn', 'Thetic', 'Aetna', '2026-10-01', 'new')`).run(keeper.oid, demoConnId);
  raw.prepare(`INSERT INTO eligibility_lookups (org_id, patient_first, patient_last, dob, member_id, payer, date_of_service, vendor)
               VALUES (?, 'Syn', 'Thetic', '1990-01-01', 'X1', 'Aetna', '2026-10-01', 'demo')`).run(keeper.oid);
  raw.prepare("UPDATE orgs SET eligibility_vendor = 'demo' WHERE id = ?").run(keeper.oid);
  raw.close();
  return { keeper, hq };
}

async function partB() {
  console.log('Part B — migration cleans production junk, keeps real orgs');
  const { keeper, hq } = seedJunk();
  await boot();
  const raw = new DatabaseSync(DB);
  const orgNames = raw.prepare('SELECT name FROM orgs ORDER BY name').all().map((r) => r.name);
  check('junk orgs deleted (Demo Billing Co., abc, asd, AB Recoveries)',
    !orgNames.some((n) => ['Demo Billing Co.', 'abc', 'asd', 'AB Recoveries'].includes(n)), JSON.stringify(orgNames));
  check('keeper + HQ + Part A org survive',
    orgNames.includes('Real Practice LLC') && orgNames.includes('ClaimPaid HQ') && orgNames.includes('Fresh Org'), JSON.stringify(orgNames));
  check('demo user deleted', !raw.prepare("SELECT id FROM users WHERE email = 'demo@pulsercm.com'").get());
  check('keeper claim intact', !!raw.prepare("SELECT id FROM claims WHERE claim_number = 'CLM-REAL-1'").get());
  check('HQ claim intact', !!raw.prepare("SELECT id FROM claims WHERE claim_number = 'CLM-HQ-1'").get());
  check('demo claim gone', !raw.prepare("SELECT id FROM claims WHERE claim_number = 'CLM-DEMO-1'").get());
  check('keeper demo EHR connection + encounter purged',
    raw.prepare("SELECT COUNT(*) AS n FROM ehr_connections WHERE provider = 'demo'").get().n === 0
    && raw.prepare("SELECT COUNT(*) AS n FROM ehr_encounters e JOIN ehr_connections c ON c.id = e.connection_id WHERE c.provider = 'demo'").get().n === 0
    && raw.prepare("SELECT COUNT(*) AS n FROM ehr_encounters WHERE ehr_encounter_id = 'ENC-DEMO'").get().n === 0);
  check('keeper athena connection survives',
    raw.prepare("SELECT COUNT(*) AS n FROM ehr_connections WHERE provider = 'athenahealth' AND org_id = ?").get(keeper.oid).n === 1);
  check('demo-vendor lookup history purged + vendor nulled',
    raw.prepare("SELECT COUNT(*) AS n FROM eligibility_lookups WHERE vendor = 'demo'").get().n === 0
    && !raw.prepare('SELECT eligibility_vendor FROM orgs WHERE id = ?').get(keeper.oid).eligibility_vendor);
  check('migration marker recorded', !!raw.prepare("SELECT name FROM data_migrations WHERE name = 'demo-junk-cleanup-52'").get());
  check('HQ org id untouched', raw.prepare('SELECT id FROM orgs WHERE name = ?').get('ClaimPaid HQ').id === hq.oid);
  raw.close();
  await stop();
}

function partC() {
  console.log('Part C — AskBase demo cleanup (prod shape) moves the public handbook');
  const ADB = path.join(TMP, 'askbase.db');
  const script = `
    process.env.ASKBASE_DB_PATH = ${JSON.stringify(ADB)};
    const { db, initSchema } = require(${JSON.stringify(path.join(__dirname, '..', '..', 'askbase', 'server', 'src', 'db.js'))});
    initSchema();
    const mode = process.argv[1];
    if (mode === 'seed') {
      const home = Number(db.prepare("INSERT INTO orgs (name, rcm_org_id) VALUES ('ClaimPaid HQ', 12)").run().lastInsertRowid);
      db.prepare("INSERT INTO users (org_id, name, email, password_hash, role) VALUES (?, 'Founder', 'shehreyarkhann@outlook.com', 'x', 'owner')").run(home);
      const demo = Number(db.prepare("INSERT INTO orgs (name) VALUES ('Demo Company')").run().lastInsertRowid);
      db.prepare("INSERT INTO users (org_id, name, email, password_hash, role) VALUES (?, 'Demo Owner', 'demo@askbase.com', 'x', 'owner')").run(demo);
      const nw = Number(db.prepare("INSERT INTO knowledge_bases (org_id, name, public_enabled, public_slug) VALUES (?, 'Northwind Support Handbook', 1, 'demo-northwind')").run(demo).lastInsertRowid);
      // The #52 killer: the demo KB has a conversation + message (convo_id).
      const convo = Number(db.prepare("INSERT INTO conversations (kb_id, org_id, title) VALUES (?, ?, 'chat')").run(nw, demo).lastInsertRowid);
      db.prepare("INSERT INTO messages (convo_id, role, content) VALUES (?, 'user', 'hello')").run(convo);
      // Prod shape: the handbook sits in the RCM-demo-linked AI org.
      const rcmDemo = Number(db.prepare("INSERT INTO orgs (name, rcm_org_id) VALUES ('Demo Billing Co.', 1)").run().lastInsertRowid);
      const hb = Number(db.prepare("INSERT INTO knowledge_bases (org_id, name, public_enabled, public_slug) VALUES (?, 'Payer Policy Handbook', 1, 'payer-policy-handbook')").run(rcmDemo).lastInsertRowid);
      const doc = Number(db.prepare("INSERT INTO documents (kb_id, org_id, filename, source_type, status) VALUES (?, ?, 'h.md', 'upload', 'ready')").run(hb, rcmDemo).lastInsertRowid);
      db.prepare("INSERT INTO chunks (doc_id, kb_id, org_id, chunk_index, text, embedding) VALUES (?, ?, ?, 0, 'Aetna 120 days', '[]')").run(doc, hb, rcmDemo);
      db.prepare("DELETE FROM data_migrations WHERE name IN ('demo-cleanup-52', 'demo-cleanup-53')").run();
      console.log(JSON.stringify({ home, demo, rcmDemo, hb }));
    } else {
      const out = {
        orgs: db.prepare('SELECT id, name FROM orgs ORDER BY id').all(),
        demoUser: !!db.prepare("SELECT id FROM users WHERE email = 'demo@askbase.com'").get(),
        northwind: !!db.prepare("SELECT id FROM knowledge_bases WHERE public_slug = 'demo-northwind'").get(),
        messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
        handbook: db.prepare("SELECT org_id FROM knowledge_bases WHERE public_slug = 'payer-policy-handbook'").get(),
        chunks: db.prepare('SELECT org_id FROM chunks').all(),
        marker: !!db.prepare("SELECT name FROM data_migrations WHERE name = 'demo-cleanup-53'").get(),
      };
      console.log(JSON.stringify(out));
    }
  `;
  const cwd = path.join(__dirname, '..', '..', 'askbase', 'server');
  const seeded = JSON.parse(execFileSync('node', ['-e', script, 'seed'], { cwd, encoding: 'utf8' }).trim().split('\n').pop());
  const after = JSON.parse(execFileSync('node', ['-e', script, 'check'], { cwd, encoding: 'utf8' }).trim().split('\n').pop());
  check('AI junk orgs removed (Demo Company + RCM-demo org)', after.orgs.length === 1 && after.orgs[0].id === seeded.home, JSON.stringify(after.orgs));
  check('AI demo user removed', after.demoUser === false);
  check('Northwind demo KB + its conversation/messages deleted', after.northwind === false && after.messages === 0, JSON.stringify(after));
  check('public handbook MOVED to the founder AI org (not deleted)',
    !!after.handbook && after.handbook.org_id === seeded.home, JSON.stringify(after));
  check('handbook chunks moved with it', after.chunks.length === 1 && after.chunks[0].org_id === seeded.home, JSON.stringify(after.chunks));
  check('cleanup marker recorded', after.marker === true);
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  try { await partA(); } catch (e) { failed++; console.log('  FAIL Part A threw:', e.message); await stop(); }
  try { await partB(); } catch (e) { failed++; console.log('  FAIL Part B threw:', e.message); await stop(); }
  try { partC(); } catch (e) { failed++; console.log('  FAIL Part C threw:', e.message); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
