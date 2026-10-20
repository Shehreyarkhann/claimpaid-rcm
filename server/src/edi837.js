// 837P (Healthcare Claim: Professional) EDI generator.
// Produces a valid-structure 837P file from Pulse claims for upload to a
// clearinghouse. Billing provider identity comes from the org's EDI settings.

function fmtDate(d) {
  if (!d) return '';
  return String(d).replace(/-/g, ''); // YYYYMMDD
}

function fmtMoney(n) {
  return (Math.round(Number(n || 0) * 100) / 100).toFixed(2);
}

function esc(s) {
  return String(s || '').replace(/[*~:]/g, '').slice(0, 60).trim();
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: '', last: parts[0] };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

function generate837P(claims, org, payer) {
  const now = new Date();
  const yymmdd = now.toISOString().slice(2, 10).replace(/-/g, '');
  const hhmm = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
  const yyyymmdd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const isaNum = String(Math.floor(Math.random() * 900000000) + 100000000);
  const batchRef = `B${yyyymmdd}${String(Math.floor(Math.random() * 900) + 100)}`;

  const S = [];
  const E = '*';
  const T = '~';

  // ISA — interchange header
  S.push(['ISA', '00', '          ', '00', '          ', 'ZZ', (org.billing_npi || 'PULSE').padEnd(15),
    'ZZ', 'CLEARINGHOUSE'.padEnd(15), yymmdd, hhmm, '^', '00501', isaNum, '0', 'P', '>'].join(E));
  S.push(['GS', 'HC', org.billing_npi || 'PULSE', 'CLEARINGHOUSE', yyyymmdd, hhmm, '1', 'X', '005010X222A1'].join(E));
  S.push(['ST', '837', '0001', '005010X222A1'].join(E));
  S.push(['BHT', '0019', '00', batchRef, yyyymmdd, hhmm, 'CH'].join(E));

  // Submitter (1000A)
  S.push(['NM1', '41', '2', esc(org.name).toUpperCase(), '', '', '', '', '', '46', org.billing_npi || 'PULSE'].join(E));
  S.push(['PER', 'IC', 'BILLING DEPT', 'TE', (org.billing_phone || '').replace(/\D/g, '') || '0000000000'].join(E));

  // Receiver (1000B)
  S.push(['NM1', '40', '2', esc(payer?.name || 'CLEARINGHOUSE').toUpperCase(), '', '', '', '', '', '46', 'RECEIVER'].join(E));

  let hl = 0;
  let claimSeq = 0;

  for (const c of claims) {
    claimSeq++;
    hl++;
    const provHL = hl;
    // Billing provider (2010AA)
    S.push(['HL', provHL, '', '20', '1'].join(E));
    S.push(['NM1', '85', '2', esc(org.name).toUpperCase(), '', '', '', '', '', 'XX', org.billing_npi || '0000000000'].join(E));
    if (org.billing_address) S.push(['N3', esc(org.billing_address).toUpperCase()].join(E));
    if (org.billing_city) S.push(['N4', esc(org.billing_city).toUpperCase(), esc(org.billing_state).toUpperCase(), esc(org.billing_zip)].join(E));
    if (org.billing_tax_id) S.push(['REF', 'EI', org.billing_tax_id.replace(/\D/g, '')].join(E));

    hl++;
    // Subscriber / patient (2000B → 2010BA)
    S.push(['HL', hl, provHL, '22', '0'].join(E));
    S.push(['SBR', 'P', '18', '', '', '', '', '', '', 'CI'].join(E));
    const pat = splitName(c.patient_name);
    S.push(['NM1', 'IL', '1', esc(pat.last).toUpperCase(), esc(pat.first).toUpperCase(), '', '', '', 'MI', esc(c.claim_number)].join(E));

    // Claim (2300)
    S.push(['CLM', esc(c.claim_number), fmtMoney(c.billed_amount), '', '', '11:B:1', 'Y', 'A', 'Y', 'Y'].join(E));
    S.push(['DTP', '472', 'D8', fmtDate(c.service_date)].join(E));

    // Diagnosis codes (2310 HI)
    const icds = String(c.icd_codes || '').split(/[,\s;]+/).map((x) => x.trim()).filter(Boolean);
    if (icds.length) {
      const hi = ['HI'];
      icds.slice(0, 12).forEach((code, i) => {
        hi.push(`${i === 0 ? 'ABK' : 'ABF'}:${code.replace('.', '')}`);
      });
      S.push(hi.join(E));
    }

    // Rendering provider (2310B) if present
    if (c.rendering_npi) {
      const rp = splitName(c.rendering_provider || c.patient_name);
      S.push(['NM1', '82', '1', esc(rp.last).toUpperCase(), esc(rp.first).toUpperCase(), '', '', '', 'XX', c.rendering_npi.replace(/\D/g, '')].join(E));
    }

    // Service lines (2400)
    const cpts = String(c.cpt_codes || '').split(/[,\s;]+/).map((x) => x.trim()).filter(Boolean);
    const lines = cpts.length ? cpts : [''];
    lines.forEach((cpt, i) => {
      S.push(['LX', i + 1].join(E));
      const lineAmt = lines.length > 1 ? fmtMoney(Number(c.billed_amount) / lines.length) : fmtMoney(c.billed_amount);
      S.push(['SV1', cpt ? `HC:${cpt}` : 'HC:00000', lineAmt, 'UN', 1, '', '', '1'].join(E));
      S.push(['DTP', '472', 'D8', fmtDate(c.service_date)].join(E));
    });
  }

  const stCount = S.length - 3 + 1; // segments since ST (approx; SE counts itself)
  S.push(['SE', stCount + 1, '0001'].join(E));
  S.push(['GE', '1', '1'].join(E));
  S.push(['IEA', '1', isaNum].join(E));

  return S.map((s) => s + T).join('\n');
}

module.exports = { generate837P };
