#!/usr/bin/env node
/**
 * appeal-letter-test.cjs — Deploy #98 appeal-letter landing.
 *
 * PART A (migration + data repair): builds a LEGACY-shaped fixture DB —
 * appeals/appeal_notes in the pre-#98 shape (no letter columns) WITH
 * child rows, plus an agent_actions row whose payload letter was dumped
 * into a note verbatim — boots the real server against it, and asserts:
 *   - the letter/submitted_at/submitted_via columns appear
 *   - a letter-shaped note (Re:/Dear markers) moves into appeals.letter
 *     and is replaced by the one-line system note
 *   - a note matching an agent_actions payload letter moves too
 *     (exact-match path, no Re:/Dear markers needed)
 *   - a long NON-letter note is left completely untouched (conservative)
 *   - short notes are untouched; the migration is recorded + idempotent
 *
 * PART B (executor + appeals API): fresh DB, fake agent transport.
 *   - approve draft_appeal -> letter in appeals.letter, NO full-letter
 *     note, one short system note, result letter_location 'appeal'
 *   - approve a SECOND draft for the same claim -> existing letter kept,
 *     new draft appended as 'Additional draft letter (agent)' note,
 *     result letter_location 'additional_note'
 *   - PUT /api/appeals/:id/letter round-trips + validates + is
 *     activity-logged on the claim
 *   - POST /api/appeals/:id/mark-submitted validates the channel, sets
 *     status/submitted_via/submitted_at and defaults follow-up to +10d
 *   - GET /api/claims/:id carries filing fields, the appeals summary
 *     (has_letter, submitted_via) and matched ERA lines
 *
 * Usage: node deploy/appeal-letter-test.cjs
 * Exit 0 = PASS (prints counts), 1 = FAIL.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'appeal-letter-'));
const FAKE = path.join(TMP, 'fake-transport.cjs');
fs.writeFileSync(FAKE, `'use strict';\nmodule.exports = { async callModel() { throw new Error('fake transport: no model in tests'); } };\n`);

let passed = 0; let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ok', name); }
  else { failed++; console.log('  FAIL', name, extra ? `— ${extra}` : ''); }
}

function boot(port, dbPath, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['server/src/index.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), DB_PATH: dbPath, JWT_SECRET: 'appeal-letter-test', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30000;
    (async function poll() {
      try {
        const r = await fetch(base + '/api/health');
        if (r.ok) return resolve({ proc, base });
      } catch { /* retry */ }
      if (Date.now() > deadline) return reject(new Error('boot timeout: ' + err.slice(-400)));
      setTimeout(poll, 200);
    })();
  });
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

// ---------------------------------------------------------------- Part A
const LETTER_A = [
  'October 12, 2026', '',
  'UnitedHealthcare', 'Appeals Department', '',
  'Re: Formal Appeal — Denied Claim CLM-A1', 'Patient: Dana Legacy', '',
  'Dear Appeals Reviewer:', '',
  'We are writing to formally appeal the denial of the above-referenced claim for services rendered to our patient. The documentation enclosed with this letter demonstrates that the services were medically necessary, were ordered by the treating physician, and were performed exactly as billed. The denial reason cited by the payer does not reflect the clinical record, and we respectfully request that the claim be reprocessed and paid in full, including any interest owed under applicable prompt-pay rules.', '',
  'Sincerely,', 'Legacy Billing Department',
].join('\n');
const LONG_NONLETTER = ('Called the payer about the status of this claim and the representative said the claim is still in review and to call back next week for another update on the review outcome. ').repeat(4);
const LETTER_C = [
  'To the Appeals Department of Aetna,', '',
  'This office writes on behalf of our patient regarding a denied claim for physical therapy services rendered during September. The enclosed treatment notes, the signed plan of care, and the referring physician order together show that each billed unit was delivered as documented and was medically necessary for the patient to recover function after surgery. We therefore ask that the denial be overturned and the claim paid according to the terms of the member plan.', '',
  'Harbor Billing Department',
].join('\n');
const SYSTEM_NOTE = 'Appeal letter moved to the letter panel — it was previously saved here as a note.';

