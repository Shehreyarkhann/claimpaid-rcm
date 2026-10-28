// agent-phase5-test.cjs — Agent Phase 5 verification.
// Boots the real server against a scripted fake model transport whose
// document-extraction replies are keyed by markers in the uploaded
// bytes, and verifies:
//   (WS1) document intake: type/size refusal, extraction -> deterministic
//         validation (line-balance + check-total mismatch flagged, claim
//         matching matched/unmatched), reviewer match fixes, apply_intake
//         approve creates the HELD remittance / reject creates nothing
//         and dismisses, denial-letter apply attaches + proposes a draft,
//         parse failure -> extract_failed, org isolation, turn metering.
//   (WS2) call copilot: briefs keyed to denial family; call-log writes
//         timeline activity + follow-up on the open appeal (or log-only
//         when none); promised_payment recorded; bad outcome refused.
//   (WS3) team insights: member 403, per-user math on seeded team data,
//         stalled items, suggestion only when strictly better.
//   (WS4) import wizard: synonym mapping + override, validation errors
//         with file row numbers, duplicates, commit through the real
//         claim path + counts, template shape, org isolation.
//   (WS5) audit: workspace totals vs the seeded filing data (expected
//         buckets recomputed from the DB in-test), ranked order, CSV
//         mode commits NOTHING, persistence + org isolation.
//   (+) agent-disabled boot: every Phase 5 endpoint 403s AGENT_DISABLED.
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

const TMP = '/tmp/agent-p5-test';
const FAKE = path.join(TMP, 'fake-transport.cjs');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

fs.writeFileSync(FAKE, `'use strict';
async function transport({ messages }) {
  const last = messages[messages.length - 1];
  const usage = { inputTokens: 120, outputTokens: 60 };
  if (last && last.attachments && last.attachments.length) {
    const att = last.attachments[0];
    const raw = Buffer.from(att.dataBase64, 'base64').toString('latin1');
    if (raw.includes('THROW')) throw new Error('stub transport exploded');
    if (raw.includes('GARBAGE')) return { text: 'this is not json at all', toolCalls: [], stopReason: 'end_turn', usage };
    if (raw.includes('DENIAL') || att.mediaType === 'image/png') {
      return { text: JSON.stringify({
        kind: 'denial_letter', remittance: null,
        denial_letter: { payer: 'Aetna', claim_number: 'CLM-200', patient: 'Pat Denied',
          denial_reasons: ['CO-50 - Non-covered service'], appeal_deadline: '2026-12-15',
          appeal_address: 'Aetna Appeals, PO Box 1400' } }),
        toolCalls: [], stopReason: 'end_turn', usage };
    }
    return { text: JSON.stringify({
      kind: 'remittance', denial_letter: null,
      remittance: { payer: 'Aetna', check_number: 'CHK-9', pay_date: '2026-10-20', payment_amount: 999,
        lines: [
          { claim_number: 'CLM-100', patient: 'Pat One', service_date: '2026-09-01', billed: 200, paid: 150,
            adjustments: [{ group: 'CO', reason: '45', amount: 50 }], patient_resp: 0 },
          { claim_number: 'CLM-999', patient: 'Ghost Pat', service_date: '2026-09-02', billed: 100, paid: 30,
            adjustments: [{ group: 'CO', reason: '45', amount: 40 }], patient_resp: 0 } ] } }),
      toolCalls: [], stopReason: 'end_turn', usage };
  }
  return { text: 'OK.', toolCalls: [], stopReason: 'end_turn', usage };
}
module.exports = transport;
module.exports.transport = transport;
module.exports.default = transport;
`);

