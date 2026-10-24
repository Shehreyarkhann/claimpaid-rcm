// athena-service-test.cjs — deploy #43 verification: 2-legged service connect.
// Deterministic checks (no real athena credentials):
//  1. no app config -> 400 "not configured", no connection created as connected
//  2. fake credentials -> athena rejects (or is unreachable): endpoint returns
//     a clean error (400/502), connection recorded as 'error' with last_error,
//     never 'connected'
//  3. unauthenticated -> 401
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 4107;
const BASE = `http://localhost:${PORT}`;
const TMP = '/tmp/athena-service-test';
const DB = path.join(TMP, 'test.db');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  server = spawn('node', ['src/index.js'], {
    cwd: path.join(__dirname, '..', 'server'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret', EHR_AUTOPULL: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch { /* wait */ }
    await sleep(500);
  }

  const unauth = await api('POST', '/api/ehr/athena/connect-service', null, null);
  check('unauthenticated -> 401', unauth.status === 401, `got ${unauth.status}`);

  const s = await api('POST', '/api/auth/signup', { orgName: 'Athena Svc Org', name: 'Owner', email: 'svc@test.co', password: 'Test1234!' });
  check('signup', s.status === 201, JSON.stringify(s.data));
  const t = s.data.token;

  const noCfg = await api('POST', '/api/ehr/athena/connect-service', null, t);
  check('no config -> 400 not configured', noCfg.status === 400 && /not configured/i.test(noCfg.data.error || ''), JSON.stringify(noCfg.data));

  const put = await api('PUT', '/api/ehr/athena/config', { env: 'preview', practice_id: '195900', client_id: 'fake-client-id', client_secret: 'fake-client-secret' }, t);
  check('config saved', put.status === 200, JSON.stringify(put.data));

  const fake = await api('POST', '/api/ehr/athena/connect-service', null, t);
  check('fake creds -> clean error, not connected', [400, 502].includes(fake.status) && !!fake.data.error, `status=${fake.status} ${JSON.stringify(fake.data).slice(0, 200)}`);
  const conns = await api('GET', '/api/ehr/connections', null, t);
  const ath = (conns.data.connections || []).find((c) => c.provider === 'athenahealth');
  check('connection recorded as error with reason', !!ath && ath.status === 'error' && !!ath.last_error, JSON.stringify(ath));

  console.log(`\n${passed} passed, ${failed} failed`);
  server.kill();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); if (server) server.kill(); process.exit(1); });
