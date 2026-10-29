// deploy101-health-test.cjs — Deploy #101 WS-C: /super system health.
//   (C9) metrics middleware: counts by route group + status class,
//        errors = 5xx only, hourly rollup rows land in metrics_hourly,
//        totals merge rollup + live bucket (child-process unit run).
//   (C10) GET /api/super/health: super-locked (403 for a normal user,
//        401 anonymous), response shape complete, agent cost math from
//        seeded agent_usage (Haiku pricing: $1/MTok in, $5/MTok out),
//        config presence booleans ONLY (no secret value anywhere in
//        the payload), service probes degrade to 'down' without
//        throwing, bundle hash read from the served dist.
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = '/tmp/deploy101-health';
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const FAKE = path.join(TMP, 'fake-transport.cjs');
fs.writeFileSync(FAKE, `'use strict';
async function transport() { return { text: 'OK.', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } }; }
module.exports = transport; module.exports.transport = transport; module.exports.default = transport;
`);

// ---- metrics unit runner (child) ----
const UNIT = path.join(TMP, 'metrics-unit.cjs');
fs.writeFileSync(UNIT, `'use strict';
const path = require('path');
const REPO = process.env.REPO_DIR;
let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log('  PASS [metrics] ' + name); }
  else { failed++; console.log('  FAIL [metrics] ' + name + ' ' + extra); }
}
const { db, initSchema } = require(path.join(REPO, 'server/src/db.js'));
initSchema();
const metrics = require(path.join(REPO, 'server/src/metrics.js'));

function drive(url, method, status) {
  return new Promise((resolve) => {
    const req = { url, method, headers: {}, ip: '127.0.0.1' };
    let finishFn = null;
    const res = {
      statusCode: status, headers: {},
      setHeader() {}, getHeader() { return undefined; },
      write() {},
      end() { if (finishFn) finishFn(); resolve(); },
      on(ev, fn) { if (ev === 'finish') finishFn = fn; },
    };
    // The middleware records on the response 'finish' event.
    metrics.metricsMiddleware(req, res, () => { res.end(); });
  });
}
(async () => {
  await drive('/api/claims', 'GET', 200);
  await drive('/api/claims/5', 'GET', 200);
  await drive('/api/agent/actions', 'POST', 201);
  await drive('/api/claims', 'GET', 404);
  await drive('/api/billing/checkout', 'POST', 500);
  await drive('/app/', 'GET', 200);
  await drive('/some-landing-page', 'GET', 200);
  const t = metrics.totals(24);
  check('totals: 7 requests counted', t.requests === 7, JSON.stringify(t));
  check('totals: only the 5xx counts as an error', t.errors === 1, JSON.stringify(t));
  metrics._flushNow();
  const rows = db.prepare('SELECT * FROM metrics_hourly').all();
  const sum = rows.reduce((a, r) => a + r.count, 0);
  check('rollup: metrics_hourly rows written for the current hour', rows.length >= 3 && sum === 7, JSON.stringify(rows));
  const errRows = rows.filter((r) => r.errors > 0);
  check('rollup: error row is the api/billing 5xx bucket', errRows.length === 1 && errRows[0].route_group === 'api/billing', JSON.stringify(errRows));
  const lat = metrics.latencyByGroup();
  check('latency: p95 present for api groups', Array.isArray(lat)
    && lat.some((r) => r.group === 'api/claims' && typeof r.p95_ms === 'number')
    && lat.some((r) => r.group === 'api/billing'), JSON.stringify(lat));
  console.log('[metrics] ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('  FAIL [metrics] runner error: ' + (e.stack || e.message)); process.exit(1); });
`);

