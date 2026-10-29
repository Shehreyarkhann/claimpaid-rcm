#!/usr/bin/env node
/**
 * deploy103-test.cjs — Deploy #103 growth surfaces.
 *
 * Part 1 — public deadline audit (/audit/):
 *   - jsdom against the real page + audit.js: manual rows compute correct
 *     buckets (expired / ≤14d / safe; dollars sum), CSV fixture parses and
 *     matches the manual results, the lead POST body contains aggregates
 *     only (no claim refs, no per-claim amounts, no dates of service),
 *     disclaimer + "never leaves your browser" present, consent assets
 *     present, no raw beacon.
 *   - Server: POST /api/leads/audit stores aggregates, ignores smuggled
 *     claim-level fields, honeypot short-circuits, rate limit holds.
 *
 * Part 2 — denial code library:
 *   - Generator rebuild is byte-identical (hash, regenerate, re-hash).
 *   - Every data entry produced a page; every page parses, has valid
 *     JSON-LD, canonical, consent assets; sitemap contains every URL;
 *     internal links resolve to files that exist; index filter works.
 *
 * Usage: NODE_PATH=~/workspace/smoke-test/node_modules node deploy/deploy103-test.cjs
 * Exit 0 = PASS, 1 = FAIL.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');

const HOME_DIR = process.env.HOME;
const SRC = path.join(HOME_DIR, 'workspace/claimpilot/landing');
const DATA = path.join(HOME_DIR, 'workspace/claimpilot/landing-data');
const MIRROR = path.join(__dirname, '..', 'landing');
const GENERATOR = path.join(__dirname, '..', 'landing-tools/generate-denial-codes.cjs');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok  ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const codesData = JSON.parse(fs.readFileSync(path.join(DATA, 'denial-codes.json'), 'utf8'));
const deadlinesData = JSON.parse(fs.readFileSync(path.join(DATA, 'payer-deadlines.json'), 'utf8'));
const CODES = codesData.codes;

/* =============== Part 2a: generator determinism =============== */
function hashTree() {
  const h = crypto.createHash('sha256');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else files.push(p);
    }
  })(path.join(SRC, 'denial-codes'));
  files.push(path.join(SRC, 'deadlines/index.html'));
  files.sort();
  for (const f of files) h.update(f).update(fs.readFileSync(f));
  return h.digest('hex');
}
function generatorDeterminism() {
  console.log('== generator determinism ==');
  const before = hashTree();
  execFileSync('node', [GENERATOR], { stdio: 'pipe' });
  const after = hashTree();
  check('generator rebuild is byte-identical', before === after);
}

