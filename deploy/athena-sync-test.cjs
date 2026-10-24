// athena-sync-test.cjs — deploy #45: sync scan behavior with a stubbed fetch.
// Verifies against athenaOne's real response shapes:
//  - wrapped list responses ({departments:[...]}, {appointments:[...]})
//  - 'x' appointment status = checked out
//  - MM/DD/YYYY appointment dates -> ISO date_of_service
//  - empty recent window -> automatic deep scan finds historical visits
'use strict';
const athena = require('../server/src/ehr/athenahealth');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}

check("statusOf 'x' -> checked_out", athena.statusOf({ appointmentstatus: 'x' }) === 'checked_out');
check("statusOf 'Checked Out' -> checked_out", athena.statusOf({ appointmentstatus: 'Checked Out' }) === 'checked_out');
check("statusOf 'Cancelled' -> cancelled", athena.statusOf({ appointmentstatus: 'Cancelled' }) === 'cancelled');
check("statusOf '2' (checked in code) or unknown -> scheduled", athena.statusOf({ appointmentstatus: '2' }) === 'scheduled');

const APPT = {
  appointmentid: 5, encounterid: 9, patientid: 7,
  appointmentstatus: 'x', date: '03/15/2019', appointmenttype: 'Office Visit',
};
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (u.includes('/oauth2/')) return json({ access_token: 'tok', expires_in: 3600 });
  if (u.includes('/departments')) return json({ totalcount: 1, departments: [{ departmentid: 1 }] });
  if (u.includes('/appointments/booked')) {
    const m = /startdate=(\d{2})%2F(\d{2})%2F(\d{4})/.exec(u) || /startdate=(\d{2})\/(\d{2})\/(\d{4})/.exec(u);
    const startYear = m ? Number(m[3]) : new Date().getFullYear();
    const deep = startYear < new Date().getFullYear() - 1;
    return json(deep ? { totalcount: 1, appointments: [APPT] } : { totalcount: 0, appointments: [] });
  }
  if (u.includes('/patients/7/insurances')) return json({ insurances: [{ insurancetype: 'Primary', insuranceplanname: 'Aetna', sequencenumber: 1 }] });
  if (u.includes('/patients/7')) return json([{ firstname: 'Test', lastname: 'Patient', dob: '01/01/1980' }]);
  if (u.includes('/chart/encounter/9/diagnoses')) return json({ diagnoses: [{ icd10code: 'M54.50' }] });
  return { ok: false, status: 404, text: async () => 'not found' };
};

(async () => {
  const orgRow = {
    ehr_athena_client_id: 'cid', ehr_athena_client_secret: 'sec',
    ehr_athena_env: 'preview', ehr_athena_practice_id: '195900',
  };
  const conn = { access_token: null, refresh_token: null, token_expires_at: null, practice_id: '195900' };
  const r = await athena.syncEncounters(conn, orgRow, null);
  global.fetch = realFetch;
  check('deep scan found the historical visit', r.encounters.length === 1, `got ${r.encounters.length}`);
  const e = r.encounters[0] || {};
  check('status carried as checked_out', e.status === 'checked_out', e.status);
  check('date_of_service is ISO', e.date_of_service === '2019-03-15', e.date_of_service);
  check('payer resolved from wrapped insurances', e.payer_name === 'Aetna', e.payer_name);
  check('icd normalized (dot stripped)', JSON.stringify(e.icd_codes) === '["M5450"]', JSON.stringify(e.icd_codes));
  check('stats report deep window', !!r.stats && /^deep/.test(r.stats.window), JSON.stringify(r.stats));
  check('stats count appointments + departments', r.stats.appointments === 1 && r.stats.departments === 1, JSON.stringify(r.stats));
  check('no errors', (r.errors || []).length === 0, JSON.stringify(r.errors));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { global.fetch = realFetch; console.error(e); process.exit(1); });
