// 837P (Healthcare Claim: Professional) 005010X222A1 generator + structural validator.
//
// This is the transmission-grade generator used by the claim-batch workflow.
// The legacy download-only generator (server/src/edi837.js, used by the claims
// export-837 endpoint) is untouched; this module adds what transmission needs:
//   - Date-based + DB-sequenced interchange control numbers (no random duplicates)
//   - CLM01 = the app's claim id, so 277CA acks map back via TRN02
//   - Full 2000B subscriber loop (2010BA subscriber w/ member ID + DOB,
//     2010BB payer) — required by 005010X222, missing from the legacy generator
//   - Structural validation (SE counts, control-number matching, required segments)
//   - Per-claim data validation before generation (member ID, DOB, CPT/ICD)
//
// What it does NOT do: semantic payer edits. Clearinghouse-specific companion
// guide rules still apply; the validation here is structural (X12 syntax), not
// payer adjudication.

const { db } = require('../db');

const E = '*';
const T = '~';

// ---- small helpers --------------------------------------------------------

function fmtDate(d) {
  return String(d || '').replace(/-/g, ''); // YYYYMMDD
}

function fmtMoney(n) {
  return (Math.round(Number(n || 0) * 100) / 100).toFixed(2);
}

// Strip X12 reserved chars; uppercase per convention.
function esc(s, max = 60) {
  return String(s || '').replace(/[*~:>]/g, '').slice(0, max).trim().toUpperCase();
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: 'UNKNOWN' };
  if (parts.length === 1) return { first: '', last: parts[0] };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

function validYmd(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return false;
  const t = new Date(d + 'T12:00:00');
  return !Number.isNaN(t.getTime());
}

// Split a dollar total across n lines so the cents sum exactly.
function splitAmounts(total, n) {
  const cents = Math.round(Number(total || 0) * 100);
  const base = Math.floor(cents / n);
  const out = new Array(n).fill(base);
  let remainder = cents - base * n;
  for (let i = 0; i < remainder; i++) out[i] += 1;
  return out.map((c) => (c / 100).toFixed(2));
}

// ---- control numbers -------------------------------------------------------
// ISA13/GS06: YYMMDD + 3-digit daily sequence (9 chars). One interchange per
// batch, one ST per interchange, so ST02 is always 0001. Sequence is persisted
// in edi_control_numbers — no random numbers, no duplicates within a day.
// node:sqlite has no db.transaction() — explicit BEGIN/COMMIT.