/* =============== Part 2b: library pages =============== */
function urlToFile(u) {
  // https://claimpaid.io/denial-codes/co-97/ -> SRC/denial-codes/co-97/index.html
  const p = u.replace('https://claimpaid.io', '');
  if (p === '/' || p === '') return path.join(SRC, 'index.html');
  if (p.startsWith('/blog/') || p.startsWith('/ai/')) return null; // covered by other suites
  return path.join(SRC, p, 'index.html');
}
function libraryChecks() {
  console.log('== denial code library ==');
  check('data file ships 31 codes', CODES.length === 31, CODES.length);
  let allExist = true, allParse = true, allLd = true, allCanon = true, allConsent = true, allFields = true;
  for (const c of CODES) {
    const f = path.join(SRC, 'denial-codes', c.slug, 'index.html');
    if (!fs.existsSync(f)) { allExist = false; console.log('    missing page: ' + c.slug); continue; }
    const html = fs.readFileSync(f, 'utf8');
    if (!html.includes('<link rel="stylesheet" href="/consent.css"/>') || !html.includes('<script src="/consent.js" defer></script>') || html.includes('static.cloudflareinsights.com')) allConsent = false;
    if (!html.includes(`<link rel="canonical" href="https://claimpaid.io/denial-codes/${c.slug}/"/>`)) allCanon = false;
    if (!html.includes(c.meaning.slice(0, 60)) || !html.includes(c.route.slice(0, 40)) || !html.includes(c.faq[0].q)) allFields = false;
    try {
      const dom = new JSDOM(html, { url: 'https://claimpaid.io/' });
      const blocks = [...dom.window.document.querySelectorAll('script[type="application/ld+json"]')];
      const types = blocks.map((b) => JSON.parse(b.textContent)['@type']);
      if (!(types.includes('Article') && types.includes('FAQPage') && types.includes('BreadcrumbList'))) allLd = false;
      dom.window.close();
    } catch (e) { allParse = false; console.log('    parse/LD error ' + c.slug + ': ' + e.message); }
  }
  check('every data entry produced a page', allExist);
  check('every page parses with Article+FAQPage+BreadcrumbList JSON-LD', allParse && allLd);
  check('every page has its canonical', allCanon);
  check('every page: consent assets, no raw beacon', allConsent);
  check('every page renders its data fields (meaning, route, faq)', allFields);

  // sitemap contains every new URL
  const sitemap = fs.readFileSync(path.join(SRC, 'sitemap.xml'), 'utf8');
  const newUrls = ['https://claimpaid.io/audit/', 'https://claimpaid.io/denial-codes/', 'https://claimpaid.io/deadlines/',
    ...CODES.map((c) => `https://claimpaid.io/denial-codes/${c.slug}/`)];
  check('sitemap contains all 34 new URLs', newUrls.every((u) => sitemap.includes(`<loc>${u}</loc>`)),
    newUrls.filter((u) => !sitemap.includes(`<loc>${u}</loc>`)));

  // internal links resolve
  const linkTargets = new Set();
  for (const c of CODES) {
    const html = fs.readFileSync(path.join(SRC, 'denial-codes', c.slug, 'index.html'), 'utf8');
    for (const m of html.matchAll(/href="(\/(?:denial-codes|deadlines|audit)\/[^"]*)"/g)) linkTargets.add(m[1]);
  }
  const idxHtml = fs.readFileSync(path.join(SRC, 'denial-codes/index.html'), 'utf8');
  for (const m of idxHtml.matchAll(/href="(\/(?:denial-codes|deadlines|audit)\/[^"]*)"/g)) linkTargets.add(m[1]);
  const dlHtml = fs.readFileSync(path.join(SRC, 'deadlines/index.html'), 'utf8');
  for (const m of dlHtml.matchAll(/href="(\/(?:denial-codes|deadlines|audit)\/[^"]*)"/g)) linkTargets.add(m[1]);
  const broken = [...linkTargets].filter((t) => !fs.existsSync(path.join(SRC, t, 'index.html')));
  check('all internal links (related codes, /audit/, /deadlines/) resolve to files', broken.length === 0, broken);

  // llms.txt + footers + home CTA + blog article link
  const llms = fs.readFileSync(path.join(SRC, 'llms.txt'), 'utf8');
  check('llms.txt names the audit tool + library + deadlines hub',
    llms.includes('https://claimpaid.io/audit/') && llms.includes('https://claimpaid.io/denial-codes/') && llms.includes('https://claimpaid.io/deadlines/'));
  const home = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  check('home #audit CTA links to /audit/', home.includes('<a class="btn btn-green" href="/audit/">Run the free audit →</a>'));
  check('home footer links the library', home.includes('<a href="/denial-codes/">Denial Code Library</a>'));
  const blogIdx = fs.readFileSync(path.join(SRC, 'blog/index.html'), 'utf8');
  check('blog index footer links the library', blogIdx.includes('<a href="/denial-codes/">Denial Code Library</a>'));
  const tfArticle = fs.readFileSync(path.join(SRC, 'blog/timely-filing-limits-by-payer-2026/index.html'), 'utf8');
  check('timely-filing blog article links /deadlines/', tfArticle.includes('<a href="/deadlines/">timely filing deadlines by payer</a>'));

  // mirror equality for generated trees
  let mirrorOk = true;
  for (const rel of ['denial-codes', 'deadlines', 'audit']) {
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else {
          const rel2 = path.relative(SRC, p);
          if (!fs.existsSync(path.join(MIRROR, rel2)) || !fs.readFileSync(p).equals(fs.readFileSync(path.join(MIRROR, rel2)))) { mirrorOk = false; console.log('    mirror differs: ' + rel2); }
        }
      }
    })(path.join(SRC, rel));
  }
  check('generated trees are byte-identical in the rcm mirror', mirrorOk);
}

