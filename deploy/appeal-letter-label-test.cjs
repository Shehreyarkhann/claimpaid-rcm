#!/usr/bin/env node
/**
 * appeal-letter-label-test.cjs — Deploy #99 appeal-letter LABELING pass.
 *
 * Builds a LEGACY-shaped fixture DB (appeals/appeal_notes in the pre-#98
 * shape, WITH child rows) arranged so the #98 repair leaves the exact
 * production leftover behind: an appeal whose longest letter-note moved
 * into appeals.letter while OTHER full draft letters still sit in its
 * notes as plain comments. Boots the real server and asserts the #99
 * pass (marker 'appeal-letter-label-99'):
 *   - prefixes each leftover qualifying letter-note with the executor's
 *     own format 'Additional draft letter (agent)\n\n' — prefix only,
 *     the letter text itself is never moved, edited, or deleted
 *   - qualifies notes through the SAME heuristic as #98 (Re:/Dear
 *     markers AND the agent_actions payload exact-match path)
 *   - skips notes already carrying the prefix (no double labeling)
 *   - never touches appeals WITHOUT a letter (the #98 repair owns
 *     those), long non-letter notes, or short notes
 *   - leaves appeals.letter byte-identical; records its marker; a
 *     second boot is fully idempotent
 *
 * Usage: node deploy/appeal-letter-label-test.cjs
 * Exit 0 = PASS (prints counts), 1 = FAIL.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'appeal-label-'));

let passed = 0; let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ok', name); }
  else { failed++; console.log('  FAIL', name, extra ? `— ${extra}` : ''); }
}

function boot(port, dbPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['server/src/index.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), DB_PATH: dbPath, JWT_SECRET: 'appeal-label-test' },
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

// ------------------------------------------------------------- letters
const BODY = 'We are writing to formally appeal the denial of the above-referenced claim for services rendered to our patient. The documentation enclosed with this letter demonstrates that the services were medically necessary, were ordered by the treating physician, and were performed exactly as billed. ';
const mkLetter = (tag, reps) => [
  'October 12, 2026', '',
  'UnitedHealthcare', 'Appeals Department', '',
  `Re: Formal Appeal — Denied Claim ${tag}`, 'Patient: Dana Legacy', '',
  'Dear Appeals Reviewer:', '',
  BODY.repeat(reps), '',
  'Sincerely,', 'Legacy Billing Department',
].join('\n');
const LETTER_LONG = mkLetter('CLM-L1', 3);   // longest on appeal 1 -> moves to appeals.letter under #98
const LETTER_MID = mkLetter('CLM-L1', 2);    // leftover on appeal 1 -> #99 must label it
const LETTER_SHORT = mkLetter('CLM-L3', 1);  // body of the already-prefixed note on appeal 3
const PREFIXED = `Additional draft letter (agent)\n\n${LETTER_SHORT}`;
const LETTER_BIG = mkLetter('CLM-L3', 4);    // longest on appeal 3 -> moves to appeals.letter under #98
const LETTER_BIG2 = mkLetter('CLM-L4', 3);   // longest on appeal 4 -> moves to appeals.letter under #98
// No Re: line and no "Dear " salutation — qualifies ONLY via the
// agent_actions payload exact-match path (same shape as #98 test LETTER_C).
const LETTER_PAYLOAD = [
  'To the Appeals Department of Aetna,', '',
  'This office writes on behalf of our patient regarding a denied claim for physical therapy services rendered during September. The enclosed treatment notes, the signed plan of care, and the referring physician order together show that each billed unit was delivered as documented and was medically necessary for the patient to recover function after surgery. We therefore ask that the denial be overturned and the claim paid according to the terms of the member plan in full. ', '',
  'Harbor Billing Department',
].join('\n');
const LONG_NONLETTER = ('Called the payer about the status of this claim and the representative said the claim is still in review and to call back next week for another update on the review outcome. ').repeat(4);
const SYSTEM_NOTE = 'Appeal letter moved to the letter panel — it was previously saved here as a note.';
const PREFIX = 'Additional draft letter (agent)';

function buildFixture(dbPath) {
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
  const a4 = Number(insAppeal.run(4, 'open', 'medium').lastInsertRowid);
  const insNote = db.prepare('INSERT INTO appeal_notes (appeal_id, user_id, note) VALUES (?, 1, ?)');
  const ids = {
    a1, a2, a3, a4,
    nLong: Number(insNote.run(a1, LETTER_LONG).lastInsertRowid),
    nMid: Number(insNote.run(a1, LETTER_MID).lastInsertRowid),
    nShort: Number(insNote.run(a1, 'Called payer, ref 9.').lastInsertRowid),
    nNonLetter: Number(insNote.run(a2, LONG_NONLETTER).lastInsertRowid),
    nPrefixed: Number(insNote.run(a3, PREFIXED).lastInsertRowid),
    nBig: Number(insNote.run(a3, LETTER_BIG).lastInsertRowid),
    nPayload: Number(insNote.run(a4, LETTER_PAYLOAD).lastInsertRowid),
    nBig2: Number(insNote.run(a4, LETTER_BIG2).lastInsertRowid),
  };
  const insAct = db.prepare(`INSERT INTO agent_actions (org_id, user_id, kind, status, payload, preview, created_at)
    VALUES (1, 1, 'draft_appeal', 'executed', ?, ?, '2026-10-20 09:00:00')`);
  insAct.run(JSON.stringify({ claim_id: 3, claim_number: 'CLM-L3', letter: LETTER_BIG }), 'Draft letter for CLM-L3');
  insAct.run(JSON.stringify({ claim_id: 4, claim_number: 'CLM-L4', letter: LETTER_PAYLOAD }), 'Draft letter for CLM-L4');
  db.close();
  return ids;
}

(async () => {
  try {
    console.log('— appeal-letter-label-99: fixture + labeling pass —');
    check('fixture letter lengths order as designed',
      LETTER_LONG.length > LETTER_MID.length && LETTER_MID.length > 400
      && LETTER_BIG.length > PREFIXED.length && PREFIXED.length > 400
      && LETTER_BIG2.length > LETTER_PAYLOAD.length && LETTER_PAYLOAD.length > 400
      && LONG_NONLETTER.length > 400,
      `LONG=${LETTER_LONG.length} MID=${LETTER_MID.length} BIG=${LETTER_BIG.length} PREFIXED=${PREFIXED.length} BIG2=${LETTER_BIG2.length} PAYLOAD=${LETTER_PAYLOAD.length} NONLETTER=${LONG_NONLETTER.length}`);
    check('payload letter has no Re:/Dear markers (exact-match path only)',
      !/(^|\n)\s*Re:/.test(LETTER_PAYLOAD) && !/\nDear /.test(`\n${LETTER_PAYLOAD}`));

    const dbPath = path.join(TMP, 'label.db');
    const ids = buildFixture(dbPath);
    const read = () => {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath);
      const out = {
        appeals: Object.fromEntries(db.prepare('SELECT id, letter FROM appeals ORDER BY id').all().map((a) => [a.id, a.letter])),
        notes: Object.fromEntries(db.prepare('SELECT id, note FROM appeal_notes ORDER BY id').all().map((n) => [n.id, n.note])),
        markers: db.prepare('SELECT name FROM data_migrations').all().map((r) => r.name),
      };
      db.close();
      return out;
    };

    let s = await boot(4171, dbPath);
    let st = read();
    check('#98 repair ran first (marker recorded)', st.markers.includes('appeal-letter-repair-98'));
    check('label pass marker recorded', st.markers.includes('appeal-letter-label-99'));
    // Appeal 1: the production shape — longest moved, leftover labeled.
    check('appeal 1: longest letter is the saved letter (label pass did not move/edit it)', st.appeals[ids.a1] === LETTER_LONG);
    check('appeal 1: moved note is the #98 system note, unlabeled', st.notes[ids.nLong] === SYSTEM_NOTE);
    check('appeal 1: leftover letter-note prefixed with the executor format, text intact',
      st.notes[ids.nMid] === `${PREFIX}\n\n${LETTER_MID}`,
      String(st.notes[ids.nMid]).slice(0, 60));
    check('appeal 1: short note untouched', st.notes[ids.nShort] === 'Called payer, ref 9.');
    // Appeal 2: no letter — this pass must never touch it.
    check('appeal 2 (no letter): note + empty letter untouched by the label pass',
      st.appeals[ids.a2] == null && st.notes[ids.nNonLetter] === LONG_NONLETTER);
    // Appeal 3: already-prefixed note skipped byte-for-byte.
    check('appeal 3: longest letter is the saved letter', st.appeals[ids.a3] === LETTER_BIG);
    check('appeal 3: moved note is the #98 system note', st.notes[ids.nBig] === SYSTEM_NOTE);
    check('appeal 3: already-prefixed note NOT double-labeled', st.notes[ids.nPrefixed] === PREFIXED,
      String(st.notes[ids.nPrefixed]).slice(0, 70));
    // Appeal 4: leftover qualifies only via the payload exact-match path.
    check('appeal 4: longest letter is the saved letter', st.appeals[ids.a4] === LETTER_BIG2);
    check('appeal 4: payload-matching leftover labeled via exact-match path',
      st.notes[ids.nPayload] === `${PREFIX}\n\n${LETTER_PAYLOAD}`,
      String(st.notes[ids.nPayload]).slice(0, 60));
    s.proc.kill(); await new Promise((r) => s.proc.on('exit', r));

    // Idempotency: a second boot changes nothing at all.
    s = await boot(4172, dbPath);
    const st2 = read();
    check('idempotent: second boot leaves every letter + note byte-identical',
      JSON.stringify(st2.appeals) === JSON.stringify(st.appeals)
      && JSON.stringify(st2.notes) === JSON.stringify(st.notes));
    s.proc.kill(); await new Promise((r) => s.proc.on('exit', r));
  } catch (e) {
    failed++;
    console.log('  FAIL exception:', e.message);
  }
  console.log(`\nAPPEAL-LETTER-LABEL TEST: ${passed} passed, ${failed} failed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