function nextControlNumbers() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  db.exec('BEGIN');
  try {
    const row = db.prepare('SELECT last_seq FROM edi_control_numbers WHERE date = ?').get(today);
    const seq = (row ? row.last_seq : 0) + 1;
    db.prepare(
      `INSERT INTO edi_control_numbers (date, last_seq) VALUES (?, ?)
       ON CONFLICT(date) DO UPDATE SET last_seq = ?`
    ).run(today, seq, seq);
    db.exec('COMMIT');
    const yymmdd = today.slice(2).replace(/-/g, '');
    const isa = yymmdd + String(seq).padStart(3, '0');
    return { isa, gs: isa, st: '0001' };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

// ---- per-claim data validation ---------------------------------------------

function validateClaimData(c) {
  const issues = [];
  if (!c.patient_name || !c.patient_name.trim()) issues.push('missing patient name');
  if (!validYmd(c.patient_dob)) issues.push('missing/invalid patient DOB (needed for 2010BA DMG)');
  if (!c.member_id || String(c.member_id).trim().length < 2) issues.push('missing member ID (needed for 2010BA NM109)');
  if (!c.payer_name) issues.push('missing payer');
  if (!validYmd(c.service_date)) issues.push('missing/invalid service date');
  if (!(Number(c.billed_amount) > 0)) issues.push('billed amount must be > 0');
  const cpts = String(c.cpt_codes || '').split(/[,\s;]+/).map((x) => x.trim()).filter(Boolean);
  if (!cpts.length) issues.push('missing CPT codes (2400 SV1 required)');
  const icds = String(c.icd_codes || '').split(/[,\s;]+/).map((x) => x.trim()).filter(Boolean);
  if (!icds.length) issues.push('missing ICD codes (2300 HI required)');
  return { issues, cpts, icds };
}

// ---- generator --------------------------------------------------------------

function generate837P(claims, org, opts = {}) {
  // claims: rows with id, patient_name, patient_dob, member_id, payer_id,
  //   payer_name, service_date, billed_amount, cpt_codes, icd_codes,
  //   rendering_npi, rendering_provider
  // org: billing_npi, name, billing_address/city/state/zip, billing_tax_id,
  //   billing_phone, edi_submitter_id, edi_receiver_id
  const now = new Date();
  const yyyymmdd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const hhmm = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
  const yymmdd = now.toISOString().slice(2, 10).replace(/-/g, '');

  const ctl = nextControlNumbers();
  const batchRef = opts.batchReference || `B${yyyymmdd}${String(Math.floor(Math.random() * 900) + 100)}`;
  const submitterId = (org.edi_submitter_id || org.billing_npi || 'SUBMITTER').toString().padEnd(15).slice(0, 15);
  const receiverId = (org.edi_receiver_id || 'RECEIVER').toString().padEnd(15).slice(0, 15);
  const billingNpi = (org.billing_npi || '').replace(/\D/g, '');

  const S = [];
  const seg = (arr) => S.push(arr.join(E));

  // ISA — interchange header
  seg(['ISA', '00', '          ', '00', '          ', 'ZZ', submitterId,
    'ZZ', receiverId, yymmdd, hhmm, '^', '00501', ctl.isa, '0', 'P', '>']);
  // GS — functional group
  seg(['GS', 'HC', org.edi_submitter_id || org.billing_npi || 'SUBMITTER',
    org.edi_receiver_id || 'RECEIVER', yyyymmdd, hhmm, ctl.gs, 'X', '005010X222A1']);
  // ST + BHT — transaction set header
  seg(['ST', '837', ctl.st, '005010X222A1']);
  seg(['BHT', '0019', '00', batchRef, yyyymmdd, hhmm, 'CH']);

  // 1000A — submitter
  seg(['NM1', '41', '2', esc(org.name), '', '', '', '', '', '46', org.edi_submitter_id || org.billing_npi || 'SUBMITTER']);
  seg(['PER', 'IC', esc(org.name, 35), 'TE', (org.billing_phone || '').replace(/\D/g, '').slice(0, 15) || '0000000000']);

  // 1000B — receiver (clearinghouse)
  seg(['NM1', '40', '2', esc(org.edi_receiver_id ? 'CLEARINGHOUSE' : 'CLEARINGHOUSE'), '', '', '', '', '', '46', org.edi_receiver_id || 'RECEIVER']);

  // 2000A — billing provider
  let hl = 1;
  const provHL = hl;
  seg(['HL', provHL, '', '20', '1']);
  seg(['NM1', '85', '2', esc(org.name), '', '', '', '', '', 'XX', billingNpi || '0000000000']);
  if (org.billing_address) seg(['N3', esc(org.billing_address)]);
  if (org.billing_city) seg(['N4', esc(org.billing_city), esc(org.billing_state, 2), esc(org.billing_zip, 15)]);
  if (org.billing_tax_id) seg(['REF', 'EI', String(org.billing_tax_id).replace(/\D/g, '')]);

  // Per-claim subscriber loops
  for (const c of claims) {
    const { cpts, icds } = validateClaimData(c); // data already validated by caller; reuse parsing
    hl++;
    const subHL = hl;
    const pat = splitName(c.patient_name);
    const dos = fmtDate(c.service_date);

    // 2000B — subscriber (patient is the subscriber)
    seg(['HL', subHL, provHL, '22', '0']);
    seg(['SBR', 'P', '18', '', '', '', '', '', '', 'CI']);
    // 2010BA — subscriber name / member ID / DOB
    seg(['NM1', 'IL', '1', esc(pat.last, 35), esc(pat.first, 25), '', '', '', 'MI', esc(c.member_id, 30)]);
    seg(['DMG', 'D8', fmtDate(c.patient_dob)]);
    // 2010BB — payer
    seg(['NM1', 'PR', '2', esc(c.payer_name, 35), '', '', '', '', '', 'PI', String(c.payer_id)]);

    // 2300 — claim
    // CLM01 = app claim id → 277CA TRN02 maps straight back to the claim row
    seg(['CLM', String(c.id), fmtMoney(c.billed_amount), '', '', '11:B:1', 'Y', 'A', 'Y', 'Y']);
    seg(['DTP', '472', 'D8', dos]);
    const hi = ['HI'];
    icds.slice(0, 12).forEach((code, i) => {
      hi.push(`${i === 0 ? 'ABK' : 'ABF'}:${code.replace(/[^A-Z0-9]/gi, '')}`);
    });
    seg(hi);

    // 2310B — rendering provider, when present
    if (c.rendering_npi) {
      const rp = splitName(c.rendering_provider || c.patient_name);
      seg(['NM1', '82', '1', esc(rp.last, 35), esc(rp.first, 25), '', '', '', 'XX',
        String(c.rendering_npi).replace(/\D/g, '').slice(0, 10)]);
    }

    // 2400 — service lines
    const lineAmounts = splitAmounts(c.billed_amount, cpts.length);
    cpts.forEach((rawCpt, i) => {
      const [cpt, ...mods] = rawCpt.split(':');
      const sv1 = ['SV1', `HC:${esc(cpt, 10)}${mods.length ? ':' + mods.map((m) => esc(m, 2)).join(':') : ''}`,
        lineAmounts[i], 'UN', '1', '', '', '1'];
      seg(['LX', i + 1]);
      seg(sv1);
      seg(['DTP', '472', 'D8', dos]);
    });
  }

  // Trailers — SE01 counts every segment from ST through SE inclusive
  const stIndex = S.findIndex((s) => s.startsWith('ST' + E));
  const seCount = (S.length - stIndex) + 1; // +1 for SE itself
  seg(['SE', seCount, ctl.st]);
  seg(['GE', '1', ctl.gs]);
  seg(['IEA', '1', ctl.isa]);

  return {
    ediText: S.map((s) => s + T).join('\n'),
    claimCount: claims.length,
    controlNumber: ctl.isa,
    batchReference: batchRef,
  };
}

// ---- structural validator ---------------------------------------------------
// Checks X12 envelope integrity: segment counts, control-number matching,
// required loops present. This is syntax, not payer adjudication.

function validate837(ediText, expectedClaimCount) {
  const errors = [];
  const segs = String(ediText || '').replace(/\r?\n/g, '').split(T)
    .map((s) => s.trim()).filter(Boolean).map((s) => s.split(E));
  const has = (id, pos, val) => segs.some((s) => s[0] === id && (val === undefined || s[pos] === val));

  if (!segs.length) { errors.push('Empty EDI document'); return { errors }; }
  if (segs[0][0] !== 'ISA') errors.push('Document must start with ISA');
  if (segs[segs.length - 1][0] !== 'IEA') errors.push('Document must end with IEA');

  const isa = segs.find((s) => s[0] === 'ISA');
  const iea = segs.find((s) => s[0] === 'IEA');
  const gs = segs.find((s) => s[0] === 'GS');
  const ge = segs.find((s) => s[0] === 'GE');
  const st = segs.find((s) => s[0] === 'ST');
  const se = segs.find((s) => s[0] === 'SE');

  if (isa && iea && isa[13] !== iea[2]) errors.push(`ISA13 (${isa[13]}) does not match IEA02 (${iea[2]})`);
  if (gs && ge && gs[6] !== ge[2]) errors.push(`GS06 (${gs[6]}) does not match GE02 (${ge[2]})`);
  if (st && se) {
    if (st[2] !== se[2]) errors.push(`ST02 (${st[2]}) does not match SE02 (${se[2]})`);
    const stIdx = segs.indexOf(st);
    const seIdx = segs.indexOf(se);
    const actual = seIdx - stIdx + 1; // ST..SE inclusive
    if (Number(se[1]) !== actual) errors.push(`SE01 (${se[1]}) does not match actual segment count ST..SE (${actual})`);
  } else {
    if (!st) errors.push('Missing ST segment');
    if (!se) errors.push('Missing SE segment');
  }

  // Required 005010X222A1 loops/segments for a professional claim batch
  const required = [
    ['ISA'], ['GS'], ['ST'], ['BHT'],
    ['NM1', 1, '41'], ['NM1', 1, '40'],
    ['HL', 3, '20'], ['NM1', 1, '85'],
    ['HL', 3, '22'], ['SBR'], ['NM1', 1, 'IL'], ['DMG'],
    ['NM1', 1, 'PR'], ['CLM'],
    ['GE'], ['IEA'],
  ];
  for (const [id, pos, val] of required) {
    if (!has(id, pos, val)) errors.push(`Missing required segment: ${id}${val ? `*${val}` : ''}`);
  }

  const clmCount = segs.filter((s) => s[0] === 'CLM').length;
  if (expectedClaimCount != null && clmCount !== expectedClaimCount) {
    errors.push(`CLM count (${clmCount}) does not match expected claim count (${expectedClaimCount})`);
  }
  if (clmCount === 0) errors.push('No CLM segments — nothing to transmit');

  // Every claim needs at least one service line (LX followed by SV1)
  const sv1Count = segs.filter((s) => s[0] === 'SV1').length;
  if (sv1Count < clmCount) errors.push(`SV1 service lines (${sv1Count}) fewer than claims (${clmCount})`);

  // Line amounts should sum to the claim total (cent-exact)
  const clmTotals = segs.filter((s) => s[0] === 'CLM').map((s) => Math.round(Number(s[2] || 0) * 100));
  const sv1ByClaim = [];
  let cur = -1;
  for (const s of segs) {
    if (s[0] === 'CLM') { cur++; sv1ByClaim[cur] = 0; }
    if (s[0] === 'SV1' && cur >= 0) sv1ByClaim[cur] += Math.round(Number(s[2] || 0) * 100);
  }
  sv1ByClaim.forEach((sum, i) => {
    if (clmTotals[i] != null && sum !== clmTotals[i]) {
      errors.push(`Claim ${i + 1}: service-line amounts (${(sum / 100).toFixed(2)}) do not sum to CLM total (${(clmTotals[i] / 100).toFixed(2)})`);
    }
  });

  return { errors };
}

module.exports = { generate837P, validate837, validateClaimData, nextControlNumbers };