/* =============== Part 2c: index filter (jsdom) =============== */
async function indexFilter() {
  console.log('== library index filter ==');
  const html = fs.readFileSync(path.join(SRC, 'denial-codes/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://claimpaid.io/denial-codes/', runScripts: 'dangerously', pretendToBeVisual: true });
  await new Promise((r) => { dom.window.addEventListener('load', r); setTimeout(r, 1500); });
  const d = dom.window.document;
  const visibleCards = () => [...d.querySelectorAll('.code-card')].filter((c) => c.style.display !== 'none');
  check('index shows all 31 cards initially', visibleCards().length === 31, visibleCards().length);
  const search = d.getElementById('libSearch');
  search.value = 'co-29';
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const afterSearch = visibleCards();
  check('search "co-29" leaves exactly the CO-29 card', afterSearch.length === 1 && afterSearch[0].getAttribute('data-code') === 'co-29', afterSearch.map((c) => c.getAttribute('data-code')));
  search.value = '';
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const chip = d.querySelector('[data-filter="timely-filing"]');
  chip.click();
  const afterChip = visibleCards();
  check('category chip "timely-filing" leaves only CO-29', afterChip.length === 1 && afterChip[0].getAttribute('data-code') === 'co-29', afterChip.map((c) => c.getAttribute('data-code')));
  dom.window.close();
}

/* =============== Part 1: audit tool (jsdom) =============== */
// Fixed "today" for deterministic bucket math: 2026-10-29.
function loadAuditPage() {
  let html = fs.readFileSync(path.join(SRC, 'audit/index.html'), 'utf8');
  const auditJs = fs.readFileSync(path.join(SRC, 'audit/audit.js'), 'utf8');
  html = html.replace('<script src="/audit/audit.js" defer></script>', () => '<script>\n' + auditJs + '\n</script>');
  html = html.replace('<script src="/consent.js" defer></script>', '');
  const dom = new JSDOM(html, { url: 'https://claimpaid.io/audit/', runScripts: 'dangerously', pretendToBeVisual: true });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  return dom;
}

