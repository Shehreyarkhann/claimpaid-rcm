// Deploy #57 test: account menu backend — profile fields, avatar
// upload/serve with org scoping, change password, log-out-everywhere
// (token_version). Run: node deploy/account-menu-test.cjs
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'acct57-'));
const DB = path.join(TMP, 't.db'); const PORT = 4115;
let passed = 0, failed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log('  ok -', n); } else { failed++; console.log('  FAIL -', n, x !== undefined ? JSON.stringify(x) : ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp(tries = 60) { for (let i = 0; i < tries; i++) { try { const r = await fetch(`http://localhost:${PORT}/api/health`); if (r.ok) return true; } catch {} await sleep(500); } return false; }
async function call(method, p, body, token, raw) {
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (raw) return { status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) };
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, body: j };
}
const PNG = 'data:image/png;base64,' + Buffer.alloc(500, 7).toString('base64');

(async () => {
  const env = { ...process.env, PORT: String(PORT), DB_PATH: DB, NODE_ENV: 'test' };
  const srv = spawn('node', ['src/index.js'], { cwd: path.join(__dirname, '..', 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; srv.stderr.on('data', (d) => { err += d; });
  try {
    check('server up', await waitUp(), err.slice(-300));
    const su = await call('POST', '/api/auth/signup', { name: 'Amy Account', email: 'amy57@test.co', password: 'Test1234!', orgName: 'Amy Co' });
    const tok = su.body?.token; const uid = su.body?.user?.id;
    check('signup ok', !!tok, su);

    const me = await call('GET', '/api/auth/me', null, tok);
    check('/me carries profile fields', me.body?.has_avatar === false && me.body?.auth_provider === 'password' && 'phone' in me.body && 'title' in me.body, me.body);

    const patch = await call('PATCH', '/api/auth/me', { name: 'Amy A.', title: 'Billing Manager', phone: '(555) 010-2233' }, tok);
    check('profile update sticks', patch.body?.name === 'Amy A.' && patch.body?.title === 'Billing Manager' && patch.body?.phone === '(555) 010-2233', patch.body);
    check('empty name rejected', (await call('PATCH', '/api/auth/me', { name: '  ' }, tok)).status === 400);

    const up = await call('POST', '/api/auth/me/avatar', { dataUrl: PNG }, tok);
    check('avatar upload ok', up.status === 200 && up.body?.has_avatar === true, up);
    check('bad avatar rejected', (await call('POST', '/api/auth/me/avatar', { dataUrl: 'data:text/html;base64,AAAA' }, tok)).status === 400);
    const av = await call('GET', `/api/auth/avatar/${uid}`, null, tok, true);
    check('avatar serves with image type', av.status === 200 && (av.headers.get('content-type') || '').includes('image/') && av.buf.length === 500, av.status);

    // Org scoping: stranger org cannot fetch it; a teammate can.
    const stranger = await call('POST', '/api/auth/signup', { name: 'Eve', email: 'eve57@test.co', password: 'Test1234!', orgName: 'Eve Co' });
    check('stranger org gets 404 for avatar', (await call('GET', `/api/auth/avatar/${uid}`, null, stranger.body.token, true)).status === 404);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB);
    const mate = await call('POST', '/api/auth/signup', { name: 'Tim Team', email: 'tim57@test.co', password: 'Test1234!', orgName: 'Tim Co' });
    db.prepare('INSERT OR IGNORE INTO user_orgs (user_id, org_id, role) VALUES (?, ?, ?)').run(mate.body.user.id, su.body.user.org_id, 'biller');
    db.close();
    // Teammate's token is scoped to their own org; avatar route keys off shared membership rows.
    check('teammate can fetch avatar', (await call('GET', `/api/auth/avatar/${uid}`, null, mate.body.token, true)).status === 200);

    // Change password: guards + session kill.
    check('wrong current password -> 400', (await call('POST', '/api/auth/change-password', { currentPassword: 'Nope1234!', newPassword: 'NewPass123!' }, tok)).status === 400);
    check('weak new password -> 400', (await call('POST', '/api/auth/change-password', { currentPassword: 'Test1234!', newPassword: 'weak' }, tok)).status === 400);
    const cp = await call('POST', '/api/auth/change-password', { currentPassword: 'Test1234!', newPassword: 'NewPass123!' }, tok);
    check('change password ok + fresh token', cp.status === 200 && !!cp.body?.token, cp);
    check('old token dead after password change', (await call('GET', '/api/auth/me', null, tok)).status === 401);
    check('old password no longer logs in', (await call('POST', '/api/auth/login', { email: 'amy57@test.co', password: 'Test1234!' })).status === 401);
    const relogin = await call('POST', '/api/auth/login', { email: 'amy57@test.co', password: 'NewPass123!' });
    check('new password logs in', relogin.status === 200 && !!relogin.body?.token, relogin.status);

    // Log out everywhere: two live sessions, one kills the other.
    const s1 = (await call('POST', '/api/auth/login', { email: 'amy57@test.co', password: 'NewPass123!' })).body.token;
    const s2 = (await call('POST', '/api/auth/login', { email: 'amy57@test.co', password: 'NewPass123!' })).body.token;
    const la = await call('POST', '/api/auth/logout-all', {}, s2);
    check('logout-all ok + fresh token for caller', la.status === 200 && !!la.body?.token, la);
    check('other session killed', (await call('GET', '/api/auth/me', null, s1)).status === 401);
    check("caller's old token also rotated", (await call('GET', '/api/auth/me', null, s2)).status === 401);
    check("caller's fresh token works", (await call('GET', '/api/auth/me', null, la.body.token)).status === 200);

    // Google-SSO accounts cannot change a password they don't have.
    const db2 = new DatabaseSync(DB);
    db2.prepare("UPDATE users SET password_hash = 'google-sso' WHERE email = 'eve57@test.co'").run();
    db2.close();
    const g = await call('POST', '/api/auth/change-password', { currentPassword: 'Test1234!', newPassword: 'NewPass123!' }, stranger.body.token);
    check('google account change-password blocked with guidance', g.status === 400 && /Google/.test(g.body?.error || ''), g);
  } catch (e) {
    console.error('ERROR', e); failed++;
  } finally {
    try { srv.kill(); } catch {}
    await sleep(300);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
