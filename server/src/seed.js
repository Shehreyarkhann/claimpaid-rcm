// Generates realistic demo revenue-cycle data for a demo organization.
// Run: npm run seed
const bcrypt = require('bcryptjs');
const { db, initSchema } = require('./db');

initSchema();

const PAYERS = [
  { name: 'Aetna', type: 'Commercial' },
  { name: 'Cigna', type: 'Commercial' },
  { name: 'UnitedHealthcare', type: 'Commercial' },
  { name: 'Anthem BCBS', type: 'Commercial' },
  { name: 'Medicare', type: 'Government' },
  { name: 'Medicaid NY', type: 'Government' },
  { name: 'Humana', type: 'Commercial' },
  { name: 'Self-Pay', type: 'Patient' },
];

const FIRST = ['James', 'Maria', 'Robert', 'Linda', 'Michael', 'Sarah', 'David', 'Jennifer', 'William', 'Elizabeth', 'Thomas', 'Patricia', 'Charles', 'Susan', 'Daniel', 'Karen', 'Matthew', 'Nancy', 'Anthony', 'Lisa', 'Mark', 'Betty', 'Steven', 'Margaret', 'Paul', 'Sandra', 'George', 'Ashley', 'Kenneth', 'Kimberly'];
const LAST = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson'];

const DENIAL_REASONS = [
  'Missing prior authorization',
  'Eligibility / coverage terminated',
  'Coding error — CPT mismatch',
  'Timely filing exceeded',
  'Duplicate claim',
  'Medical necessity documentation',
  'Incorrect patient demographics',
  'Coordination of benefits',
];

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[rand(0, arr.length - 1)];
const pad = (n, w) => String(n).padStart(w, '0');

function daysBetween(dateStr) {
  return Math.max(0, Math.floor((new Date() - new Date(dateStr)) / 86400000));
}

function seed() {
  db.exec('DELETE FROM appeal_notes; DELETE FROM appeals; DELETE FROM claims; DELETE FROM payers; DELETE FROM users; DELETE FROM orgs;');

  // Demo org + owner
  const orgId = Number(db.prepare('INSERT INTO orgs (name) VALUES (?)').run('Demo Billing Co.').lastInsertRowid);
  const hash = bcrypt.hashSync('demo1234', 10);
  const ownerId = Number(db.prepare(
    "INSERT INTO users (org_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, 'owner')"
  ).run(orgId, 'demo@pulsercm.com', hash, 'Demo Owner').lastInsertRowid);
  const billerId = Number(db.prepare(
    "INSERT INTO users (org_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, 'biller')"
  ).run(orgId, 'biller@pulsercm.com', hash, 'Alex Biller').lastInsertRowid);
  // Workspace memberships (required by authRequired — without these every
  // API call 401s with "User no longer exists" on fresh installs)
  const addMember = db.prepare('INSERT OR IGNORE INTO user_orgs (user_id, org_id, role) VALUES (?, ?, ?)');
  addMember.run(ownerId, orgId, 'owner');
  addMember.run(billerId, orgId, 'biller');

  const insertPayer = db.prepare('INSERT INTO payers (org_id, name, type) VALUES (?, ?, ?)');
  const payerIds = PAYERS.map((p) => Number(insertPayer.run(orgId, p.name, p.type).lastInsertRowid));

  // Realistic timely filing deadlines (days from date of service)
  const FILING_RULES = {
    'Aetna': 120,
    'Cigna': 180,
    'UnitedHealthcare': 90,
    'Anthem BCBS': 180,
    'Medicare': 365,
    'Medicaid NY': 90,
    'Humana': 180,
    'Self-Pay': 365,
  };
  const insertRule = db.prepare('INSERT INTO payer_filing_rules (org_id, payer_id, filing_days, notes) VALUES (?, ?, ?, ?)');
  PAYERS.forEach((p, i) => {
    insertRule.run(orgId, payerIds[i], FILING_RULES[p.name] || 365, `Industry-standard timely filing limit`);
  });

  const insertClaim = db.prepare(`
    INSERT INTO claims (org_id, claim_number, patient_name, payer_id, service_date, billed_amount, paid_amount, status, denial_reason, days_in_ar)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const TOTAL = 600;
  const deniedIds = [];
  for (let i = 1; i <= TOTAL; i++) {
    const serviceDate = new Date();
    serviceDate.setMonth(serviceDate.getMonth() - rand(0, 11));
    serviceDate.setDate(rand(1, 28));
    const svcDate = serviceDate.toISOString().slice(0, 10);
    const billed = Math.round((rand(150, 8500) + Math.random()) * 100) / 100;

    const roll = Math.random();
    let status, paid, denialReason = null;
    if (roll < 0.62) { status = 'paid'; paid = billed * (0.72 + Math.random() * 0.26); }
    else if (roll < 0.80) { status = 'pending'; paid = 0; }
    else if (roll < 0.92) { status = 'denied'; paid = 0; denialReason = pick(DENIAL_REASONS); }
    else { status = 'in_ar'; paid = billed * Math.random() * 0.3; }

    const id = Number(insertClaim.run(orgId, `CLM-${pad(100000 + i, 6)}`,
      `${pick(FIRST)} ${pick(LAST)}`, pick(payerIds), svcDate,
      billed, Math.round(paid * 100) / 100, status, denialReason, daysBetween(svcDate)
    ).lastInsertRowid);
    if (status === 'denied') deniedIds.push(id);
  }

  // Seed some appeals in various states
  const appealStatuses = ['open', 'open', 'in_progress', 'in_progress', 'submitted', 'submitted', 'won', 'lost'];
  const priorities = ['low', 'medium', 'medium', 'high', 'urgent'];
  const insertAppeal = db.prepare(`
    INSERT INTO appeals (org_id, claim_id, assigned_to, status, priority, follow_up_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertNote = db.prepare('INSERT INTO appeal_notes (appeal_id, user_id, note) VALUES (?, ?, ?)');
  const notes = [
    'Called payer — rep confirmed auth was on file but not linked to claim. Resubmitting with auth number.',
    'Received 835 remittance. Denial stands; drafting redetermination letter.',
    'Spoke with provider office — corrected CPT sent. Rebill in progress.',
    'Payer requested medical records. Faxed 12 pages, confirmation #88412.',
    'Second-level appeal submitted via portal. Confirmation received.',
  ];

  const sample = deniedIds.slice(0, 24);
  sample.forEach((claimId, i) => {
    const status = appealStatuses[i % appealStatuses.length];
    const fu = new Date();
    fu.setDate(fu.getDate() + rand(-5, 14));
    const aid = Number(insertAppeal.run(orgId, claimId,
      i % 3 === 0 ? null : (i % 2 === 0 ? ownerId : billerId),
      status, pick(priorities), fu.toISOString().slice(0, 10)
    ).lastInsertRowid);
    const nNotes = rand(1, 3);
    for (let n = 0; n < nNotes; n++) insertNote.run(aid, n % 2 === 0 ? ownerId : billerId, pick(notes));
  });

  console.log(`Seeded org "Demo Billing Co." (${TOTAL} claims, ${sample.length} appeals).`);
  console.log('Login: demo@pulsercm.com / demo1234');
}

seed();
