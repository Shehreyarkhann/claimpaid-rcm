// Pluggable EHR provider layer (mirrors the eligibility vendor pattern).
//
// Honest architecture: pulling live encounters needs a real EHR connection —
// for athenahealth, a Developer Console app + (for production) a practice
// that authorizes it. Epic needs certification (~$10k+, 6-12 months) and is
// deliberately out of scope. Until an org connects a real EHR, everything
// athenahealth is the only provider. (A synthetic demo provider existed
// pre-launch and was removed in deploy #52.)
//
// Provider interface:
//   syncEncounters(connection, orgRow, since) -> { encounters, errors, tokenUpdate?, practiceId?, env? }
// A normalized encounter:
//   { ehr_encounter_id, ehr_patient_id, patient_first, patient_last,
//     patient_dob (YYYY-MM-DD), payer_name, date_of_service (YYYY-MM-DD),
//     cpt_codes[], icd_codes[], rendering_provider, raw_payload }

const crypto = require('crypto');

const PROVIDERS = ['athenahealth'];

async function syncEncounters(connection, orgRow, since) {
  if (connection.provider === 'athenahealth') {
    const athena = require('./athenahealth');
    return athena.syncEncounters(connection, orgRow, since);
  }
  throw new Error(`Unknown EHR provider: ${connection.provider}`);
}

module.exports = { PROVIDERS, syncEncounters };