async function auditTool() {
  console.log('== audit tool (logic) ==');
  const A = require(path.join(SRC, 'audit/audit.js'));
  const TODAY = '2026-10-29';
  const rows = [
    { ref: 'EXP-1', payer: 'UnitedHealthcare', dos: '2026-06-15', amount: 500 },   // deadline 2026-09-13 -> expired
    { ref: 'SOON-1', payer: 'Aetna', dos: '2026-07-11', amount: 250 },            // deadline 2026-11-08 -> 10 days left (<=14)
    { ref: 'SAFE-1', payer: 'Medicare', dos: '2026-10-01', amount: 1000 }         // deadline 2027-10-01 -> safe
  ];
  const rep = A.computeAudit(rows, TODAY);
  check('expired claim lands in expired bucket', rep.buckets.expired.count === 1 && rep.buckets.expired.dollars === 500, rep.buckets);
  check('10-days-left claim lands in <=14 bucket', rep.buckets.d14.count === 1 && rep.buckets.d14.dollars === 250, rep.buckets);
  check('safe claim lands in safe bucket', rep.buckets.safe.count === 1 && rep.buckets.safe.dollars === 1000, rep.buckets);
  check('at-risk dollars = expired + <=60 (750)', rep.totals.atRiskDollars === 750, rep.totals);
  check('nearest deadline is the expired claim (negative days)', rep.totals.nearestDeadlineDays < 0, rep.totals.nearestDeadlineDays);
  check('claims sorted by urgency (expired first)', rep.claims[0].ref === 'EXP-1' && rep.claims[2].ref === 'SAFE-1');

  console.log('== audit tool (CSV) ==');
  const csv = 'Claim Ref,Payer,Date of Service,Billed Amount\n' +
    'EXP-1,UnitedHealthcare,2026-06-15,500\n' +
    'SOON-1,Aetna,2026-07-11,250\n' +
    'SAFE-1,Medicare,2026-10-01,"$1,000.00"\n';
  const parsed = A.rowsFromCSV(csv);
  check('CSV parses without error', !parsed.error, parsed.error);
  const repCsv = A.computeAudit(parsed.rows, TODAY);
  check('CSV results match manual results', JSON.stringify(repCsv.buckets) === JSON.stringify(rep.buckets) && repCsv.totals.atRiskDollars === 750, repCsv.totals);
  const noHeader = A.rowsFromCSV('UnitedHealthcare,2026-06-15,500\n');
  check('headerless CSV is rejected with guidance', !!noHeader.error);

  console.log('== audit tool (page) ==');
  const pageHtml = fs.readFileSync(path.join(SRC, 'audit/index.html'), 'utf8');
  check('page states the file never leaves the browser', pageHtml.includes('Your file never leaves your browser'));
  check('page carries the contract-controls disclaimer', pageHtml.includes('Your contract with each payer controls'));
  check('page: consent assets present', pageHtml.includes('<link rel="stylesheet" href="/consent.css"/>') && pageHtml.includes('<script src="/consent.js" defer></script>'));
  check('page: no raw beacon', !pageHtml.includes('static.cloudflareinsights.com'));
  check('page: print affordance present', pageHtml.includes('@media print') && pageHtml.includes('id="printBtn"'));
  check('rules in audit.js match payer-deadlines.json', deadlinesData.payers.every((p) => {
    const js = fs.readFileSync(path.join(SRC, 'audit/audit.js'), 'utf8');
    return js.includes(`{ name: '${p.name}', days: ${p.days} }`);
  }));

  const dom = loadAuditPage();
  await new Promise((r) => { dom.window.addEventListener('load', r); setTimeout(r, 1500); });
  const d = dom.window.document;
  check('manual table renders 10 rows', d.querySelectorAll('#manualBody tr').length === 10, d.querySelectorAll('#manualBody tr').length);

  // Lead-form payload: capture fetch, then verify aggregates-only.
  let posted = null;
  dom.window.fetch = (url, opts) => { posted = { url, body: JSON.parse(opts.body) }; return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }); };
  const CP = dom.window.CPAudit;
  check('CPAudit exposed on the page', !!CP);
  // Drive the render through the page's own manual flow with fixed data is
  // not possible (page uses real today) — instead exercise the form after
  // invoking the internal run via a CSV paste with far-past/future dates
  // relative to any plausible run date:
  const paste = d.getElementById('csvPaste');
  paste.value = 'Claim Ref,Payer,Date of Service,Billed Amount\nOLD-1,UnitedHealthcare,2020-01-01,500\nNEW-1,Medicare,2099-01-01,1000\n';
  paste.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await sleep(50);
  check('report becomes visible after CSV paste', d.getElementById('report').style.display !== 'none');
  check('report shows expired dollars ($500)', d.getElementById('rExpired').textContent === '$500', d.getElementById('rExpired').textContent);
  d.getElementById('leadName').value = 'Test Person';
  d.getElementById('leadEmail').value = 'test@example.com';
  d.getElementById('leadCompany').value = 'Test Billing Co';
  d.getElementById('leadForm').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(50);
  check('lead form POSTs to /api/leads/audit', !!posted && posted.url === '/api/leads/audit', posted && posted.url);
  if (posted) {
    const keys = Object.keys(posted.body).sort();
    check('lead payload keys are aggregates/identity only',
      JSON.stringify(keys) === JSON.stringify(['claims_count', 'company', 'dollars_at_risk', 'email', 'expired_count', 'expired_dollars', 'name', 'nearest_deadline_days', 'website']), keys);
    const serialized = JSON.stringify(posted.body);
    check('lead payload contains no claim refs / DOS / per-claim rows',
      !serialized.includes('OLD-1') && !serialized.includes('NEW-1') && !serialized.includes('2020-01-01') && !serialized.includes('2099-01-01'));
    check('lead payload aggregates are correct (2 claims, $500 at risk, 1 expired)',
      posted.body.claims_count === 2 && posted.body.dollars_at_risk === 500 && posted.body.expired_count === 1 && posted.body.expired_dollars === 500, posted.body);
  }
  dom.window.close();
}