const servers = [];
async function boot(port, env) {
  const dbPath = path.join(TMP, `test-${port}.db`);
  const server = spawn('node', ['src/index.js'], {
    cwd: path.join(REPO, 'server'),
    env: {
      ...process.env, PORT: String(port), DB_PATH: dbPath, JWT_SECRET: 'test-secret',
      EHR_AUTOPULL: 'off', AGENT_WATCHDOG: 'off', STRIPE_SECRET_KEY: '',
      AGENT_ENABLED: '', ANTHROPIC_API_KEY: '', AGENT_API_KEY: '', AGENT_BASE_URL: '', AGENT_TRANSPORT_MODULE: '', AGENT_MODEL: '',
      AI_DB_PATH: '', AI_SERVICE_URL: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server:${port}] ${d}`));
  servers.push(server);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) return { server, base, dbPath }; } catch { /* wait */ }
    await sleep(500);
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

async function upload(base, p, fileName, bytes, contentType, token) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: contentType }), fileName);
  const res = await fetch(base + p, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const isoDaysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

async function main() {
  console.log('— http: boot A (phase 5, agent enabled) —');
  const { base, dbPath } = await boot(4257, {
    AGENT_ENABLED: '1', ANTHROPIC_API_KEY: 'test-key-not-real', AGENT_TRANSPORT_MODULE: FAKE,
  });
  const sA = await api(base, 'POST', '/api/auth/signup', { orgName: 'P5 Org A', name: 'Ann Owner', email: 'a@p5.test', password: 'Test1234!' });
  const tokA = sA.data.token;
  const orgA = sA.data.user.org_id;
  const ownerId = sA.data.user.id;
  check('org A signup', sA.status === 201 && !!tokA, JSON.stringify(sA.data).slice(0, 150));
  const sB = await api(base, 'POST', '/api/auth/signup', { orgName: 'P5 Org B', name: 'Bob Owner', email: 'b@p5.test', password: 'Test1234!' });
  const tokB = sB.data.token;
  const orgB = sB.data.user.org_id;
  check('org B signup', sB.status === 201 && !!tokB);

  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(dbPath);
  const payerAetna = Number(raw.prepare("INSERT INTO payers (name, type, org_id) VALUES ('Aetna', 'commercial', ?)").run(orgA).lastInsertRowid);
  raw.prepare('INSERT INTO payer_filing_rules (org_id, payer_id, filing_days) VALUES (?, ?, 90)').run(orgA, payerAetna);
  const payerFast = Number(raw.prepare("INSERT INTO payers (name, type, org_id) VALUES ('FastPayer', 'commercial', ?)").run(orgA).lastInsertRowid);
  raw.prepare('INSERT INTO payer_filing_rules (org_id, payer_id, filing_days) VALUES (?, ?, 30)').run(orgA, payerFast);
  const insClaim = raw.prepare(`INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date, billed_amount, paid_amount, status, denial_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const claim100 = Number(insClaim.run(orgA, 'CLM-100', 'Pat One', payerAetna, '2026-09-01', 200, 0, 'in_ar', null).lastInsertRowid);
  const claim200 = Number(insClaim.run(orgA, 'CLM-200', 'Pat Denied', payerAetna, '2026-09-05', 300, 0, 'denied', 'Not medically necessary — documentation insufficient').lastInsertRowid);
  const claim201 = Number(insClaim.run(orgA, 'CLM-201', 'Pat Noauth', payerAetna, '2026-09-06', 450, 0, 'denied', 'Prior authorization was not obtained for this service').lastInsertRowid);
  // Appeal on CLM-201 (for the call follow-up) — assigned to the owner.
  const appeal201 = Number(raw.prepare(`INSERT INTO appeals (org_id, claim_id, assigned_to, status, priority)
    VALUES (?, ?, ?, 'open', 'high')`).run(orgA, claim201, ownerId).lastInsertRowid);
  check('seed claims + appeal', claim100 > 0 && claim200 > 0 && claim201 > 0 && appeal201 > 0);

  // ---------------- WS2 (before the denial-letter apply rewrites CLM-200) ----------------
  console.log('— WS2: payer-call copilot —');
  const brief200 = await api(base, 'GET', `/api/agent/claims/${claim200}/call-brief`, null, tokA);
  check('brief 200 medical_necessity family', brief200.status === 200 && brief200.data.brief.family === 'medical_necessity',
    JSON.stringify(brief200.data).slice(0, 200));
  check('MN brief asks about peer-to-peer', brief200.data.brief.questions.some((q) => q.includes('peer-to-peer')));
  check('brief has identifiers + escalation', brief200.data.brief.have_ready.some((h) => h.label === 'Claim number')
    && brief200.data.brief.escalation.includes('supervisor'));
  const brief201 = await api(base, 'GET', `/api/agent/claims/${claim201}/call-brief`, null, tokA);
  check('brief 201 no_auth family', brief201.status === 200 && brief201.data.brief.family === 'no_auth', JSON.stringify(brief201.data).slice(0, 200));
  check('no_auth brief asks about retro-authorization', brief201.data.brief.questions.some((q) => q.includes('retro-authorization')));
  check('brief families differ', JSON.stringify(brief200.data.brief.questions) !== JSON.stringify(brief201.data.brief.questions));
  const briefB = await api(base, 'GET', `/api/agent/claims/${claim200}/call-brief`, null, tokB);
  check('brief org isolation 404', briefB.status === 404, String(briefB.status));

  const promised = isoDaysAgo(-10); // 10 days out
  const log1 = await api(base, 'POST', `/api/agent/claims/${claim201}/call-log`,
    { agent_name: 'Rep Dana', reference_number: 'REF-77', outcome: 'promised_payment', promised_date: promised, notes: 'Will reprocess this week' }, tokA);
  check('call log 201', log1.status === 201 && log1.data.log.outcome === 'promised_payment', JSON.stringify(log1.data).slice(0, 250));
  check('promised date recorded on log', log1.data.log.promised_date === promised, JSON.stringify(log1.data.log));
  check('follow-up applied to the open appeal', log1.data.follow_up && log1.data.follow_up.date === promised && log1.data.follow_up.applied_to === 'appeal',
    JSON.stringify(log1.data.follow_up));
  const appealRow = raw.prepare('SELECT follow_up_date FROM appeals WHERE id = ?').get(appeal201);
  check('appeal follow_up_date set', appealRow.follow_up_date === promised, JSON.stringify(appealRow));
  const callAct = raw.prepare("SELECT * FROM claim_activity WHERE claim_id = ? AND action = 'payer_call'").get(claim201);
  check('payer_call activity written with ref', !!callAct && String(callAct.detail).includes('REF-77'), JSON.stringify(callAct));
  const log2 = await api(base, 'POST', `/api/agent/claims/${claim200}/call-log`, { outcome: 'voicemail' }, tokA);
  check('voicemail follow-up is log-only without an open appeal', log2.status === 201 && log2.data.follow_up
    && log2.data.follow_up.applied_to === 'log_only' && log2.data.follow_up.date === isoDaysAgo(-1),
    JSON.stringify(log2.data).slice(0, 250));
  const badOutcome = await api(base, 'POST', `/api/agent/claims/${claim200}/call-log`, { outcome: 'hung_up' }, tokA);
  check('bad outcome 400', badOutcome.status === 400, String(badOutcome.status));
  const badDate = await api(base, 'POST', `/api/agent/claims/${claim200}/call-log`, { outcome: 'other', promised_date: 'next friday' }, tokA);
  check('bad promised_date 400', badDate.status === 400, String(badDate.status));
  const analysis = await api(base, 'GET', `/api/agent/claims/${claim201}/analysis`, null, tokA);
  check('analysis carries call history', analysis.status === 200 && Array.isArray(analysis.data.call_history)
    && analysis.data.call_history.length === 1 && analysis.data.call_history[0].outcome_label === 'Payment promised',
    JSON.stringify(analysis.data.call_history || null));

  // ---------------- WS1: document intake ----------------
  console.log('— WS1: document intake —');
  const pdfBytes = Buffer.from('%PDF-1.7\nfake eob content for extraction\n');
  const upText = await upload(base, '/api/agent/documents', 'notes.txt', Buffer.from('just text'), 'text/plain', tokA);
  check('non-document file refused 400', upText.status === 400, String(upText.status));
  const bigPdf = Buffer.alloc(11 * 1024 * 1024, 0x20);
  Buffer.from('%PDF-1.7').copy(bigPdf, 0);
  const upBig = await upload(base, '/api/agent/documents', 'huge.pdf', bigPdf, 'application/pdf', tokA);
  check('oversize refused 400', upBig.status === 400, String(upBig.status));

  const up1 = await upload(base, '/api/agent/documents', 'eob-oct.pdf', pdfBytes, 'application/pdf', tokA);
  const doc1 = up1.data.document;
  check('remittance upload 201', up1.status === 201 && !!doc1, JSON.stringify(up1.data).slice(0, 250));
  check('kind remittance, status needs_review', doc1.kind === 'remittance' && doc1.status === 'needs_review', JSON.stringify(doc1).slice(0, 200));
  check('line 2 balance problem flagged', doc1.problems.some((p) => p.includes('Line 2') && p.includes('do not balance')), JSON.stringify(doc1.problems));
  check('line 2 unmatched problem flagged', doc1.problems.some((p) => p.includes('CLM-999')), JSON.stringify(doc1.problems));
  check('check-total mismatch flagged', doc1.problems.some((p) => p.includes('does not match the sum of line payments')), JSON.stringify(doc1.problems));
  check('matched_count 1 of 2', doc1.matched_count === 1 && doc1.line_count === 2, JSON.stringify(doc1));
  const line1 = doc1.extracted.lines[0];
  const line2 = doc1.extracted.lines[1];
  check('line 1 matched deterministically', line1.matched_claim_id === claim100 && line1.match_method === 'control_number', JSON.stringify(line1));
  check('line 2 unmatched', line2.matched_claim_id == null, JSON.stringify(line2));
  const usageRow = raw.prepare('SELECT turns FROM agent_usage WHERE org_id = ?').get(orgA);
  check('extraction metered as an agent turn', !!usageRow && usageRow.turns >= 1, JSON.stringify(usageRow));

  // Org isolation on every document surface.
  const listB = await api(base, 'GET', '/api/agent/documents', null, tokB);
  check('org B document list empty', listB.status === 200 && listB.data.documents.length === 0, JSON.stringify(listB.data).slice(0, 120));
  const detailB = await api(base, 'GET', `/api/agent/documents/${doc1.id}`, null, tokB);
  check('org B document detail 404', detailB.status === 404, String(detailB.status));
  const fileB = await fetch(`${base}/api/agent/documents/${doc1.id}/file`, { headers: { Authorization: `Bearer ${tokB}` } });
  check('org B document file 404', fileB.status === 404, String(fileB.status));
  const fileA = await fetch(`${base}/api/agent/documents/${doc1.id}/file`, { headers: { Authorization: `Bearer ${tokA}` } });
  check('owning org file served with pdf type', fileA.status === 200 && (fileA.headers.get('content-type') || '').includes('application/pdf'), String(fileA.status));
  const matchB = await api(base, 'POST', `/api/agent/documents/${doc1.id}/match`, { line_index: 1, claim_id: claim100 }, tokB);
  check('org B match attempt 404', matchB.status === 404, String(matchB.status));

  // Reviewer fixes the unmatched line by hand.
  const matched = await api(base, 'POST', `/api/agent/documents/${doc1.id}/match`, { line_index: 1, claim_id: claim100 }, tokA);
  check('manual match recorded', matched.status === 200 && matched.data.document.extracted.lines[1].matched_claim_id === claim100
    && matched.data.document.extracted.lines[1].match_method === 'manual', JSON.stringify(matched.data).slice(0, 250));
  check('unmatched problem cleared after match', !matched.data.document.problems.some((p) => p.includes('CLM-999')), JSON.stringify(matched.data.document.problems));
  check('balance problem survives match (honest)', matched.data.document.problems.some((p) => p.includes('do not balance')), JSON.stringify(matched.data.document.problems));

  // Approve -> held remittance through the ERA model.
  const prop1 = await api(base, 'POST', `/api/agent/documents/${doc1.id}/propose-apply`, {}, tokA);
  check('propose-apply creates apply_intake card', prop1.status === 201 && prop1.data.action.kind === 'apply_intake'
    && prop1.data.action.payload.document_id === doc1.id, JSON.stringify(prop1.data).slice(0, 250));
  const appr1 = await api(base, 'POST', `/api/agent/actions/${prop1.data.action.id}/approve`, {}, tokA);
  check('apply_intake approve executes', appr1.status === 200 && appr1.data.action.status === 'executed', JSON.stringify(appr1.data).slice(0, 300));
  const era1 = raw.prepare('SELECT * FROM era_remittances WHERE org_id = ? ORDER BY id').all(orgA);
  check('exactly one held remittance created', era1.length === 1 && era1[0].status === 'received', JSON.stringify(era1.map((e) => e.status)));
  const eraLines = raw.prepare('SELECT * FROM era_claim_lines WHERE era_id = ? ORDER BY id').all(era1[0].id);
  check('era lines all HELD (pending)', eraLines.length === 2 && eraLines.every((l) => l.post_status === 'pending'), JSON.stringify(eraLines.map((l) => l.post_status)));
  check('era line 1 control-number match', eraLines[0].match_claim_id === claim100 && eraLines[0].match_method === 'control_number', JSON.stringify(eraLines[0]));
  check('era line 2 manual match + variance flag', eraLines[1].match_claim_id === claim100 && eraLines[1].match_method === 'manual'
    && String(eraLines[1].flags).includes('variance'), JSON.stringify(eraLines[1]));
  const c100After = raw.prepare('SELECT paid_amount, status FROM claims WHERE id = ?').get(claim100);
  check('held lines posted NOTHING to claims', c100After.paid_amount === 0 && c100After.status === 'in_ar', JSON.stringify(c100After));
  const doc1After = await api(base, 'GET', `/api/agent/documents/${doc1.id}`, null, tokA);
  check('document marked applied + era linked', doc1After.data.document.status === 'applied' && doc1After.data.document.era_id === era1[0].id,
    JSON.stringify(doc1After.data.document).slice(0, 200));

  // Reject -> nothing created, document dismissed.
  const up2 = await upload(base, '/api/agent/documents', 'eob-nov.pdf', pdfBytes, 'application/pdf', tokA);
  const prop2 = await api(base, 'POST', `/api/agent/documents/${up2.data.document.id}/propose-apply`, {}, tokA);
  const rej2 = await api(base, 'POST', `/api/agent/actions/${prop2.data.action.id}/reject`, {}, tokA);
  check('reject recorded', rej2.status === 200 && rej2.data.action.status === 'rejected', JSON.stringify(rej2.data).slice(0, 200));
  const eraCountAfterReject = raw.prepare('SELECT COUNT(*) AS n FROM era_remittances WHERE org_id = ?').get(orgA).n;
  check('reject created no remittance', eraCountAfterReject === 1, String(eraCountAfterReject));
  const doc2After = await api(base, 'GET', `/api/agent/documents/${up2.data.document.id}`, null, tokA);
  check('rejected document dismissed', doc2After.data.document.status === 'dismissed', doc2After.data.document.status);

  // Denial letter (PDF marker + PNG image path).
  const upDenial = await upload(base, '/api/agent/documents', 'denial.pdf', Buffer.from('%PDF-1.7\nDENIAL letter bytes\n'), 'application/pdf', tokA);
  const docDenial = upDenial.data.document;
  check('denial letter classified + matched', docDenial.kind === 'denial_letter' && docDenial.matched === true, JSON.stringify(docDenial).slice(0, 250));
  const propD = await api(base, 'POST', `/api/agent/documents/${docDenial.id}/propose-apply`, {}, tokA);
  const apprD = await api(base, 'POST', `/api/agent/actions/${propD.data.action.id}/approve`, {}, tokA);
  check('denial apply executes', apprD.status === 200 && apprD.data.action.status === 'executed', JSON.stringify(apprD.data).slice(0, 300));
  const c200After = raw.prepare('SELECT status, denial_reason FROM claims WHERE id = ?').get(claim200);
  check('denial attached to the claim', c200After.status === 'denied' && String(c200After.denial_reason).includes('CO-50'), JSON.stringify(c200After));
  const denialAct = raw.prepare("SELECT * FROM claim_activity WHERE claim_id = ? AND action = 'denial_recorded'").get(claim200);
  check('denial activity carries letter deadline', !!denialAct && String(denialAct.detail).includes('2026-12-15'), JSON.stringify(denialAct));
  const draftFor200 = raw.prepare(`SELECT * FROM agent_actions WHERE org_id = ? AND kind = 'draft_appeal' AND status = 'pending'
    AND CAST(json_extract(payload, '$.claim_id') AS INTEGER) = ?`).get(orgA, claim200);
  check('appeal draft proposed for the denied claim', !!draftFor200, '');
  check('denial apply reports draft id', apprD.data.action.result && apprD.data.action.result.draft_action_id === draftFor200.id,
    JSON.stringify(apprD.data.action.result));

  const upPng = await upload(base, '/api/agent/documents', 'letter.png',
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]), 'image/png', tokA);
  check('PNG image path extracts as denial letter', upPng.status === 201 && upPng.data.document.kind === 'denial_letter', JSON.stringify(upPng.data).slice(0, 200));

  // Failure honesty: unparseable model reply + transport explosion.
  const jpgGarbage = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(' GARBAGE scan')]);
  const upGarbage = await upload(base, '/api/agent/documents', 'scan.jpg', jpgGarbage, 'image/jpeg', tokA);
  check('unparseable extraction -> extract_failed, never invented', upGarbage.status === 201
    && upGarbage.data.document.status === 'extract_failed' && upGarbage.data.document.extracted == null,
    JSON.stringify(upGarbage.data).slice(0, 250));
  const propGarbage = await api(base, 'POST', `/api/agent/documents/${upGarbage.data.document.id}/propose-apply`, {}, tokA);
  check('unclassified document cannot be applied', propGarbage.status === 400, String(propGarbage.status));
  const upThrow = await upload(base, '/api/agent/documents', 'boom.pdf', Buffer.from('%PDF-1.7\nTHROW\n'), 'application/pdf', tokA);
  check('transport failure -> extract_failed with the error listed', upThrow.status === 201
    && upThrow.data.document.status === 'extract_failed'
    && upThrow.data.document.problems.some((p) => p.includes('Extraction failed')), JSON.stringify(upThrow.data).slice(0, 250));
  const usageFinal = raw.prepare('SELECT turns FROM agent_usage WHERE org_id = ?').get(orgA);
  check('every extraction attempt metered (6 uploads)', usageFinal.turns === 6, JSON.stringify(usageFinal));

  // ---------------- WS3: team insights ----------------
  console.log('— WS3: team insights —');
  const billerId = Number(raw.prepare(`INSERT INTO users (org_id, email, password_hash, name, role)
    VALUES (?, 'biller@p5.test', 'x', 'Bea Biller', 'biller')`).run(orgA).lastInsertRowid);
  raw.prepare('INSERT INTO user_orgs (user_id, org_id, role) VALUES (?, ?, ?)').run(billerId, orgA, 'biller');
  const jwt = require(path.join(REPO, 'server', 'node_modules', 'jsonwebtoken'));
  const tokBiller = jwt.sign({ sub: billerId, org: orgA, role: 'biller', email: 'biller@p5.test', name: 'Bea Biller', tv: 0 }, 'test-secret');
  // Biller workload: 3 overdue follow-ups ($100 each), 2 won / 1 lost decided.
  const insAppeal = raw.prepare(`INSERT INTO appeals (org_id, claim_id, assigned_to, status, priority, follow_up_date)
    VALUES (?, ?, ?, ?, 'medium', ?)`);
  const bClaims = [];
  for (let i = 0; i < 6; i++) {
    // Recent DOS: these claims carry the overdue follow-ups but are NOT
    // filing-risk (90-day rule), so FR-1 is the only suggestion source.
    bClaims.push(Number(insClaim.run(orgA, `B-${i + 1}`, 'Team Pat', payerAetna, isoDaysAgo(5), 100, 0, 'pending', null).lastInsertRowid));
  }
  for (let i = 0; i < 3; i++) insAppeal.run(orgA, bClaims[i], billerId, 'open', isoDaysAgo(1));
  insAppeal.run(orgA, bClaims[3], billerId, 'won', null);
  insAppeal.run(orgA, bClaims[4], billerId, 'won', null);
  insAppeal.run(orgA, bClaims[5], billerId, 'lost', null);
  // Biller agent-draft record: 1 executed, 1 rejected, 1 pending.
  const insAction = raw.prepare(`INSERT INTO agent_actions (org_id, user_id, kind, payload, preview, status)
    VALUES (?, ?, 'draft_appeal', '{}', 'draft', ?)`);
  insAction.run(orgA, billerId, 'executed');
  insAction.run(orgA, billerId, 'rejected');
  insAction.run(orgA, billerId, 'pending');
  // Filing-risk claim sitting with the biller (FastPayer 30d, DOS 20d ago).
  const claimFR = Number(insClaim.run(orgA, 'FR-1', 'Risk Pat', payerFast, isoDaysAgo(20), 640, 0, 'denied', 'Bundling edit').lastInsertRowid);
  insAppeal.run(orgA, claimFR, billerId, 'open', null);
  // Stalled claim: untouched since creation 27 days ago, no activity rows.
  const claimStalled = Number(raw.prepare(`INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date, billed_amount, paid_amount, status, created_at)
    VALUES (?, 'ST-1', 'Stalled Pat', ?, ?, 777, 0, 'pending', datetime('now', '-27 days'))`).run(orgA, payerAetna, isoDaysAgo(40)).lastInsertRowid);
  check('team seeds in place', billerId > 0 && claimFR > 0 && claimStalled > 0);

  const team403 = await api(base, 'GET', '/api/agent/team-insights', null, tokBiller);
  check('member (biller) gets 403', team403.status === 403, String(team403.status));
  const team = await api(base, 'GET', '/api/agent/team-insights', null, tokA);
  check('owner gets team insights', team.status === 200 && Array.isArray(team.data.users), JSON.stringify(team.data).slice(0, 200));
  const billerRow = team.data.users.find((u) => u.user_id === billerId);
  check('biller overdue math (3 follow-ups, $300)', !!billerRow && billerRow.overdue_followups === 3 && billerRow.overdue_amount === 300, JSON.stringify(billerRow));
  check('biller decided/win-rate math (3 decided, 2 won, 0.67)', billerRow.appeals_decided === 3 && billerRow.appeals_won === 2 && billerRow.win_rate === 0.67, JSON.stringify(billerRow));
  check('biller draft record (1 approved, 1 rejected, 1 pending)', billerRow.agent_drafts_approved === 1 && billerRow.agent_drafts_rejected === 1
    && billerRow.pending_approvals === 1, JSON.stringify(billerRow));
  const ownerRow = team.data.users.find((u) => u.user_id === ownerId);
  check('owner starts with 0 overdue', !!ownerRow && ownerRow.overdue_followups === 0, JSON.stringify(ownerRow));
  const stalledHit = team.data.stalled.find((s) => s.claim_id === claimStalled);
  check('stalled claim listed with balance + idle days', !!stalledHit && stalledHit.balance === 777 && stalledHit.idle_days >= 27, JSON.stringify(team.data.stalled).slice(0, 250));
  const sug = team.data.suggestions.find((s) => s.claim_id === claimFR);
  check('reassignment suggested overloaded -> lightest', !!sug && sug.from_user_id === billerId && sug.to_user_id === ownerId, JSON.stringify(team.data.suggestions).slice(0, 250));

  // Balance the loads -> the strictly-better condition disappears.
  const oClaims = [];
  for (let i = 0; i < 3; i++) {
    oClaims.push(Number(insClaim.run(orgA, `O-${i + 1}`, 'Owner Pat', payerAetna, isoDaysAgo(5), 100, 0, 'pending', null).lastInsertRowid));
    insAppeal.run(orgA, oClaims[i], ownerId, 'open', isoDaysAgo(1));
  }
  const team2 = await api(base, 'GET', '/api/agent/team-insights', null, tokA);
  const ownerRow2 = team2.data.users.find((u) => u.user_id === ownerId);
  check('owner now carries 3 overdue too', !!ownerRow2 && ownerRow2.overdue_followups === 3, JSON.stringify(ownerRow2));
  check('no suggestion when loads are balanced', team2.data.suggestions.length === 0, JSON.stringify(team2.data.suggestions));

  // ---------------- WS4: import wizard ----------------
  console.log('— WS4: import wizard —');
  const tplRes = await fetch(base + '/api/agent/import/template', { headers: { Authorization: `Bearer ${tokA}` } });
  const tplText = await tplRes.text();
  check('template endpoint shape', tplRes.status === 200
    && tplText.split('\n')[0] === 'claim_number,patient_name,payer,service_date,billed_amount,paid_amount,status,denial_reason,patient_dob,member_id,cpt_codes,icd_codes'
    && tplText.includes('CLM-DEMO-001') && tplText.includes('EXAMPLE ROW'), tplText.slice(0, 160));

  const csvText = [
    'Claim ID,Patient,Insurance,DOS,Charges',
    'CLM-100,Pat One,Aetna,2026-09-01,200',
    'IMP-1,New Person,BrandNew Payer,11/05/2026,150.25',
    'IMP-2,,Aetna,2026-11-06,50',
    'IMP-3,Bad Amt,Aetna,2026-11-07,abc',
    '',
  ].join('\n');
  const prev = await upload(base, '/api/agent/import/preview', 'claims.csv', Buffer.from(csvText), 'text/csv', tokA);
  const pv = prev.data.preview;
  check('preview created', prev.status === 201 && !!pv, JSON.stringify(prev.data).slice(0, 250));
  check('synonym mapping auto-detected', pv.mapping.claim_number === 'Claim ID' && pv.mapping.payer === 'Insurance'
    && pv.mapping.service_date === 'DOS' && pv.mapping.billed_amount === 'Charges', JSON.stringify(pv.mapping));
  const rows = pv.validation.rows;
  check('duplicate vs existing claim flagged (row 2)', rows[0].row === 2 && rows[0].duplicate === true && rows[0].valid === false, JSON.stringify(rows[0]).slice(0, 250));
  check('valid row: US date + amount parsed, new payer previewed', rows[1].valid === true && rows[1].values.service_date === '2026-11-05'
    && rows[1].values.billed_amount === 150.25 && rows[1].payer_status === 'new', JSON.stringify(rows[1]).slice(0, 250));
  check('missing patient error carries row 4', rows[2].row === 4 && rows[2].valid === false
    && rows[2].errors.some((e) => e.includes('patient_name')), JSON.stringify(rows[2]).slice(0, 250));
  check('bad amount error carries row 5', rows[3].row === 5 && rows[3].valid === false
    && rows[3].errors.some((e) => e.includes('billed_amount')), JSON.stringify(rows[3]).slice(0, 250));
  check('summary counts', pv.validation.summary.total === 4 && pv.validation.summary.valid === 1 && pv.validation.summary.duplicates === 1,
    JSON.stringify(pv.validation.summary));

  // Mapping override: point billed_amount at the Patient column -> the
  // previously valid row must fail; restore -> valid again.
  const wrongMap = { ...pv.mapping, billed_amount: 'Patient' };
  const remapped = await api(base, 'POST', `/api/agent/import/preview/${pv.id}/mapping`, { mapping: wrongMap }, tokA);
  const wrongRow = remapped.data.preview.validation.rows[1];
  check('mapping override revalidates (billed now reads names)', wrongRow.valid === false
    && wrongRow.errors.some((e) => e.includes('billed_amount')), JSON.stringify(wrongRow).slice(0, 250));
  const restored = await api(base, 'POST', `/api/agent/import/preview/${pv.id}/mapping`, { mapping: pv.mapping }, tokA);
  check('mapping restored -> row valid again', restored.data.preview.validation.rows[1].valid === true, JSON.stringify(restored.data.preview.validation.rows[1]).slice(0, 200));

  // CSV audit BEFORE commit (WS5 csv mode uses this preview).
  const claimsBeforeAudit = raw.prepare('SELECT COUNT(*) AS n FROM claims WHERE org_id = ?').get(orgA).n;
  const audCsv = await api(base, 'POST', '/api/agent/audit/run', { source: 'csv', preview_id: pv.id }, tokA);
  check('csv audit runs from the preview', audCsv.status === 201 && audCsv.data.audit.result.source === 'csv', JSON.stringify(audCsv.data).slice(0, 250));
  check('csv audit counts auditable rows, skips the amount-less one', audCsv.data.audit.result.audited_claims === 3
    && audCsv.data.audit.result.skipped_rows === 1, JSON.stringify(audCsv.data.audit.result).slice(0, 250));
  const claimsAfterAudit = raw.prepare('SELECT COUNT(*) AS n FROM claims WHERE org_id = ?').get(orgA).n;
  check('csv audit committed NOTHING', claimsAfterAudit === claimsBeforeAudit, `${claimsBeforeAudit} -> ${claimsAfterAudit}`);

  const commitB = await api(base, 'POST', '/api/agent/import/commit', { preview_id: pv.id }, tokB);
  check('org B cannot commit org A preview', commitB.status === 404, String(commitB.status));
  const commit = await api(base, 'POST', '/api/agent/import/commit', { preview_id: pv.id }, tokA);
  check('commit counts (1 created, 3 skipped)', commit.status === 200 && commit.data.result.created === 1 && commit.data.result.skipped === 3,
    JSON.stringify(commit.data).slice(0, 300));
  const imp1 = raw.prepare("SELECT * FROM claims WHERE org_id = ? AND claim_number = 'IMP-1'").get(orgA);
  check('imported claim exists via the real path, pending', !!imp1 && imp1.status === 'pending' && imp1.service_date === '2026-11-05'
    && imp1.billed_amount === 150.25, JSON.stringify(imp1));
  check('new payer created at commit', commit.data.result.payers_created.includes('BrandNew Payer'), JSON.stringify(commit.data.result));
  const impAct = raw.prepare("SELECT * FROM claim_activity WHERE claim_id = ? AND action = 'created'").get(imp1.id);
  check('import used createClaimDraft (activity logged)', !!impAct, '');

  // ---------------- WS5: workspace audit ----------------
  console.log('— WS5: deadline audit —');
  // Seeded filing set (Aetna 90-day rule): AU-1..AU-5.
  insClaim.run(orgA, 'AU-1', 'Audit Pat', payerAetna, isoDaysAgo(80), 500, 0, 'pending', null);
  insClaim.run(orgA, 'AU-2', 'Audit Pat', payerAetna, isoDaysAgo(70), 300, 0, 'pending', null);
  insClaim.run(orgA, 'AU-3', 'Audit Pat', payerAetna, isoDaysAgo(40), 200, 0, 'pending', null);
  insClaim.run(orgA, 'AU-4', 'Audit Pat', payerAetna, isoDaysAgo(100), 700, 0, 'pending', null);
  const au5 = Number(insClaim.run(orgA, 'AU-5', 'Audit Pat', payerAetna, isoDaysAgo(10), 9999, 0, 'pending', null).lastInsertRowid);
  // Expected buckets recomputed from the DB with the app's own filing SQL.
  const filingRows = raw.prepare(`
    SELECT c.claim_number, round(c.billed_amount - c.paid_amount, 2) AS balance,
      CAST(julianday(date(c.service_date, '+' || COALESCE(fr.filing_days, 365) || ' days')) - julianday('now') AS INTEGER) AS days_left
    FROM claims c LEFT JOIN payer_filing_rules fr ON fr.payer_id = c.payer_id AND fr.org_id = c.org_id
    WHERE c.org_id = ? AND c.status IN ('pending', 'in_ar', 'denied')
  `).all(orgA);
  const exp = { d14: { count: 0, amount: 0 }, d30: { count: 0, amount: 0 }, d60: { count: 0, amount: 0 }, expired: { count: 0, amount: 0 } };
  for (const r of filingRows) {
    if (r.days_left < 0) { exp.expired.count++; exp.expired.amount += r.balance; }
    if (r.days_left >= 0 && r.days_left <= 14) { exp.d14.count++; exp.d14.amount += r.balance; }
    if (r.days_left >= 0 && r.days_left <= 30) { exp.d30.count++; exp.d30.amount += r.balance; }
    if (r.days_left >= 0 && r.days_left <= 60) { exp.d60.count++; exp.d60.amount += r.balance; }
  }
  const aud = await api(base, 'POST', '/api/agent/audit/run', { source: 'workspace' }, tokA);
  const res = aud.data.audit && aud.data.audit.result;
  check('workspace audit runs', aud.status === 201 && !!res, JSON.stringify(aud.data).slice(0, 250));
  check('horizon 14 matches seeded filing data', res.horizons.d14.count === exp.d14.count && res.horizons.d14.amount === Math.round(exp.d14.amount * 100) / 100,
    `api ${JSON.stringify(res.horizons.d14)} vs expected ${JSON.stringify(exp.d14)}`);
  check('horizon 30 matches', res.horizons.d30.count === exp.d30.count && res.horizons.d30.amount === Math.round(exp.d30.amount * 100) / 100,
    `api ${JSON.stringify(res.horizons.d30)} vs expected ${JSON.stringify(exp.d30)}`);
  check('horizon 60 matches', res.horizons.d60.count === exp.d60.count && res.horizons.d60.amount === Math.round(exp.d60.amount * 100) / 100,
    `api ${JSON.stringify(res.horizons.d60)} vs expected ${JSON.stringify(exp.d60)}`);
  check('expired bucket matches', res.expired.count === exp.expired.count && res.expired.amount === Math.round(exp.expired.amount * 100) / 100,
    `api ${JSON.stringify(res.expired)} vs expected ${JSON.stringify(exp.expired)}`);
  check('audit names the workspace', res.workspace === 'P5 Org A', res.workspace);
  check('far-future claim (AU-5, $9999) excluded from the report', !res.top.some((t) => t.claim_number === 'AU-5')
    && !res.by_payer.some((p) => p.amount >= 9999), JSON.stringify(res.top).slice(0, 200));
  let ranked = true;
  for (let i = 1; i < res.top.length; i++) {
    const a = res.top[i - 1], b = res.top[i];
    if (a.days_left > b.days_left || (a.days_left === b.days_left && a.balance < b.balance)) ranked = false;
  }
  check('top list ranked by days left, then balance', ranked && res.top.length > 0 && res.top.length <= 25, JSON.stringify(res.top.map((t) => [t.claim_number, t.days_left])));
  check('all top entries inside the 60-day window', res.top.every((t) => t.days_left <= 60), '');
  const auditList = await api(base, 'GET', '/api/agent/audit', null, tokA);
  check('audits persisted + listed (csv + workspace)', auditList.status === 200 && auditList.data.audits.length === 2, JSON.stringify(auditList.data).slice(0, 200));
  const auditGet = await api(base, 'GET', `/api/agent/audit/${aud.data.audit.id}`, null, tokA);
  check('audit reopenable by id', auditGet.status === 200 && auditGet.data.audit.result.horizons.d60.count === res.horizons.d60.count, '');
  const auditGetB = await api(base, 'GET', `/api/agent/audit/${aud.data.audit.id}`, null, tokB);
  check('audit org isolation 404', auditGetB.status === 404, String(auditGetB.status));
  const badSource = await api(base, 'POST', '/api/agent/audit/run', { source: 'everything' }, tokA);
  check('bad audit source 400', badSource.status === 400, String(badSource.status));

  // ---------------- Agent disabled ----------------
  console.log('— boot B: agent disabled —');
  const bootB = await boot(4259, {});
  const sC = await api(bootB.base, 'POST', '/api/auth/signup', { orgName: 'P5 Org C', name: 'Cat Owner', email: 'c@p5.test', password: 'Test1234!' });
  const tokC = sC.data.token;
  for (const [method, p, body] of [
    ['GET', '/api/agent/documents', null],
    ['GET', '/api/agent/team-insights', null],
    ['GET', '/api/agent/audit', null],
    ['POST', '/api/agent/audit/run', { source: 'workspace' }],
    ['GET', '/api/agent/import/template', null],
  ]) {
    const r = await api(bootB.base, method, p, body, tokC);
    check(`disabled: ${method} ${p} -> 403 AGENT_DISABLED`, r.status === 403 && r.data.code === 'AGENT_DISABLED', `${r.status} ${JSON.stringify(r.data).slice(0, 100)}`);
  }

  console.log(`\nPHASE5: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((e) => { console.error('PHASE5 CRASH', e); process.exitCode = 1; })
  .finally(() => { for (const s of servers) { try { s.kill('SIGKILL'); } catch { /* already gone */ } } });
