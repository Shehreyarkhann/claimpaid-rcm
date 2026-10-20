// Seed demo prior-authorization data for the demo org
const { db, initSchema } = require('./db');
initSchema();

const DEMO_EMAIL = 'demo@pulsercm.com';

const first = ['James', 'Maria', 'Robert', 'Linda', 'Michael', 'Sarah', 'David', 'Jennifer', 'William', 'Patricia', 'Thomas', 'Nancy', 'Daniel', 'Karen', 'Kevin', 'Lisa', 'Brian', 'Amy', 'Steven', 'Michelle', 'Jason', 'Kimberly', 'Jeffrey', 'Donna', 'Ryan', 'Carol', 'Jacob', 'Ruth', 'Gary', 'Sharon'];
const last = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin'];

const procedures = [
  ['97110,97140', 'M54.5', 'Physical therapy — lumbar', 12],
  ['70553', 'G43.109', 'MRI brain w/ contrast', 1],
  ['72148', 'M51.26', 'MRI lumbar spine', 1],
  ['27447', 'M17.11', 'Knee arthroplasty', 1],
  ['93306', 'I48.91', 'Echocardiogram', 1],
  ['90837', 'F33.1', 'Psychotherapy 60min', 20],
  ['97161,97110', 'M25.561', 'PT — knee rehab', 18],
  ['74177', 'K21.9', 'CT abdomen/pelvis', 1],
  ['64483', 'M54.16', 'Epidural steroid injection', 3],
  ['58571', 'N80.1', 'Laparoscopic hysterectomy', 1],
  ['29881', 'M23.203', 'Knee arthroscopy', 1],
  ['93000', 'R07.9', 'Cardiac stress test', 1],
];

const providers = ['Dr. Alan Weiss — Orthopedics', 'Dr. Priya Nair — Neurology', 'Dr. Samuel Okafor — Cardiology', 'Hudson PT Associates', 'Dr. Elena Vasquez — Pain Mgmt', 'Clearview Imaging Center'];

function rand(a) { return a[Math.floor(Math.random() * a.length)]; }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
function daysFromNow(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

const user = db.prepare('SELECT id, org_id FROM users WHERE email = ?').get(DEMO_EMAIL);
if (!user) { console.error('Demo user not found'); process.exit(1); }
const { id: uid, org_id: orgId } = user;

const payers = db.prepare('SELECT id, name FROM payers WHERE org_id = ?').all(orgId);
const payerByName = Object.fromEntries(payers.map((p) => [p.name, p.id]));

// Clear existing demo auths
db.prepare('DELETE FROM auth_notes WHERE org_id = ?').run(orgId);
db.prepare('DELETE FROM auth_requests WHERE org_id = ?').run(orgId);

const statuses = [
  ...Array(8).fill('draft'),
  ...Array(10).fill('submitted'),
  ...Array(5).fill('pending_info'),
  ...Array(14).fill('approved'),
  ...Array(5).fill('denied'),
  ...Array(2).fill('expired'),
  ...Array(2).fill('cancelled'),
];

const insertAuth = db.prepare(`
  INSERT INTO auth_requests
    (org_id, patient_name, payer_id, provider, cpt_codes, icd_codes, units_requested,
     service_date, requested_date, needed_by_date, status, auth_number, approved_units,
     valid_from, valid_to, denial_reason, notes, assigned_to, created_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertNote = db.prepare(`INSERT INTO auth_notes (org_id, auth_id, user_id, note) VALUES (?, ?, ?, ?)`);

const usedNames = new Set();
let n = 0;

for (const status of statuses) {
  let name = `${rand(first)} ${rand(last)}`;
  while (usedNames.has(name)) name = `${rand(first)} ${rand(last)}`;
  usedNames.add(name);

  const payer = rand(payers);
  const [cpt, icd, procName, units] = rand(procedures);
  const requestedDaysAgo = Math.floor(Math.random() * 30);
  const requested = daysAgo(requestedDaysAgo);

  let authNumber = null, validFrom = null, validTo = null, approvedUnits = null, denialReason = null;

  if (status === 'approved') {
    authNumber = 'AUTH' + String(100000 + Math.floor(Math.random() * 899999));
    validFrom = daysAgo(Math.max(0, requestedDaysAgo - 3));
    // Some expiring soon, some far out, a couple already expired (to demo the badge)
    const r = Math.random();
    validTo = r < 0.25 ? daysFromNow(Math.floor(Math.random() * 10) + 1)
      : r < 0.4 ? daysAgo(Math.floor(Math.random() * 12) + 1)
      : daysFromNow(30 + Math.floor(Math.random() * 60));
    approvedUnits = Math.random() < 0.8 ? units : Math.max(1, Math.floor(units * 0.5));
  }
  if (status === 'denied') {
    denialReason = rand([
      'Not medically necessary per clinical review',
      'Experimental/investigational — plan exclusion',
      'Insufficient clinical documentation submitted',
      'Service available at in-network facility at lower level of care',
      'Duplicate request — prior auth already on file',
    ]);
  }
  if (status === 'expired') {
    authNumber = 'AUTH' + String(100000 + Math.floor(Math.random() * 899999));
    validFrom = daysAgo(90);
    validTo = daysAgo(Math.floor(Math.random() * 20) + 1);
  }

  const id = Number(insertAuth.run(
    orgId, name, payer.id, rand(providers), cpt, icd, units,
    status === 'draft' ? daysFromNow(7 + Math.floor(Math.random() * 21)) : null,
    status === 'draft' ? null : requested,
    daysFromNow(Math.floor(Math.random() * 14) + 1),
    status, authNumber, approvedUnits, validFrom, validTo, denialReason,
    Math.random() < 0.4 ? rand([
      'Peer-to-peer scheduled with medical director.',
      'Additional clinical notes faxed to payer.',
      'Patient notified of pending status.',
      'Expedited review requested — urgent clinical need.',
    ]) : null,
    Math.random() < 0.7 ? uid : null, uid,
  ).lastInsertRowid);
  n++;

  // Notes on some
  if (Math.random() < 0.5) {
    insertNote.run(orgId, id, uid, rand([
      'Called payer — spoke with rep, reference #REF' + Math.floor(Math.random() * 90000 + 10000) + '.',
      'Clinical documentation uploaded to portal.',
      'Following up — no response after 5 business days.',
      'Approved verbally, waiting on written confirmation.',
      'Denial received — preparing peer-to-peer request.',
    ]));
  }
}

// Fix timestamps so turnaround stats look real (spread requested/updated over time)
db.exec(`UPDATE auth_requests SET created_at = requested_date || 'T09:00:00', updated_at =
  CASE WHEN status IN ('approved','denied') THEN date(requested_date, '+' || (1 + abs(random()) % 9) || ' days') || 'T14:00:00'
       ELSE datetime('now') END
  WHERE org_id = ${orgId} AND requested_date IS NOT NULL`);

console.log(`Seeded ${n} auth requests for demo org`);
