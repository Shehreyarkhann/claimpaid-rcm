// Pluggable EHR provider layer (mirrors the eligibility vendor pattern).
//
// Honest architecture: pulling live encounters needs a real EHR connection —
// for athenahealth, a Developer Console app + (for production) a practice
// that authorizes it. Epic needs certification (~$10k+, 6-12 months) and is
// deliberately out of scope. Until an org connects a real EHR, everything
// runs through the `demo` provider, whose encounters are clearly labeled
// synthetic. Demo data is NEVER presented as real — encounters carry
// provider='demo' and the UI shows a "DEMO — synthetic encounters" banner.
//
// Provider interface:
//   syncEncounters(connection, orgRow, since) -> { encounters, errors, tokenUpdate?, practiceId?, env? }
// A normalized encounter:
//   { ehr_encounter_id, ehr_patient_id, patient_first, patient_last,
//     patient_dob (YYYY-MM-DD), payer_name, date_of_service (YYYY-MM-DD),
//     cpt_codes[], icd_codes[], rendering_provider, raw_payload }

const crypto = require('crypto');

const PROVIDERS = ['demo', 'athenahealth'];

// ---- demo provider ----------------------------------------------------------
// Deterministic synthetic encounters: same org + date -> same encounters, so
// repeated syncs dedupe cleanly. Clearly labeled synthetic everywhere.

const DEMO_FIRST = ['James', 'Maria', 'Robert', 'Linda', 'Michael', 'Sarah', 'David', 'Jennifer', 'William', 'Patricia', 'Charles', 'Aisha'];
const DEMO_LAST = ['Smith', 'Garcia', 'Johnson', 'Brown', 'Davis', 'Miller', 'Wilson', 'Moore', 'Taylor', 'Anderson', 'Khan', 'Patel'];
const DEMO_PAYERS = ['Aetna', 'Cigna', 'UnitedHealthcare', 'Anthem', 'Medicare', 'Humana'];
const DEMO_VISITS = [
  { cpts: ['99213'], icds: ['M545', 'I10'], provider: 'Dr. Emily Chen' },
  { cpts: ['99214'], icds: ['E119', 'I10'], provider: 'Dr. Michael Ross' },
  { cpts: ['97110', '97140'], icds: ['M545'], provider: 'Dr. Sarah Patel' },
  { cpts: ['93000'], icds: ['R074', 'I10'], provider: 'Dr. David Kim' },
  { cpts: ['99213', '93000'], icds: ['J069'], provider: 'Dr. Emily Chen' },
  { cpts: ['97161'], icds: ['M545', 'M2551'], provider: 'Dr. Sarah Patel' },
  { cpts: ['99214'], icds: ['F329', 'G439'], provider: 'Dr. Michael Ross' },
];

function hashUnit(str) {
  const h = crypto.createHash('sha256').update(str).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

function demoSyncEncounters(connection, orgRow, since) {
  const orgId = connection.org_id;
  const days = [];
  const start = since ? new Date(since + 'T12:00:00') : new Date(Date.now() - 3 * 86400000);
  for (let i = 0; i < 3; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    if (d.getTime() > Date.now()) break;
    days.push(d.toISOString().slice(0, 10));
  }
  const encounters = [];
  for (const day of days) {
    const n = 2 + Math.floor(hashUnit(`n|${orgId}|${day}`) * 3); // 2-4 per day
    for (let i = 0; i < n; i++) {
      const u = (salt) => hashUnit(`${salt}|${orgId}|${day}|${i}`);
      const visit = DEMO_VISITS[Math.floor(u('v') * DEMO_VISITS.length)];
      const first = DEMO_FIRST[Math.floor(u('f') * DEMO_FIRST.length)];
      const last = DEMO_LAST[Math.floor(u('l') * DEMO_LAST.length)];
      const year = 1955 + Math.floor(u('y') * 45);
      const dob = `${year}-${String(1 + Math.floor(u('m') * 12)).padStart(2, '0')}-${String(1 + Math.floor(u('d') * 28)).padStart(2, '0')}`;
      encounters.push({
        ehr_encounter_id: `demo-enc-${crypto.createHash('sha256').update(`${orgId}|${day}|${i}`).digest('hex').slice(0, 12)}`,
        ehr_patient_id: `demo-pt-${Math.floor(u('p') * 90000 + 10000)}`,
        patient_first: first,
        patient_last: last,
        patient_dob: dob,
        payer_name: DEMO_PAYERS[Math.floor(u('pay') * DEMO_PAYERS.length)],
        date_of_service: day,
        cpt_codes: visit.cpts,
        icd_codes: visit.icds,
        rendering_provider: visit.provider,
        raw_payload: { demo: true, note: 'SYNTHETIC encounter for workflow testing.' },
      });
    }
  }
  return { encounters, errors: [] };
}

// ---- dispatch ---------------------------------------------------------------

async function syncEncounters(connection, orgRow, since) {
  if (connection.provider === 'athenahealth') {
    const athena = require('./athenahealth');
    return athena.syncEncounters(connection, orgRow, since);
  }
  if (connection.provider === 'demo') {
    return demoSyncEncounters(connection, orgRow, since);
  }
  throw new Error(`Unknown EHR provider: ${connection.provider}`);
}

module.exports = { PROVIDERS, syncEncounters, demoSyncEncounters };