function buildLegacyFixture(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE appeals (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, claim_id INTEGER NOT NULL,
      assigned_to INTEGER, status TEXT DEFAULT 'open', priority TEXT DEFAULT 'medium', angle TEXT,
      follow_up_date TEXT, payer_response TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE appeal_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, appeal_id INTEGER NOT NULL, user_id INTEGER,
      note TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE agent_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, user_id INTEGER,
      convo_id INTEGER, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', payload TEXT NOT NULL DEFAULT '{}',
      preview TEXT NOT NULL DEFAULT '', result TEXT, decided_by INTEGER, decided_at TEXT, executed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')));
  `);
  const insAppeal = db.prepare('INSERT INTO appeals (org_id, claim_id, assigned_to, status, priority) VALUES (1, ?, 1, ?, ?)');
  const a1 = Number(insAppeal.run(1, 'open', 'medium').lastInsertRowid);
  const a2 = Number(insAppeal.run(2, 'open', 'low').lastInsertRowid);
  const a3 = Number(insAppeal.run(3, 'open', 'high').lastInsertRowid);
  const insNote = db.prepare('INSERT INTO appeal_notes (appeal_id, user_id, note) VALUES (?, 1, ?)');
  const nLetter = Number(insNote.run(a1, LETTER_A).lastInsertRowid);
  const nShort = Number(insNote.run(a1, 'Called payer, ref 123.').lastInsertRowid);
  const nLong = Number(insNote.run(a2, LONG_NONLETTER).lastInsertRowid);
  const nPayload = Number(insNote.run(a3, LETTER_C).lastInsertRowid);
  db.prepare(`INSERT INTO agent_actions (org_id, user_id, kind, status, payload, preview, created_at)
    VALUES (1, 1, 'draft_appeal', 'executed', ?, 'Draft letter for CLM-C3', '2026-10-20 09:00:00')`)
    .run(JSON.stringify({ claim_id: 3, claim_number: 'CLM-C3', letter: LETTER_C }));
  db.close();
  return { a1, a2, a3, nLetter, nShort, nLong, nPayload };
}

async function partA() {
  console.log('— part A: legacy fixture migration + repair —');
  const dbPath = path.join(TMP, 'legacy.db');
  const ids = buildLegacyFixture(dbPath);
  check('fixture letters exceed the 400-char heuristic', LETTER_A.length > 400 && LETTER_C.length > 400 && LONG_NONLETTER.length > 400,
    `A=${LETTER_A.length} C=${LETTER_C.length} long=${LONG_NONLETTER.length}`);

  const read = () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    const out = {
      cols: db.prepare("SELECT name FROM pragma_table_info('appeals')").all().map((r) => r.name),
      appeals: db.prepare('SELECT id, letter FROM appeals ORDER BY id').all(),
      notes: db.prepare('SELECT id, note FROM appeal_notes ORDER BY id').all(),
      marker: db.prepare("SELECT name FROM data_migrations WHERE name = 'appeal-letter-repair-98'").get(),
    };
    db.close();
    return out;
  };

  let s = await boot(4161, dbPath);
  let state = read();
  check('migration: letter/submitted columns added',
    ['letter', 'submitted_at', 'submitted_via'].every((c) => state.cols.includes(c)), state.cols.join(','));
  const ap = Object.fromEntries(state.appeals.map((a) => [a.id, a.letter]));
  const nt = Object.fromEntries(state.notes.map((n) => [n.id, n.note]));
  check('repair: Re:/Dear letter note moved into appeals.letter', ap[ids.a1] === LETTER_A);
  check('repair: moved note replaced by the one-line system note', nt[ids.nLetter] === SYSTEM_NOTE, String(nt[ids.nLetter]).slice(0, 60));
  check('repair: short note untouched', nt[ids.nShort] === 'Called payer, ref 123.');
  check('repair: long NON-letter note left untouched, letter stays empty', ap[ids.a2] == null && nt[ids.nLong] === LONG_NONLETTER);
  check('repair: payload-matching note moved (exact-match path)', ap[ids.a3] === LETTER_C);
  check('repair: payload note replaced by the system note', nt[ids.nPayload] === SYSTEM_NOTE);
  check('migration: marker recorded', !!state.marker);
  s.proc.kill(); await new Promise((r) => s.proc.on('exit', r));

  // Idempotency: a second boot must not re-run or disturb anything.
  s = await boot(4162, dbPath);
  state = read();
  const ap2 = Object.fromEntries(state.appeals.map((a) => [a.id, a.letter]));
  const nt2 = Object.fromEntries(state.notes.map((n) => [n.id, n.note]));
  check('idempotent: second boot leaves letters and notes stable',
    ap2[ids.a1] === LETTER_A && ap2[ids.a3] === LETTER_C && ap2[ids.a2] == null
    && nt2[ids.nLetter] === SYSTEM_NOTE && nt2[ids.nLong] === LONG_NONLETTER);
  s.proc.kill(); await new Promise((r) => s.proc.on('exit', r));
}

// ---------------------------------------------------------------- Part B
let partBServer = null;
async function partB() {
  console.log('— part B: executor + appeals API —');
  const dbPath = path.join(TMP, 'fresh.db');
  const booted = await boot(4163, dbPath, {
    AGENT_ENABLED: '1', ANTHROPIC_API_KEY: 'test-key-not-real', AGENT_TRANSPORT_MODULE: FAKE,
  });
  partBServer = booted.proc;
  const base = booted.base;
  const s = await api(base, 'POST', '/api/auth/signup', { orgName: 'Letter Org', name: 'Lena Owner', email: 'l@letter.test', password: 'Test1234!' });
  const tok = s.data.token;
  check('signup', s.status === 201 && !!tok, JSON.stringify(s.data).slice(0, 150));

  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(dbPath);
  const orgId = raw.prepare("SELECT id FROM orgs WHERE name = 'Letter Org'").get().id;
  const payerId = raw.prepare("SELECT id FROM payers WHERE org_id = ? AND name = 'Aetna'").get(orgId).id;
  const claimId = Number(raw.prepare(`INSERT INTO claims (org_id, claim_number, patient_name, patient_dob, member_id, payer_id,
      service_date, billed_amount, paid_amount, allowed_amount, adjustment_amount, patient_resp_amount, patient_paid_amount,
      status, denial_reason, cpt_codes, icd_codes, days_in_ar)
    VALUES (?, 'L-100', 'Lena Letter', '1980-04-02', 'MBR-123', ?, date('now', '-10 days'), 640, 0, 0, 0, 0, 0,
      'denied', 'CO-50 not medically necessary', '97110,97140', 'M54.5', 12)`).run(orgId, payerId).lastInsertRowid);
  // One matched ERA line so the claim detail must surface it.
  const eraId = Number(raw.prepare("INSERT INTO era_remittances (org_id, payer_name, check_number, payment_amount, status) VALUES (?, 'Aetna', 'CHK-L1', 0, 'received')").run(orgId).lastInsertRowid);
  raw.prepare(`INSERT INTO era_claim_lines (era_id, org_id, clp_ref, patient_name, billed, paid, adjustments, match_claim_id, post_status)
    VALUES (?, ?, 'L-100', 'Lena Letter', 640, 0, '[{"group":"CO","code":"50","amount":640}]', ?, 'pending')`).run(eraId, orgId, claimId);
  raw.close();

  // First draft: propose + approve.
  const p1 = await api(base, 'POST', '/api/agent/actions/propose', { kind: 'draft_appeal', claim_id: claimId }, tok);
  check('propose draft_appeal -> pending action', p1.status === 201 && p1.data.action?.status === 'pending', JSON.stringify(p1.data).slice(0, 200));
  const ap1 = await api(base, 'POST', `/api/agent/actions/${p1.data.action.id}/approve`, {}, tok);
  const r1 = ap1.data.action?.result || {};
  check('approve #1 executes', ap1.status === 200 && ap1.data.action?.status === 'executed', JSON.stringify(ap1.data).slice(0, 200));
  check('executor: letter NOT saved as note', r1.letter_saved_as_note === false, JSON.stringify(r1));
  check('executor: letter_location = appeal', r1.letter_location === 'appeal', JSON.stringify(r1));
  const appealId = r1.appeal_id;
  check('executor: appeal id returned', Number.isInteger(appealId), JSON.stringify(r1));

  const d1 = await api(base, 'GET', `/api/appeals/${appealId}`, null, tok);
  const letter1 = d1.data.letter || '';
  check('appeal detail carries the letter', letter1.length > 400 && letter1.includes('Dear Appeals Reviewer'), `len=${letter1.length}`);
  const notes1 = d1.data.notes || [];
  check('no note contains the full letter', notes1.every((n) => (n.note || '').length <= 400), JSON.stringify(notes1.map((n) => n.note.length)));
  check('exactly one short system note about the letter panel',
    notes1.filter((n) => /letter panel/.test(n.note || '')).length === 1, JSON.stringify(notes1.map((n) => n.note)));
  const list = await api(base, 'GET', '/api/appeals?status=open', null, tok);
  const listRows = Array.isArray(list.data) ? list.data : (list.data.appeals || []);
  const row = listRows.find((a) => a.id === appealId);
  check('appeals list exposes has_letter=1', row && row.has_letter === 1, JSON.stringify(row || list.data).slice(0, 200));

  // Second draft for the same claim: existing letter must win. Change the
  // denial reason first so the regenerated letter actually differs (the
  // letter generator is deterministic — same inputs, same letter).
  const raw2 = new DatabaseSync(dbPath);
  raw2.prepare("UPDATE claims SET denial_reason = 'CO-179 missing information' WHERE id = ?").run(claimId);
  raw2.close();
  const p2 = await api(base, 'POST', '/api/agent/actions/propose', { kind: 'draft_appeal', claim_id: claimId }, tok);
  const ap2 = await api(base, 'POST', `/api/agent/actions/${p2.data.action.id}/approve`, {}, tok);
  const r2 = ap2.data.action?.result || {};
  check('approve #2 executes on the same appeal', ap2.status === 200 && r2.appeal_id === appealId, JSON.stringify(r2));
  check('executor: second draft lands as additional note', r2.letter_location === 'additional_note' && r2.letter_saved_as_note === true, JSON.stringify(r2));
  const d2 = await api(base, 'GET', `/api/appeals/${appealId}`, null, tok);
  check('existing letter preserved after second draft', d2.data.letter === letter1);
  const addl = (d2.data.notes || []).filter((n) => (n.note || '').startsWith('Additional draft letter (agent)'));
  check('additional-draft note present exactly once', addl.length === 1, `n=${addl.length}`);

  // Letter edit endpoint.
  const noTok = await api(base, 'PUT', `/api/appeals/${appealId}/letter`, { letter: 'x'.repeat(500) }, null);
  check('PUT letter unauthenticated -> 401', noTok.status === 401, `status=${noTok.status}`);
  const empty = await api(base, 'PUT', `/api/appeals/${appealId}/letter`, { letter: '   ' }, tok);
  check('PUT letter empty -> 400', empty.status === 400, `status=${empty.status}`);
  const EDITED = 'EDITED LETTER — final version after biller review. ' + 'Body sentence for the edited appeal letter. '.repeat(12);
  const put = await api(base, 'PUT', `/api/appeals/${appealId}/letter`, { letter: EDITED }, tok);
  check('PUT letter saves + returns updated appeal', put.status === 200 && put.data.letter === EDITED, JSON.stringify(put.data).slice(0, 150));

  // Mark submitted.
  const badVia = await api(base, 'POST', `/api/appeals/${appealId}/mark-submitted`, { via: 'smoke_signal' }, tok);
  check('mark-submitted invalid channel -> 400', badVia.status === 400, `status=${badVia.status}`);
  const ms = await api(base, 'POST', `/api/appeals/${appealId}/mark-submitted`, { via: 'fax' }, tok);
  check('mark-submitted succeeds', ms.status === 200, JSON.stringify(ms.data).slice(0, 200));
  check('mark-submitted sets status=submitted', ms.data.status === 'submitted', ms.data.status);
  check('mark-submitted records via + timestamp', ms.data.submitted_via === 'fax' && !!ms.data.submitted_at,
    JSON.stringify({ via: ms.data.submitted_via, at: ms.data.submitted_at }));
  const plus10 = [0, -1, 1].map((off) => { const d = new Date(); d.setDate(d.getDate() + 10 + off); return d.toISOString().slice(0, 10); });
  check('mark-submitted defaults follow-up to +10 days', plus10.includes(ms.data.follow_up_date), `got ${ms.data.follow_up_date}`);

  // Claim detail: filing + appeals summary + era lines + activity log.
  const cd = await api(base, 'GET', `/api/claims/${claimId}`, null, tok);
  check('claim detail 200', cd.status === 200, JSON.stringify(cd.data).slice(0, 150));
  check('claim detail carries filing deadline + days', !!cd.data.filing_deadline && cd.data.days_until_filing != null,
    JSON.stringify({ fd: cd.data.filing_deadline, du: cd.data.days_until_filing }));
  const cap = (cd.data.appeals || [])[0] || {};
  check('claim detail appeal summary: has_letter + submitted_via',
    cap.has_letter === 1 && cap.submitted_via === 'fax' && cap.submitted_at != null, JSON.stringify(cap));
  check('claim detail surfaces the matched ERA line',
    Array.isArray(cd.data.era_lines) && cd.data.era_lines.length === 1 && cd.data.era_lines[0].check_number === 'CHK-L1',
    JSON.stringify(cd.data.era_lines || []).slice(0, 200));
  check('letter edit is activity-logged on the claim',
    (cd.data.activity || []).some((a) => a.action === 'appeal_letter_edited'),
    JSON.stringify((cd.data.activity || []).map((a) => a.action)));
}

(async () => {
  try {
    await partA();
    await partB();
  } catch (e) {
    failed++;
    console.log('  FAIL exception:', e.message);
  }
  console.log(`\nAPPEAL-LETTER TEST: ${passed} passed, ${failed} failed`);
  if (partBServer) { try { partBServer.kill(); } catch { /* already gone */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