const servers = [];
async function boot(port, env) {
  const dbPath = path.join(TMP, `test-${port}.db`);
  const server = spawn('node', ['src/index.js'], {
    cwd: path.join(REPO, 'server'),
    env: {
      ...process.env, PORT: String(port), DB_PATH: dbPath, JWT_SECRET: 'test-secret',
      EHR_AUTOPULL: 'off', AGENT_WATCHDOG: 'off', STRIPE_SECRET_KEY: '',
      AGENT_ENABLED: '', ANTHROPIC_API_KEY: '', AGENT_TRANSPORT_MODULE: '',
      SUPERADMIN_EMAIL: '', STEDI_API_KEY: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server:${port}] ${d}`));
  servers.push(server);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) return { server, base, dbPath }; } catch { /* wait */ }
    await sleep(400);
  }
  throw new Error(`server on ${port} never became healthy`);
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

async function main() {
  console.log('— deploy 101 WS-C: system health —');
  console.log('— C9: metrics unit (child) —');
  const unit = spawnSync('node', [UNIT], {
    env: { ...process.env, REPO_DIR: REPO, DB_PATH: path.join(TMP, 'unit.db'), JWT_SECRET: 'test-secret' },
    encoding: 'utf8', timeout: 120000,
  });
  process.stdout.write(unit.stdout || '');
  if (unit.stderr) process.stderr.write(unit.stderr);
  check('C9: metrics unit suite passes', unit.status === 0, `exit=${unit.status}`);

  const { base, dbPath } = await boot(4263, {
    AGENT_ENABLED: '1', ANTHROPIC_API_KEY: 'test-key-not-real', AGENT_TRANSPORT_MODULE: FAKE,
    SUPERADMIN_EMAIL: 'root101@test.co',
  });
  const root = await api(base, 'POST', '/api/auth/signup', { orgName: 'HQ', name: 'Root', email: 'root101@test.co', password: 'Test1234!' });
  const rootTok = root.data.token;
  const plain = await api(base, 'POST', '/api/auth/signup', { orgName: 'Plain Org', name: 'Pam Plain', email: 'pam@plain.test', password: 'Test1234!' });
  const plainTok = plain.data.token;
  const plainOrg = plain.data.user.org_id;
  check('signups', !!rootTok && !!plainTok, '');

  const denied = await api(base, 'GET', '/api/super/health', null, plainTok);
  check('C10: health is 403 for a non-super user', denied.status === 403, String(denied.status));
  const anon = await api(base, 'GET', '/api/super/health', null, null);
  check('C10: health is 401 anonymous', anon.status === 401, String(anon.status));

  // Seed agent usage for the CURRENT month: 100 turns, 1.0M input
  // tokens, 0.2M output tokens -> $1.00 + $1.00 = $2.00 estimate.
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(dbPath);
  const month = new Date().toISOString().slice(0, 7);
  raw.prepare(`INSERT INTO agent_usage (org_id, month, turns, input_tokens, output_tokens)
    VALUES (?, ?, 100, 1000000, 200000)`).run(plainOrg, month);
  raw.close();

  // A little real traffic for the counters.
  await api(base, 'GET', '/api/auth/me', null, plainTok);
  await api(base, 'GET', '/api/agent/notifications', null, plainTok);

  const h = await api(base, 'GET', '/api/super/health', null, rootTok);
  check('C10: health 200 for the super admin', h.status === 200, `status=${h.status} ${JSON.stringify(h.data).slice(0, 200)}`);
  const d = h.data;
  check('C10: server block (uptime, start, bundle hash from dist)', d.server && d.server.uptime_seconds >= 0
    && !!d.server.started_at && typeof d.server.bundle_hash === 'string' && d.server.bundle_hash.length >= 6,
    JSON.stringify(d.server || {}));
  check('C10: traffic counted the requests made', d.traffic && d.traffic.last_24h.requests >= 5 && d.traffic.last_7d.requests >= d.traffic.last_24h.requests,
    JSON.stringify(d.traffic || {}).slice(0, 200));
  check('C10: latency block present', d.traffic && typeof d.traffic.latency_p95_by_group === 'object', '');
  check('C10: cost math — 100 turns, 1M in / 0.2M out = $2.00',
    d.agent && d.agent.turns === 100 && d.agent.input_tokens === 1000000 && d.agent.output_tokens === 200000
    && Math.abs(d.agent.est_cost_usd - 2.0) < 0.001,
    JSON.stringify(d.agent || {}).slice(0, 300));
  check('C10: top orgs by AI use names the seeded org', Array.isArray(d.agent.top_orgs) && d.agent.top_orgs.length === 1
    && d.agent.top_orgs[0].org_name === 'Plain Org', JSON.stringify(d.agent.top_orgs || []));
  check('C10: pricing constants ride along (estimate labeling)', d.agent.pricing && d.agent.pricing.input_per_mtok_usd === 1 && d.agent.pricing.output_per_mtok_usd === 5,
    JSON.stringify(d.agent.pricing || {}));
  check('C10: config presence booleans only', d.config && d.config.anthropic_api_key === true && d.config.stedi_api_key === false
    && d.config.stripe === false && d.config.agent_enabled === true, JSON.stringify(d.config || {}));
  check('C10: NO secret value anywhere in the payload', !JSON.stringify(d).includes('test-key-not-real'), '');
  check('C10: services probed without throwing (AI down with no URL configured)', d.services && (d.services.ai === 'down' || d.services.ai === 'up')
    && (d.services.ollama === 'down' || d.services.ollama === 'up'), JSON.stringify(d.services || {}));
  check('C10: storage + totals present', d.storage && d.storage.db_bytes > 0 && d.storage.disk && d.storage.disk.free_bytes > 0
    && d.totals && d.totals.orgs >= 2 && d.totals.users >= 2, JSON.stringify({ s: d.storage, t: d.totals }).slice(0, 250));
  check('C10: scheduler block present', d.scheduler && 'watchdog_last_run' in d.scheduler && 'brief_precompute_last_run' in d.scheduler,
    JSON.stringify(d.scheduler || {}));

  console.log(`deploy101-health: ${passed} passed, ${failed} failed`);
  for (const srv of servers) srv.kill('SIGTERM');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); for (const srv of servers) srv.kill('SIGTERM'); process.exit(1); });
