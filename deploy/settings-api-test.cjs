#!/usr/bin/env node
// API tests for the Settings expansion — throwaway DB, real HTTP server.
// Usage: node settings-api-test.cjs
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = '/home/hatch/workspace/portfolio/rcm-dashboard';
const DB = '/tmp/settings-api-test.db';
const PORT = 4103;
const API = `http://127.0.0.1:${PORT}`;

try { fs.unlinkSync(DB); } catch {}

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name} ${extra}`); }
}

async function req(method, p, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) { payload = form; } // FormData sets its own content-type
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(API + p, { method, headers, body: payload });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

(async () => {
  const server = spawn('node', [path.join(REPO, 'server/src/index.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), EMAIL_PROVIDER: 'console', JWT_SECRET: 'test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  server.stdout.on('data', (d) => { stdout += d.toString(); });
  server.stderr.on('data', (d) => { stdout += d.toString(); });
  const emailCount = () => (stdout.match(/\[EMAIL:console\]/g) || []).length;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const kill = () => new Promise((res) => { server.on('exit', res); server.kill('SIGTERM'); setTimeout(res, 2000); });

  try {
    // wait for boot
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(API + '/api/health'); if (r.ok) break; } catch {}
      await sleep(250);
    }

    // --- owner signup ---
    let r = await req('POST', '/api/auth/signup', { body: { orgName: 'Test Org', name: 'Owner', email: 'owner@test.io', password: 'TestPass123!' } });
    ok('owner signup', [200,201].includes(r.status) && r.json.token, `status=${r.status}`);
    const ownerToken = r.json.token;
    const orgId = r.json.user.org_id;
    const biller = async (i) => (await req('POST', '/api/auth/signup', { body: { orgName: 'Other' + i, name: 'B' + i, email: `b${i}@test.io`, password: 'TestPass123!' } })).json;

    // --- settings defaults ---
    r = await req('GET', '/api/settings', { token: ownerToken });
    ok('GET /api/settings defaults', r.status === 200 && r.json.timezone === 'America/New_York'
      && r.json.rows_per_page === 25 && r.json.date_format === 'MM/DD/YYYY'
      && r.json.notifications.demo_requests === true && r.json.notifications.weekly_digest === true,
      JSON.stringify(r.json).slice(0, 200));

    // --- general update ---
    r = await req('PUT', '/api/settings/general', { token: ownerToken, body: { name: 'Renamed Org', timezone: 'America/Chicago', date_format: 'DD/MM/YYYY', rows_per_page: 50 } });
    ok('PUT /api/settings/general persists', r.status === 200 && r.json.name === 'Renamed Org'
      && r.json.timezone === 'America/Chicago' && r.json.date_format === 'DD/MM/YYYY' && r.json.rows_per_page === 50,
      `status=${r.status}`);
    r = await req('PUT', '/api/settings/general', { token: ownerToken, body: { timezone: 'Not/AZone' } });
    ok('invalid timezone rejected', r.status === 400, `status=${r.status}`);
    r = await req('PUT', '/api/settings/general', { token: ownerToken, body: { date_format: 'YY' } });
    ok('invalid date_format rejected', r.status === 400, `status=${r.status}`);
    r = await req('PUT', '/api/settings/general', { token: ownerToken, body: { rows_per_page: 33 } });
    ok('invalid rows_per_page rejected', r.status === 400, `status=${r.status}`);

    // --- seats ---
    r = await req('GET', '/api/settings/seats', { token: ownerToken });
    ok('seat usage math (1 of 5, trial)', r.status === 200 && r.json.used === 1 && r.json.limit === 5 && r.json.atCap === false,
      JSON.stringify(r.json));

    // --- API keys: generate ---
    r = await req('POST', '/api/settings/api-keys', { token: ownerToken, body: { name: 'Billing sync' } });
    const key = r.json && r.json.key;
    ok('key generated, shown once', r.status === 201 && /^cp_sk_live_[0-9a-f]{48}$/.test(key || ''), `status=${r.status}`);
    const keyId = r.json.id;
    ok('key prefix returned, hash not', !!r.json.key_prefix && !r.json.key_hash && !('key_hash' in r.json));

    // hash stored, not plaintext
    const { DatabaseSync } = require('node:sqlite');
    const tdb = new DatabaseSync(DB);
    const row = tdb.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId);
    const expectHash = crypto.createHash('sha256').update(key, 'utf8').digest('hex');
    ok('SHA-256 hash stored, plaintext never stored', row.key_hash === expectHash && !JSON.stringify(row).includes(key.slice(20)));
    tdb.close();

    // --- API keys: list hides hashes ---
    r = await req('GET', '/api/settings/api-keys', { token: ownerToken });
    ok('list shows prefix/by/at, hides hash+key', r.status === 200 && Array.isArray(r.json)
      && r.json[0].key_prefix && r.json[0].created_by === 'Owner'
      && !('key' in r.json[0]) && !('key_hash' in r.json[0]), JSON.stringify(r.json[0]).slice(0, 160));

    // --- API key auth: proof endpoint ---
    r = await req('GET', '/api/v1/org/summary', { token: key });
    ok('valid key → /api/v1/org/summary 200, org-scoped', r.status === 200 && r.json.id === orgId && r.json.name === 'Renamed Org',
      `status=${r.status}`);
    r = await req('GET', '/api/v1/org/summary', { token: ownerToken });
    ok('JWT Bearer rejected on key-only endpoint', r.status === 401, `status=${r.status}`);
    r = await req('GET', '/api/v1/org/summary', { token: 'cp_sk_live_' + '0'.repeat(48) });
    ok('bogus key rejected', r.status === 401, `status=${r.status}`);

    // --- revoke ---
    r = await req('DELETE', `/api/settings/api-keys/${keyId}`, { token: ownerToken });
    ok('revoke works', r.status === 200 && r.json.revoked === true, `status=${r.status}`);
    r = await req('GET', '/api/v1/org/summary', { token: key });
    ok('revoked key rejected', r.status === 401, `status=${r.status}`);
    r = await req('GET', '/api/settings/api-keys', { token: ownerToken });
    ok('list shows revoked state', r.json[0].revoked === true);

    // --- non-owner cannot manage keys ---
    const b0 = await biller(0);
    const billerToken = b0.token;
    // move biller into test org as biller
    r = await req('POST', '/api/auth/team', { token: ownerToken, body: { email: 'b0@test.io', role: 'biller' } });
    ok('biller added to org (2 of 5 seats)', r.status === 201, `status=${r.status}`);
    const billerSwitch = await req('POST', '/api/auth/switch', { token: billerToken, body: { org_id: orgId } });
    const billerOrgToken = billerSwitch.json.token;
    r = await req('POST', '/api/settings/api-keys', { token: billerOrgToken, body: { name: 'x' } });
    ok('non-owner cannot create key', r.status === 403, `status=${r.status}`);
    r = await req('GET', '/api/settings/api-keys', { token: billerOrgToken });
    ok('non-owner cannot list keys', r.status === 403, `status=${r.status}`);
    r = await req('DELETE', `/api/settings/api-keys/${keyId}`, { token: billerOrgToken });
    ok('non-owner cannot revoke key', r.status === 403, `status=${r.status}`);

    // --- seat cap on invite (deploy #100: Starter = 5 roster seats) ---
    r = await req('POST', '/api/auth/team', { token: ownerToken, body: { name: 'C', email: 'c@test.io', password: 'TestPass123!', role: 'viewer' } });
    ok('3rd member added (3 of 5)', r.status === 201, `status=${r.status}`);
    r = await req('POST', '/api/auth/team', { token: ownerToken, body: { name: 'D', email: 'd@test.io', password: 'TestPass123!', role: 'viewer' } });
    ok('4th member added (4 of 5)', r.status === 201, `status=${r.status}`);
    r = await req('POST', '/api/auth/team', { token: ownerToken, body: { name: 'E', email: 'e@test.io', password: 'TestPass123!', role: 'viewer' } });
    ok('5th member added (5 of 5)', r.status === 201, `status=${r.status}`);
    r = await req('GET', '/api/settings/seats', { token: ownerToken });
    ok('at cap', r.json.used === 5 && r.json.atCap === true, JSON.stringify(r.json));
    // A brand-new person at the roster cap is blocked. (This org never
    // picked a plan, so limitsForPlan is the grandfathered row and the
    // route-level seatUsage backstop fires the 403; plan-carrying orgs are
    // blocked earlier by the quota middleware's 402 — covered in the
    // account-model suite.)
    r = await req('POST', '/api/auth/team', { token: ownerToken, body: { name: 'F', email: 'f@test.io', password: 'TestPass123!', role: 'viewer' } });
    ok('invite at cap → 403 clear error', r.status === 403 && /Seat limit reached/.test(r.json.error || ''), `status=${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);

    // --- notifications persist + gate support send path ---
    r = await req('PUT', '/api/settings/notifications', { token: ownerToken, body: { support_replies: false, demo_requests: false } });
    ok('notification prefs persist', r.status === 200 && r.json.support_replies === false && r.json.demo_requests === false
      && r.json.trial_reminders === true, JSON.stringify(r.json));
    r = await req('PUT', '/api/settings/notifications', { token: billerOrgToken, body: { support_replies: true } });
    ok('non-owner cannot change prefs', r.status === 403, `status=${r.status}`);

    const before = emailCount();
    r = await req('POST', '/api/support', { body: { name: 'Cust', email: 'cust@x.io', subject: 'Help', message: 'broken', org_id: orgId } });
    await sleep(400);
    ok('support ticket with org_id + toggle OFF → no staff email', r.status === 201 && emailCount() === before,
      `status=${r.status} emails=${emailCount() - before}`);

    await req('PUT', '/api/settings/notifications', { token: ownerToken, body: { support_replies: true } });
    r = await req('POST', '/api/support', { body: { name: 'Cust', email: 'cust2@x.io', subject: 'Help2', message: 'broken', org_id: orgId } });
    await sleep(400);
    ok('toggle ON → staff email queued', emailCount() === before + 1, `emails=${emailCount() - before}`);

    // --- demo request gating ---
    const d0 = emailCount();
    r = await req('POST', '/api/demo/requests', { body: { name: 'Lead', email: 'lead@x.io', company: 'Acme', org_id: orgId } });
    await sleep(400);
    ok('demo request with org_id + toggle OFF → no notify email', r.status === 201 && emailCount() === d0,
      `status=${r.status} emails=${emailCount() - d0}`);
    await req('PUT', '/api/settings/notifications', { token: ownerToken, body: { demo_requests: true } });
    r = await req('POST', '/api/demo/requests', { body: { name: 'Lead', email: 'lead2@x.io', company: 'Acme', org_id: orgId } });
    await sleep(400);
    ok('demo request toggle ON → notify email queued', emailCount() === d0 + 1, `emails=${emailCount() - d0}`);
    // no org_id → default send (unchanged legacy behavior)
    const d1 = emailCount();
    r = await req('POST', '/api/demo/requests', { body: { name: 'Lead', email: 'lead3@x.io', company: 'Acme' } });
    await sleep(400);
    ok('demo request without org → default send', emailCount() === d1 + 1);

    // --- logo upload ---
    const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const fd = new FormData();
    fd.append('logo', new Blob([png1x1], { type: 'image/png' }), 'logo.png');
    r = await req('POST', '/api/settings/logo', { token: ownerToken, form: fd });
    ok('logo upload accepts PNG', r.status === 200 && /\/uploads\/org-logos\//.test(r.json.logo_url || ''), `status=${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
    r = await req('GET', `/uploads/org-logos/${orgId}.png`);
    ok('logo served statically', r.status === 200, `status=${r.status}`);

    const bad = new FormData();
    bad.append('logo', new Blob(['not an image'], { type: 'text/plain' }), 'x.txt');
    r = await req('POST', '/api/settings/logo', { token: ownerToken, form: bad });
    ok('non-image rejected', r.status === 400, `status=${r.status}`);

    const big = new FormData();
    big.append('logo', new Blob([Buffer.alloc(3 * 1024 * 1024, 1)], { type: 'image/png' }), 'big.png');
    r = await req('POST', '/api/settings/logo', { token: ownerToken, form: big });
    ok('oversize rejected with 400', r.status === 400 && /2 MB/.test(r.json.error || ''), `status=${r.status}`);

    r = await req('DELETE', '/api/settings/logo', { token: ownerToken });
    ok('logo delete', r.status === 200 && r.json.logo_url === null, `status=${r.status}`);

    // --- brand color ---
    r = await req('PUT', '/api/settings/brand', { token: ownerToken, body: { brand_color: '#7c3aed' } });
    ok('brand color saved', r.status === 200 && r.json.brand_color === '#7c3aed', `status=${r.status}`);
    r = await req('PUT', '/api/settings/brand', { token: ownerToken, body: { brand_color: 'red' } });
    ok('invalid brand color rejected', r.status === 400, `status=${r.status}`);
    r = await req('PUT', '/api/settings/brand', { token: billerOrgToken, body: { brand_color: '#000000' } });
    ok('non-owner cannot set brand', r.status === 403, `status=${r.status}`);
    r = await req('GET', '/api/org', { token: ownerToken });
    ok('org profile exposes brand prefs', r.status === 200 && r.json.date_format === 'DD/MM/YYYY' && r.json.rows_per_page === 50,
      JSON.stringify({ df: r.json.date_format, rpp: r.json.rows_per_page }));

    // --- MFA enforcement contract: PUT /api/settings/security { mfa_required } ---
    // (endpoint owned by workstream C; this tab calls it exactly)
    r = await req('POST', '/api/settings/api-keys', { token: ownerToken, body: { name: 'MFA-proof key' } });
    const mfaProofKey = r.json.key;
    ok('second key for MFA-proof test', r.status === 201 && !!mfaProofKey, `status=${r.status}`);
    r = await req('PUT', '/api/settings/security', { token: ownerToken, body: { mfa_required: true } });
    ok('PUT /api/settings/security {mfa_required:true}', r.status === 200 && r.json.mfa_required === true, `status=${r.status}`);
    r = await req('GET', '/api/settings/security', { token: ownerToken });
    ok('owner blocked on next request after enabling (lockout-by-design)', r.status === 403 && r.json.mfaRequired === true, `status=${r.status}`);
    r = await req('GET', '/api/settings', { token: billerOrgToken });
    ok('unenrolled member blocked while enforced', r.status === 403 && r.json.mfaRequired === true, `status=${r.status}`);
    r = await req('GET', '/api/v1/org/summary', { token: mfaProofKey });
    ok('API key unaffected by MFA enforcement', r.status === 200 && r.json.id === orgId, `status=${r.status}`);
    // reset directly in DB (owner is locked out until the flag clears)
    const rdb = new (require('node:sqlite').DatabaseSync)(DB);
    rdb.exec('UPDATE orgs SET mfa_required = 0');
    rdb.close();
    r = await req('GET', '/api/settings', { token: ownerToken });
    ok('flag cleared → owner unblocked', r.status === 200, `status=${r.status}`);

    // --- MFA toggle read-back round-trip (Settings → Security switch) ---
    // The switch reads GET /api/settings/security; assert that endpoint (and
    // GET /api/settings) mirror exactly what PUT wrote, on AND off. While
    // enforcement is ON the owner is API-blocked until enrolled (by design),
    // so simulate the completed email-code enrollment (users.mfa_enabled = 1)
    // to perform the read-back the UI does after the owner signs in.
    r = await req('PUT', '/api/settings/security', { token: ownerToken, body: { mfa_required: true } });
    ok('round-trip: PUT on → 200 {mfa_required:true}', r.status === 200 && r.json.mfa_required === true, `status=${r.status}`);
    const edb = new (require('node:sqlite').DatabaseSync)(DB);
    const stored = edb.prepare('SELECT mfa_required FROM orgs WHERE id = ?').get(orgId);
    ok('round-trip: orgs.mfa_required stored as 1', !!stored && stored.mfa_required === 1, JSON.stringify(stored));
    edb.prepare('UPDATE users SET mfa_enabled = 1 WHERE email = ?').run('owner@test.io');
    edb.close();
    r = await req('GET', '/api/settings/security', { token: ownerToken });
    ok('round-trip: GET /api/settings/security returns ON after save', r.status === 200 && r.json.mfa_required === true,
      `status=${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
    r = await req('GET', '/api/settings', { token: ownerToken });
    ok('round-trip: GET /api/settings embeds mfa_required=true', r.status === 200 && r.json.mfa_required === true, `status=${r.status}`);
    r = await req('PUT', '/api/settings/security', { token: ownerToken, body: { mfa_required: false } });
    ok('round-trip: PUT off → 200 {mfa_required:false}', r.status === 200 && r.json.mfa_required === false, `status=${r.status}`);
    r = await req('GET', '/api/settings/security', { token: ownerToken });
    ok('round-trip: GET /api/settings/security returns OFF after save', r.status === 200 && r.json.mfa_required === false, `status=${r.status}`);
    r = await req('PUT', '/api/settings/security', { token: ownerToken, body: { mfa_required: 'yes' } });
    ok('round-trip: non-boolean mfa_required rejected', r.status === 400, `status=${r.status}`);
  } finally {
    await kill();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
