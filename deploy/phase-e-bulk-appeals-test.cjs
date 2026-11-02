// phase-e-bulk-appeals-test.cjs — Phase E (Commure parity): bulk appeals
// + grading.
//   1. cohort preview filters by payer + reason + date range; every row
//      carries a grade (partial, citation unscored)
//   2. grades rest on the org's OWN outcome stats: seeded 75% win
//      history lifts the grade; a no-history cohort is capped at C and
//      labeled 'no data yet'
//   3. bulk-draft creates PENDING draft_appeal actions through the same
//      tool path — each payload carries the FULL grade (citation scored
//      on the letter) and the serialized card exposes it
//   4. dedupe: a claim with a pending draft is skipped on re-run
//   5. the existing batch-decide approves the cohort; appeals save as
//      drafts (never submitted)
//   6. single chat-path drafts (tools/run draft_appeal) carry grades too
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${typeof extra === 'object' ? JSON.stringify(extra).slice(0, 300) : extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 4133;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = '/tmp/phase-e-bulk';
const DB = path.join(TMP, 'test.db');
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
function dbRead(sql, ...params) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB, { readOnly: true });
  const row = db.prepare(sql).get(...params);
  db.close();
  return row;
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  try {
    server = spawn('node', ['src/index.js'], {
      cwd: path.join(__dirname, '..', 'server'),
      env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret', EHR_AUTOPULL: 'off', STRIPE_SECRET_KEY: '', AGENT_ENABLED: '1', ANTHROPIC_API_KEY: 'test-agent-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    let up = false;
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch { /* wait */ }
      await sleep(500);
    }
    check('server up', up);

    const U = await api('POST', '/api/auth/signup', { name: 'Owner E', email: 'e@test.co', password: 'Test1234!', orgName: 'Phase E Clinic' });
    const tok = U.data.token;
    await api('POST', '/api/onboarding/complete', { plan: 'pro' }, tok);

    const mkClaim = (over) => api('POST', '/api/claims', {
      claim_number: over.claim_number, patient_name: 'Pat E', payer: 'Aetna',
      service_date: '2026-10-10', billed_amount: 300, status: 'denied',
      denial_reason: 'CO-29 — timely filing', cpt_codes: '99214', icd_codes: 'M54.5',
      rendering_npi: '1234567890', rendering_provider: 'Dr E', patient_dob: '1980-01-01',
      member_id: 'MBR1', ...over,
    }, tok);

    const c1 = await mkClaim({ claim_number: 'E-1' });
    const c2 = await mkClaim({ claim_number: 'E-2', service_date: '2026-10-12' });
    const c3 = await mkClaim({ claim_number: 'E-3', denial_reason: 'CO-97 — bundled', service_date: '2026-09-01' });
    const c4 = await mkClaim({ claim_number: 'E-4', payer: 'Cigna' });
    check('seed claims created', [c1, c2, c3, c4].every((c) => c.status === 201), [c1, c2, c3, c4].map((c) => c.status));

    // Win history for Aetna + CO-29: 20 decided, 15 overturned (75%),
    // all under the timely_filing angle so the learned-angle path fires.
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(DB);
    const orgId = raw.prepare("SELECT id FROM orgs WHERE name = 'Phase E Clinic'").get().id;
    const aetnaId = raw.prepare("SELECT id FROM payers WHERE org_id = ? AND name = 'Aetna'").get(orgId)?.id
      || raw.prepare("SELECT id FROM payers WHERE name = 'Aetna'").get().id;
    raw.prepare(`INSERT INTO agent_outcome_stats (org_id, payer_id, denial_reason, angle, appeals, overturned)
      VALUES (?, ?, 'CO-29 — timely filing', 'timely_filing', 20, 15)`).run(orgId, aetnaId);
    raw.close();

    // 1+2. cohort preview: Aetna + CO-29, October range -> E-1, E-2 only.
    const cohort = await api('GET', '/api/agent/appeals/cohort?payer=Aetna&denial_reason=CO-29&from=2026-10-01&to=2026-10-31', null, tok);
    check('cohort filters payer+reason+range (2 claims)',
      cohort.status === 200 && cohort.data.cohort.length === 2
      && cohort.data.cohort.every((c) => ['E-1', 'E-2'].includes(c.claim_number)), cohort.data);
    const g0 = cohort.data.cohort[0].grade;
    check('preview grade: partial, win component 45 (75% of 60), labeled established',
      !!g0 && g0.partial === true && g0.components.win_history === 45
      && g0.win_rate === 0.75 && g0.sample_size === 20 && g0.label === 'established', g0);
    check('preview grade: citation unscored (null) until a letter exists',
      g0.components.citation_strength === null && typeof g0.components.documentation === 'number', g0);

    // No PAIR-specific history (Cigna): the win component falls back to
    // the org-overall record and is discounted to 25% — labeled by basis.
    const cohortC = await api('GET', '/api/agent/appeals/cohort?payer=Cigna', null, tok);
    const gC = cohortC.data.cohort[0]?.grade;
    check('no pair history: org-overall fallback discounted (win 45 -> 11), grade stays low',
      !!gC && gC.basis === 'org overall' && gC.win_basis_weight === 0.25
      && gC.components.win_history === 11 && gC.win_rate === 0.75
      && ['F', 'D', 'C', 'B', 'A'].indexOf(gC.letter) <= 2, gC);

    // 3. bulk draft the Aetna cohort.
    const ids = cohort.data.cohort.map((c) => c.claim_id);
    const bulk = await api('POST', '/api/agent/appeals/bulk-draft', { claim_ids: ids }, tok);
    check('bulk draft created 2 pending actions', bulk.status === 200 && bulk.data.summary.created === 2 && bulk.data.summary.skipped === 0, bulk.data);
    const a0 = bulk.data.created[0];
    check('draft action is pending draft_appeal', a0.kind === 'draft_appeal' && a0.status === 'pending', a0);
    check('full grade on the card: citation scored, not partial, beats preview',
      !!a0.payload.grade && a0.payload.grade.partial === false
      && typeof a0.payload.grade.components.citation_strength === 'number'
      && a0.payload.grade.score >= g0.score, a0.payload.grade);
    check('grade letter sane with 75% win history (B or better on score)',
      ['A', 'B'].includes(a0.payload.grade.letter) || a0.payload.grade.score >= 60, a0.payload.grade);

    // 4. dedupe on re-run.
    const bulk2 = await api('POST', '/api/agent/appeals/bulk-draft', { claim_ids: ids }, tok);
    check('re-run skips already-pending claims', bulk2.data.summary.created === 0 && bulk2.data.summary.skipped === 2
      && bulk2.data.skipped.every((s) => s.reason === 'already_pending'), bulk2.data);
    const cohort2 = await api('GET', '/api/agent/appeals/cohort?payer=Aetna&denial_reason=CO-29', null, tok);
    check('cohort flags pending drafts', cohort2.data.cohort.every((c) => c.has_pending_draft === true), cohort2.data);

    // Validation: non-denied / missing claims skip honestly.
    const bulkBad = await api('POST', '/api/agent/appeals/bulk-draft', { claim_ids: [99999] }, tok);
    check('unknown claim skipped as not_found', bulkBad.data.summary.skipped === 1 && bulkBad.data.skipped[0].reason === 'not_found', bulkBad.data);
    const bulkEmpty = await api('POST', '/api/agent/appeals/bulk-draft', { claim_ids: [] }, tok);
    check('empty claim_ids refused', bulkEmpty.status === 400, bulkEmpty);

    // 5. batch-decide approves the cohort through the existing path.
    const actionIds = bulk.data.created.map((a) => a.id);
    const decide = await api('POST', '/api/agent/actions/batch-decide', { ids: actionIds, decision: 'approve' }, tok);
    check('batch approve executed both drafts', decide.status === 200 && decide.data.summary.executed === 2, decide.data);
    const appealRow = dbRead('SELECT a.status, a.submitted_at FROM appeals a JOIN claims c ON c.id = a.claim_id WHERE c.claim_number = ?', 'E-1');
    check('approved draft saved as OPEN appeal, never submitted',
      !!appealRow && appealRow.status === 'open' && appealRow.submitted_at === null, appealRow);

    // 6. grades ride the pending-approvals surface too (the card data):
    //    draft the leftover CO-97 claim and read it back from the list.
    const bulk3 = await api('POST', '/api/agent/appeals/bulk-draft', { claim_ids: [c3.data.id] }, tok);
    check('leftover claim drafts', bulk3.data.summary.created === 1, bulk3.data);
    const pending = await api('GET', '/api/agent/actions/pending', null, tok);
    const pAction = (pending.data.actions || []).find((a) => a.id === bulk3.data.created[0].id);
    check('pending list exposes the grade on the card payload',
      !!pAction && !!pAction.payload.grade && typeof pAction.payload.grade.score === 'number'
      && pAction.payload.grade.partial === false, pAction);
  } catch (e) {
    failed++;
    console.log('  FAIL exception:', e.stack);
  } finally {
    if (server) server.kill('SIGKILL');
    console.log(`\nphase-e-bulk-appeals: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
