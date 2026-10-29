// deploy101-scale-test.cjs — Deploy #101 WS-B: scale machinery.
//   (B5) approval policy: OFF by default (nothing auto-approves);
//        owner-only read/write; ON + qualifying draft (amount <= max,
//        win-history sample >= min, win rate >= min) executes through
//        the normal executor, marked auto_approved with a snapshot,
//        listed in the auto-approved stream, and VOIDABLE (the draft
//        appeal is removed, audit-logged); ON + non-qualifying (amount
//        over max / no history) stays human-queued.
//   (B6) batch decide: mixed id set (pending + already-decided +
//        missing) — per-item outcomes + summary; double-decide safe.
//   (B7) ERA pattern resolution: exceptions group by payer x CARC x
//        recommended action with counts + dollars; apply-to-all runs
//        the per-line path and reports per-line results.
//   (B8) saved import mappings round-trip (save/list/apply/delete).
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = '/tmp/deploy101-scale';
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const FAKE = path.join(TMP, 'fake-transport.cjs');
fs.writeFileSync(FAKE, `'use strict';
async function transport() { return { text: 'OK.', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } }; }
module.exports = transport; module.exports.transport = transport; module.exports.default = transport;
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
async function upload(base, p, fileName, text, token) {
  const fd = new FormData();
  fd.append('file', new Blob([text], { type: 'text/plain' }), fileName);
  const res = await fetch(base + p, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const REASON = 'CO-50 - Non-covered service';
const ERA_835 = [
  'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *261020*0800*^*00501*000000905*0*T*:~',
  'GS*HP*AETNA*RECEIVER*20261020*0800*905*X*005010X221A1~',
  'ST*835*0001~',
  'BPR*I*150*C*ACH*CCP*01*021000022*DA*123456789*1234567890*SUPP*01*021000022*DA*987654321*20261020~',
  'TRN*1*EFT-SCALE1*1234567890~',
  'DTM*405*20261020~',
  'N1*PR*AETNA~',
  'N1*PE*SCALE CLINIC*XX*1234567893~',
  'CLP*GRP-1*1*100*50*0**ICNG001~',
  'NM1*QC*1*GROUP*ONE****MI*MBR-1~',
  'CAS*CO*45*30~',
  'CLP*GRP-2*1*200*50*0**ICNG002~',
  'NM1*QC*1*GROUP*TWO****MI*MBR-2~',
  'CAS*CO*45*120~',
  'CLP*GRP-3*1*300*50*0**ICNG003~',
  'NM1*QC*1*GROUP*THREE****MI*MBR-3~',
  'CAS*CO*45*200~',
  'SE*16*0001~',
  'GE*1*905~',
  'IEA*1*000000905~',
].join('\n');

async function main() {
  console.log('— deploy 101 WS-B: scale —');
  const { base, dbPath } = await boot(4262, {
    AGENT_ENABLED: '1', ANTHROPIC_API_KEY: 'test-key-not-real', AGENT_TRANSPORT_MODULE: FAKE,
  });
  const s = await api(base, 'POST', '/api/auth/signup', { orgName: 'Scale Org', name: 'Sara Owner', email: 'sara@scale.test', password: 'Test1234!' });
  const tok = s.data.token;
  const orgId = s.data.user.org_id;
  const ownerId = s.data.user.id;
  check('signup', s.status === 201 && !!tok, JSON.stringify(s.data).slice(0, 150));

  const { DatabaseSync } = require('node:sqlite');
  const jwt = require(path.join(REPO, 'server/node_modules/jsonwebtoken'));
  const raw = new DatabaseSync(dbPath);
  const billerId = Number(raw.prepare(`INSERT INTO users (org_id, email, password_hash, name, role)
    VALUES (?, 'bea@scale.test', 'x', 'Bea Biller', 'biller')`).run(orgId).lastInsertRowid);
  raw.prepare('INSERT INTO user_orgs (user_id, org_id, role) VALUES (?, ?, ?)').run(billerId, orgId, 'biller');
  const tokBiller = jwt.sign({ sub: billerId, org: orgId, role: 'biller', email: 'bea@scale.test', name: 'Bea Biller', tv: 0 }, 'test-secret');

  const payer = Number(raw.prepare("INSERT INTO payers (name, type, org_id) VALUES ('Aetna', 'commercial', ?)").run(orgId).lastInsertRowid);
  raw.prepare('INSERT INTO payer_filing_rules (org_id, payer_id, filing_days) VALUES (?, ?, 90)').run(orgId, payer);
  const insClaim = raw.prepare(`INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date, billed_amount, paid_amount, status, denial_reason)
    VALUES (?, ?, ?, ?, '2026-09-01', ?, 0, 'denied', ?)`);
  const mkClaim = (cn, billed, reason = REASON) =>
    Number(insClaim.run(orgId, cn, `Patient ${cn}`, payer, billed, reason).lastInsertRowid);

  // Win history for (Aetna, REASON): 6 decided, 5 overturned (83%).
  const { categorizeReason } = require(path.join(REPO, 'server/src/appealLetters.js'));
  raw.prepare(`INSERT INTO agent_outcome_stats (org_id, payer_id, denial_reason, angle, appeals, overturned, updated_at)
    VALUES (?, ?, ?, ?, 6, 5, datetime('now'))`).run(orgId, payer, REASON, categorizeReason(REASON));

  const cQual = mkClaim('Q-1', 500);       // qualifies once policy is on
  const cBig = mkClaim('Q-2', 5000);       // over the amount cap
  const cNoHist = mkClaim('Q-3', 400, 'CO-197 - Prior authorization was not obtained'); // no history

  // ---------- B5: policy OFF (default) ----------
  let pol = await api(base, 'GET', '/api/agent/policy', null, tok);
  check('B5: policy defaults OFF', pol.status === 200 && pol.data.policy && pol.data.policy.enabled === false,
    JSON.stringify(pol.data).slice(0, 200));
  const propOff = await api(base, 'POST', '/api/agent/actions/propose', { kind: 'draft_appeal', claim_id: cQual }, tok);
  check('B5: propose with policy OFF stays pending', propOff.status === 201 && propOff.data.action.status === 'pending' && !propOff.data.action.auto_approved,
    JSON.stringify(propOff.data).slice(0, 250));
  const offActionId = propOff.data.action.id;
  // Clean the slate for the ON tests (reject it through the normal path).
  const rejOff = await api(base, 'POST', `/api/agent/actions/${offActionId}/reject`, {}, tok);
  check('B5: cleanup reject works', rejOff.status === 200, `status=${rejOff.status}`);

  const polBiller = await api(base, 'GET', '/api/agent/policy', null, tokBiller);
  check('B5: policy read is owner-only (biller 403)', polBiller.status === 403, String(polBiller.status));
  const polPutBiller = await api(base, 'PUT', '/api/agent/policy', { enabled: true, max_amount: 1000 }, tokBiller);
  check('B5: policy write is owner-only (biller 403)', polPutBiller.status === 403, String(polPutBiller.status));
  const polNoMax = await api(base, 'PUT', '/api/agent/policy', { enabled: true }, tok);
  check('B5: enabling without a max amount is refused', polNoMax.status === 400, String(polNoMax.status));

  pol = await api(base, 'PUT', '/api/agent/policy', { enabled: true, max_amount: 1000, min_sample: 5, min_rate: 0.7 }, tok);
  check('B5: owner enables policy', pol.status === 200 && pol.data.policy.enabled === true && pol.data.policy.max_amount === 1000,
    JSON.stringify(pol.data).slice(0, 200));
  const polAudit = raw.prepare("SELECT * FROM audit_log WHERE org_id = ? AND action = 'agent_policy_update'").get(orgId);
  check('B5: policy change audit-logged', !!polAudit, '');

  // ---------- B5: ON + qualifying -> executed + streamed ----------
  const propQ = await api(base, 'POST', '/api/agent/actions/propose', { kind: 'draft_appeal', claim_id: cQual }, tok);
  check('B5: qualifying draft auto-executes', propQ.status === 201 && propQ.data.action.status === 'executed' && propQ.data.action.auto_approved === true,
    JSON.stringify(propQ.data).slice(0, 300));
  const qualAction = propQ.data.action;
  const appealId = qualAction.result && qualAction.result.appeal_id;
  check('B5: auto-execution created the appeal draft', !!appealId && !!raw.prepare('SELECT id FROM appeals WHERE id = ?').get(appealId),
    JSON.stringify(qualAction.result || {}));
  const stream = await api(base, 'GET', '/api/agent/actions/auto-approved', null, tok);
  const streamRow = (stream.data.actions || []).find((a) => a.id === qualAction.id);
  check('B5: auto-approved stream lists it with the snapshot', !!streamRow && !!streamRow.auto_snapshot
    && streamRow.auto_snapshot.prediction && streamRow.auto_snapshot.prediction.sampleSize >= 5,
    JSON.stringify(streamRow || {}).slice(0, 300));

  // ---------- B5: ON + non-qualifying stays queued ----------
  const propBig = await api(base, 'POST', '/api/agent/actions/propose', { kind: 'draft_appeal', claim_id: cBig }, tok);
  check('B5: over-cap amount stays pending', propBig.status === 201 && propBig.data.action.status === 'pending',
    JSON.stringify(propBig.data).slice(0, 200));
  const propNoHist = await api(base, 'POST', '/api/agent/actions/propose', { kind: 'draft_appeal', claim_id: cNoHist }, tok);
  check('B5: no win history stays pending', propNoHist.status === 201 && propNoHist.data.action.status === 'pending',
    JSON.stringify(propNoHist.data).slice(0, 200));

  // ---------- B5: void the auto-approved draft ----------
  const voidRes = await api(base, 'POST', `/api/agent/actions/${qualAction.id}/void-auto`, {}, tok);
  check('B5: void succeeds', voidRes.status === 200 && voidRes.data.action.status === 'voided',
    `status=${voidRes.status} ${JSON.stringify(voidRes.data).slice(0, 200)}`);
  check('B5: void removed the draft appeal', !raw.prepare('SELECT id FROM appeals WHERE id = ?').get(appealId), '');
  const voidAudit = raw.prepare("SELECT * FROM audit_log WHERE org_id = ? AND action = 'agent_action_void_auto'").get(orgId);
  check('B5: void audit-logged', !!voidAudit, '');
  const voidAgain = await api(base, 'POST', `/api/agent/actions/${qualAction.id}/void-auto`, {}, tok);
  check('B5: double void refused (400)', voidAgain.status === 400, String(voidAgain.status));

  // Turn the policy back off for the batch tests.
  await api(base, 'PUT', '/api/agent/policy', { enabled: false, max_amount: 1000, min_sample: 5, min_rate: 0.7 }, tok);

  // ---------- B6: batch decide ----------
  const pending = await api(base, 'GET', '/api/agent/actions/pending', null, tok);
  const pendingIds = (pending.data.actions || []).filter((a) => a.status === 'pending').map((a) => a.id);
  check('B6: two human-queued actions pending', pendingIds.length === 2, JSON.stringify(pendingIds));
  const batch = await api(base, 'POST', '/api/agent/actions/batch-decide',
    { ids: [pendingIds[0], offActionId, 999999], decision: 'approve' }, tok);
  check('B6: batch approve mixed set — 1 executed, 1 skipped (already decided), 1 missing',
    batch.status === 200 && batch.data.summary.executed === 1 && batch.data.summary.skipped === 1 && batch.data.summary.missing === 1,
    JSON.stringify(batch.data).slice(0, 300));
  const batch2 = await api(base, 'POST', '/api/agent/actions/batch-decide', { ids: [pendingIds[0]], decision: 'approve' }, tok);
  check('B6: re-deciding the same id reports skipped (double-decide safe)',
    batch2.status === 200 && batch2.data.summary.skipped === 1 && batch2.data.summary.executed === 0,
    JSON.stringify(batch2.data).slice(0, 200));
  const batch3 = await api(base, 'POST', '/api/agent/actions/batch-decide', { ids: [pendingIds[1]], decision: 'reject' }, tok);
  check('B6: batch reject works', batch3.status === 200 && batch3.data.summary.rejected === 1, JSON.stringify(batch3.data).slice(0, 200));

  // ---------- B7: ERA pattern resolution ----------
  for (const [cn, billed] of [['GRP-1', 100], ['GRP-2', 200], ['GRP-3', 300]]) {
    raw.prepare(`INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date, billed_amount, paid_amount, status)
      VALUES (?, ?, ?, ?, '2026-09-02', ?, 0, 'in_ar')`).run(orgId, cn, `Patient ${cn}`, payer, billed);
  }
  const up = await upload(base, '/api/era/upload-835', 'scale-835.txt', ERA_835, tok);
  check('B7: 835 upload ok', up.status === 200, `status=${up.status}`);
  const groups = await api(base, 'GET', '/api/era/exception-groups', null, tok);
  const grp = (groups.data.groups || []).find((g) => g.primary_carc === 'CO-45');
  check('B7: variance lines group by payer x CARC x action (3 lines, $600)',
    !!grp && grp.count === 3 && Number(grp.total_billed) === 600 && grp.can_resolve === true,
    JSON.stringify(groups.data).slice(0, 300));
  const applied = await api(base, 'POST', '/api/era/exception-groups/apply', { line_ids: grp ? grp.line_ids : [] }, tok);
  check('B7: apply-to-all resolves every line', applied.status === 200 && applied.data.summary.resolved === 3 && applied.data.results.length === 3,
    JSON.stringify(applied.data).slice(0, 300));
  const leftPending = raw.prepare("SELECT COUNT(*) AS n FROM era_claim_lines WHERE org_id = ? AND post_status = 'pending'").get(orgId);
  check('B7: no lines left pending after apply', leftPending.n === 0, `n=${leftPending.n}`);
  const groupsAfter = await api(base, 'GET', '/api/era/exception-groups', null, tok);
  check('B7: group disappears once resolved', !(groupsAfter.data.groups || []).some((g) => g.primary_carc === 'CO-45'),
    JSON.stringify(groupsAfter.data).slice(0, 200));

  // ---------- B8: saved import mappings ----------
  const mapping = { claim_number: 'Clm #', patient_name: 'Member Name', payer: 'Carrier', service_date: 'DOS', billed_amount: 'Charges' };
  const save1 = await api(base, 'POST', '/api/agent/import/mappings', { name: 'Aetna monthly', mapping }, tok);
  check('B8: mapping saves', save1.status === 201 && !!save1.data.mapping.id, JSON.stringify(save1.data).slice(0, 200));
  const list1 = await api(base, 'GET', '/api/agent/import/mappings', null, tok);
  const listed = (list1.data.mappings || []).find((m) => m.name === 'Aetna monthly');
  check('B8: mapping round-trips intact', !!listed && JSON.stringify(listed.mapping) === JSON.stringify(mapping),
    JSON.stringify(listed || {}));
  const saveBad = await api(base, 'POST', '/api/agent/import/mappings', { name: 'Bad', mapping: { nope: 'X' } }, tok);
  check('B8: mapping with no valid fields refused', saveBad.status === 400, String(saveBad.status));
  const del = await api(base, 'DELETE', `/api/agent/import/mappings/${listed.id}`, null, tok);
  const list2 = await api(base, 'GET', '/api/agent/import/mappings', null, tok);
  check('B8: mapping deletes', del.status === 200 && !(list2.data.mappings || []).some((m) => m.id === listed.id),
    `del=${del.status}`);

  raw.close();
  console.log(`deploy101-scale: ${passed} passed, ${failed} failed`);
  for (const srv of servers) srv.kill('SIGTERM');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); for (const srv of servers) srv.kill('SIGTERM'); process.exit(1); });
