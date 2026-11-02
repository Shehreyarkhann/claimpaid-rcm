'use strict';
// Prior-auth 278 preparation (deploy #106, Phase F).
//
// Builds the health-services-review request for one auth record two
// ways from the same data: a structured JSON payload (what the UI shows
// and what is stored on the record as pa_payload) and a compact X12
// 005010X217 request in the same envelope style as the 837P generator,
// for the raw-X12 transmit path in edi/stedi.js.
//
// HONEST SCOPE: as of this build, Stedi's healthcare API catalog has NO
// dedicated 278 endpoint (eligibility, claims, claim status and ERA
// only; 278 exists as EDI guides). The transmit function in stedi.js
// therefore behaves exactly like the rest of the vendor surface: TEST
// mode prepares and records locally and is labeled TEST MODE, and a
// production transmit runs only when the trading-partner 278 route is
// provisioned (STEDI_278_PATH). Nothing here pretends a payer received
// a request it did not.

function fmtDate(d) {
  if (!d) return '';
  return String(d).replace(/-/g, '');
}
function esc(s) {
  return String(s || '').replace(/[*~:]/g, '').slice(0, 60).trim();
}
function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  if (parts.length <= 1) return { first: '', last: parts[0] || '' };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}
function firstCpt(cptCodes) {
  const first = String(cptCodes || '').split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean)[0];
  return first ? first.split(':')[0] : null;
}
function cptList(cptCodes) {
  return String(cptCodes || '').split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean)
    .map((c) => c.split(':')[0]);
}

function build278Payload(auth, org, payer) {
  return {
    transaction: '278',
    version: '005010X217',
    kind: 'health_services_review_request',
    requester: {
      organization: org?.name || null,
      billing_npi: org?.billing_npi || null,
      contact_phone: org?.billing_phone || null,
    },
    payer: {
      name: payer?.name || null,
      payer_id: auth.payer_id || null,
    },
    subscriber: {
      patient_name: auth.patient_name,
      member_id: null, // auth records do not carry member ids; linked claim fills it when present
    },
    review: {
      certification_type: 'initial',
      request_category: 'health_services_review',
      service_date: auth.service_date || null,
      needed_by_date: auth.needed_by_date || null,
      units_requested: auth.units_requested || 1,
      diagnoses: String(auth.icd_codes || '').split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean),
      services: cptList(auth.cpt_codes).map((cpt) => ({ cpt, units: auth.units_requested || 1 })),
      provider: auth.provider || null,
      notes: auth.notes || null,
    },
    prepared_from_auth_id: auth.id,
  };
}

function build278X12(auth, org, payer, memberId) {
  const now = new Date();
  const yymmdd = now.toISOString().slice(2, 10).replace(/-/g, '');
  const yyyymmdd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const hhmm = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
  const isaNum = String(Math.floor(Math.random() * 900000000) + 100000000);
  const trace = `PA${auth.id}-${yyyymmdd}`;
  const pat = splitName(auth.patient_name);
  const S = [];
  const E = '*';
  const T = '~';

  S.push(['ISA', '00', '          ', '00', '          ', 'ZZ', (org?.billing_npi || 'PULSE').padEnd(15),
    'ZZ', 'CLEARINGHOUSE'.padEnd(15), yymmdd, hhmm, '^', '00501', isaNum, '0', 'P', '>'].join(E));
  S.push(['GS', 'HI', org?.billing_npi || 'PULSE', 'CLEARINGHOUSE', yyyymmdd, hhmm, '1', 'X', '005010X217'].join(E));
  S.push(['ST', '278', '0001', '005010X217'].join(E));
  // BHT*0007 = health services review; 13 = request.
  S.push(['BHT', '0007', '13', trace, yyyymmdd, hhmm].join(E));

  // 2000A — utilization review organization (payer)
  S.push(['HL', '1', '', '20', '1'].join(E));
  S.push(['NM1', 'X3', '2', esc(payer?.name || 'PAYER').toUpperCase(), '', '', '', '', '', '46', 'RECEIVER'].join(E));
  // 2000B — requester (the practice)
  S.push(['HL', '2', '1', '21', '1'].join(E));
  S.push(['NM1', '1P', '2', esc(org?.name || 'PROVIDER').toUpperCase(), '', '', '', '', '', 'XX', org?.billing_npi || '0000000000'].join(E));
  if (org?.billing_phone) S.push(['PER', 'IC', 'BILLING DEPT', 'TE', String(org.billing_phone).replace(/\D/g, '')].join(E));
  // 2000C — subscriber/patient
  S.push(['HL', '3', '2', '22', '0'].join(E));
  S.push(['NM1', 'IL', '1', esc(pat.last).toUpperCase(), esc(pat.first).toUpperCase(), '', '', '', 'MI', esc(memberId || '')].join(E));
  // 2000E — patient event
  S.push(['HL', '4', '3', 'EV', '1'].join(E));
  S.push(['TRN', '1', trace, ''].join(E));
  // UM — health services review: HS (health services), I (initial),
  // units requested in the quantity element.
  S.push(['UM', 'HS', 'I', '', '', '', '', '', '', String(auth.units_requested || 1)].join(E));
  if (auth.service_date) S.push(['DTP', '472', 'D8', fmtDate(auth.service_date)].join(E));
  const icds = String(auth.icd_codes || '').split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean);
  if (icds.length) {
    const hi = ['HI'];
    icds.slice(0, 12).forEach((code, i) => hi.push(`${i === 0 ? 'ABK' : 'ABF'}:${code.replace('.', '')}`));
    S.push(hi.join(E));
  }
  // 2000F — service level(s)
  let hl = 4;
  for (const cpt of cptList(auth.cpt_codes)) {
    hl++;
    S.push(['HL', String(hl), '4', 'SS', '0'].join(E));
    S.push(['UM', 'HS', 'I'].join(E));
    S.push(['SV1', `HC:${cpt}`, '', 'UN', String(auth.units_requested || 1)].join(E));
    if (auth.service_date) S.push(['DTP', '472', 'D8', fmtDate(auth.service_date)].join(E));
  }

  const stCount = S.length - 3 + 1;
  S.push(['SE', String(stCount + 1), '0001'].join(E));
  S.push(['GE', '1', '1'].join(E));
  S.push(['IEA', '1', isaNum].join(E));
  return S.map((s) => s + T).join('\n');
}

function buildForAuth(db, orgId, auth) {
  const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(orgId) || {};
  const payer = auth.payer_id
    ? db.prepare('SELECT * FROM payers WHERE id = ?').get(auth.payer_id)
    : null;
  let memberId = null;
  if (auth.linked_claim_id) {
    const claim = db.prepare('SELECT member_id FROM claims WHERE id = ? AND org_id = ?')
      .get(auth.linked_claim_id, orgId);
    if (claim) memberId = claim.member_id || null;
  }
  const payload = build278Payload(auth, org, payer);
  if (memberId) payload.subscriber.member_id = memberId;
  const x12 = build278X12(auth, org, payer, memberId);
  return { payload, x12 };
}

module.exports = { build278Payload, build278X12, buildForAuth, firstCpt, cptList };