/* =============== Part 1b: lead endpoint (server) =============== */
async function leadEndpoint() {
  console.log('== lead endpoint (server) ==');
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit103-'));
  const DB = path.join(TMP, 't.db'); const PORT = 4199;
  const env = { ...process.env, PORT: String(PORT), DB_PATH: DB, NODE_ENV: 'test', SUPERADMIN_EMAIL: 'admin103@test.co' };
  const srv = spawn('node', ['src/index.js'], { cwd: path.join(__dirname, '..', 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; srv.stderr.on('data', (d) => { err += d; });
  const call = async (method, p, body) => {
    const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, body: j };
  };
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { const r = await fetch(`http://localhost:${PORT}/api/health`); up = r.ok; } catch {} await sleep(500); }
    check('server boots with the leads route', up, err.slice(-300));
    const good = await call('POST', '/api/leads/audit', {
      name: 'Lead One', email: 'lead1@example.com', company: 'Billing Co',
      claims_count: 12, dollars_at_risk: 3450, nearest_deadline_days: -3, expired_count: 2, expired_dollars: 900,
      claim_ref: 'SMUGGLED-1', dos: '2026-01-01', rows: [{ ref: 'X', amount: 99999 }]
    });
    check('valid aggregate lead accepted (201)', good.status === 201 && good.body.ok === true, good);
    const bad = await call('POST', '/api/leads/audit', { name: 'X', email: 'not-an-email', company: 'Y', claims_count: 1 });
    check('invalid email rejected (400)', bad.status === 400, bad);
    const honey = await call('POST', '/api/leads/audit', { name: 'Bot', email: 'bot@example.com', company: 'Spam', website: 'http://spam.example', claims_count: 1 });
    check('honeypot silently succeeds (200, no insert)', honey.status === 200 && honey.body.ok === true, honey);

    // Read back via sqlite to prove aggregates stored + smuggled fields absent.
    const rowsJson = execFileSync('node', ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(DB)});
      const rows = db.prepare('SELECT * FROM audit_leads').all();
      console.log(JSON.stringify(rows.map(r => ({...r, dollars_at_risk: r.dollars_at_risk}))));
    `], { encoding: 'utf8' });
    const rows = JSON.parse(rowsJson.trim().split('\n').pop());
    check('exactly one lead stored (honeypot not stored)', rows.length === 1, rows.length);
    if (rows.length === 1) {
      const r0 = rows[0];
      check('stored aggregates match the submission', r0.claims_count === 12 && r0.dollars_at_risk === 3450 && r0.nearest_deadline_days === -3 && r0.expired_count === 2 && r0.expired_dollars === 900 && r0.source === 'public_audit', r0);
      check('no claim-level data anywhere in the stored row', !JSON.stringify(r0).includes('SMUGGLED') && !('claim_ref' in r0) && !('rows' in r0));
    }
    // rate limit: 3/day per email — two more succeed, fourth is 429
    await call('POST', '/api/leads/audit', { name: 'L', email: 'lead1@example.com', company: 'C', claims_count: 1 });
    await call('POST', '/api/leads/audit', { name: 'L', email: 'lead1@example.com', company: 'C', claims_count: 1 });
    const fourth = await call('POST', '/api/leads/audit', { name: 'L', email: 'lead1@example.com', company: 'C', claims_count: 1 });
    check('rate limit: 4th lead in a day is 429', fourth.status === 429, fourth.status);
  } finally {
    srv.kill('SIGKILL');
  }
}

(async () => {
  generatorDeterminism();
  libraryChecks();
  await indexFilter();
  await auditTool();
  await leadEndpoint();
  if (failures) { console.log('\nDEPLOY 103 TEST: FAIL — ' + failures + ' check(s) failed'); process.exit(1); }
  console.log('\nDEPLOY 103 TEST: PASS');
})().catch((e) => { console.error('DEPLOY 103 TEST: ERROR — ' + e.stack); process.exit(1); });
