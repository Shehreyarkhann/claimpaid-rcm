// Deploy #62 test: coding-assist evidence grounding + tri-state assessment.
// Seeds completed coding_jobs rows directly, then verifies via the real API:
//  - a suggestion whose evidence quote is verbatim in the note, in-library,
//    high confidence -> status 'valid', evidence_verified, span offsets that
//    slice back to the quote
//  - fabricated evidence -> 'review', evidence_verified false, span null
//  - verified evidence but low confidence -> 'review'
//  - zero suggestions -> job assessment 'abstain'
// Run: node deploy/coding-grounding-test.cjs
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'code62-'));
const DB = path.join(TMP, 't.db'); const PORT = 4121;
let passed = 0, failed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log('  ok -', n); } else { failed++; console.log('  FAIL -', n, x !== undefined ? JSON.stringify(x) : ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp(tries = 60) { for (let i = 0; i < tries; i++) { try { const r = await fetch(`http://localhost:${PORT}/api/health`); if (r.ok) return true; } catch {} await sleep(500); } return false; }
async function call(method, p, body, token) {
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, body: j };
}

const NOTE = 'Patient presents with low back pain for two weeks. Established patient visit, low complexity medical decision making, 25 minutes spent with the patient today.';

(async () => {
  const env = { ...process.env, PORT: String(PORT), DB_PATH: DB, NODE_ENV: 'test' };
  const srv = spawn('node', ['src/index.js'], { cwd: path.join(__dirname, '..', 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; srv.stderr.on('data', (d) => { err += d; });
  try {
    check('server up', await waitUp(), err.slice(-300));
    const S = await call('POST', '/api/auth/signup', { name: 'Coder', email: 'c@test.co', password: 'Test1234!', orgName: 'Org C' });
    const tok = S.body.token, orgId = S.body.user.org_id, userId = S.body.user.id;
    check('signup', !!tok, S.body);
    const oc = await call('POST', '/api/onboarding/complete', { plan: 'pro' }, tok);
    check('onboarding pro (trial)', oc.status === 200 || oc.status === 201, oc.body);

    const db = new DatabaseSync(DB);
    const ins = db.prepare(`INSERT INTO coding_jobs (org_id, note_text, status, result_json, created_by) VALUES (?, ?, 'complete', ?, ?)`);
    const jobA = Number(ins.run(orgId, NOTE, JSON.stringify({
      model: 'qwen2.5:3b-instruct',
      suggestions: [
        { code: 'M54.5', type: 'ICD10', confidence: 0.92, evidence: 'low back pain', rationale: 'Documented diagnosis' },
        { code: '99213', type: 'CPT', confidence: 0.9, evidence: 'detailed surgical consultation was performed', rationale: 'Fabricated quote' },
        { code: '99213', type: 'CPT', confidence: 0.6, evidence: 'Established patient visit', rationale: 'Real quote, low confidence' },
      ],
    }), userId).lastInsertRowid);
    const jobB = Number(ins.run(orgId, NOTE, JSON.stringify({ model: 'qwen2.5:3b-instruct', suggestions: [] }), userId).lastInsertRowid);
    db.close();

    const A = await call('GET', `/api/coding/jobs/${jobA}`, null, tok);
    check('job A fetch', A.status === 200, A.body);
    const [s1, s2, s3] = A.body.suggestions || [];
    check('A: 3 suggestions', (A.body.suggestions || []).length === 3, A.body.suggestions);
    check('A1 grounded -> valid', s1 && s1.status === 'valid' && s1.evidence_verified === true, s1);
    check('A1 span slices to the quote', !!s1 && !!s1.evidence_span && NOTE.slice(s1.evidence_span.start, s1.evidence_span.end).toLowerCase() === 'low back pain',
      s1 && s1.evidence_span ? NOTE.slice(s1.evidence_span.start, s1.evidence_span.end) : s1);
    check('A2 fabricated evidence -> review + unverified + no span', s2 && s2.status === 'review' && s2.evidence_verified === false && s2.evidence_span === null, s2);
    check('A3 low confidence -> review despite verified quote', s3 && s3.status === 'review' && s3.evidence_verified === true, s3);
    check('A3 span finds case-insensitive quote', !!s3 && !!s3.evidence_span && NOTE.slice(s3.evidence_span.start, s3.evidence_span.end) === 'Established patient visit', s3 && s3.evidence_span);
    check('A assessment ready', A.body.assessment === 'ready', A.body.assessment);
    check('A summary 3/1/2', A.body.summary && A.body.summary.total === 3 && A.body.summary.valid === 1 && A.body.summary.review === 2, A.body.summary);
    check('A in_library flags intact', s1 && s1.in_library === true && s2 && s2.in_library === true, [s1 && s1.in_library, s2 && s2.in_library]);

    const B = await call('GET', `/api/coding/jobs/${jobB}`, null, tok);
    check('B assessment abstain', B.body.assessment === 'abstain', B.body);
    check('B summary zeros', B.body.summary && B.body.summary.total === 0 && B.body.summary.valid === 0, B.body.summary);
  } finally {
    srv.kill('SIGKILL');
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
