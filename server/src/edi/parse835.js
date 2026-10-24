'use strict';
// parse835.js — full X12 835 (Electronic Remittance Advice) parser.
//
// Extracts, per file: payer, check/EFT trace number, payment date, payment
// total (BPR02), provider-level adjustments (PLB), and per-claim lines from
// CLP loops: patient control number (CLP01), claim status (CLP02), billed
// (CLP03), paid (CLP04), patient responsibility (CLP05), payer claim control
// number / ICN (CLP07), patient name (NM1*QC), service dates (DTM*232/233),
// and every CAS adjustment (group code, reason code, amount) at claim level
// and service-line level (SVC loops roll up into their parent CLP).
//
// Pure function — no DB access. Returns a plain object the ERA engine posts.

const REASON_TEXT = {
  '1': 'Deductible amount',
  '2': 'Coinsurance amount',
  '3': 'Co-payment amount',
  '4': 'Procedure code inconsistent with modifier / not billable',
  '5': 'Procedure code inconsistent with place of service',
  '6': 'Procedure/revenue code inconsistent with patient age',
  '16': 'Claim/service lacks information or has submission/billing error(s)',
  '18': 'Exact duplicate claim/service',
  '19': 'Processing delay — forwarded to another payer (COB)',
  '22': 'Payment adjusted — coordination of benefits with another payer',
  '23': 'Payment adjusted because charges already paid by another payer',
  '26': 'Expenses incurred prior to coverage',
  '27': 'Expenses incurred after coverage terminated',
  '29': 'The time limit for filing has expired',
  '31': 'Patient cannot be identified as our insured',
  '32': 'Our records show dependent is not eligible',
  '39': 'Services denied at the time authorization/pre-certification was requested',
  '45': 'Charge exceeds fee schedule / maximum allowable',
  '49': 'Non-covered services — routine/preventive',
  '50': 'Non-covered services — not deemed medically necessary',
  '55': 'Procedure/treatment denied as not a covered benefit',
  '96': 'Non-covered charge(s)',
  '97': 'Benefit for this service is included in another service already adjudicated',
  '100': 'Payment made to patient/insured/responsible party',
  '104': 'Managed care withholding',
  '109': 'Claim/service not covered by this payer/contractor',
  '119': 'Benefit maximum for this time period or occurrence has been reached',
  '137': 'Payment adjusted — regulatory surcharge',
  '140': 'Patient/insured health identification number and name do not match',
  '151': 'Payer deems information does not support this many services/days',
  '167': 'Diagnosis(es) not covered',
  '170': 'Payment denied — service provided by a non-contracted / not authorized provider',
  '171': 'Payment adjusted — charges already considered for another claim',
  '181': 'Procedure code was invalid on the date of service',
  '182': 'Procedure modifier was invalid on the date of service',
  '185': 'The rendering provider is not eligible to perform the service billed',
  '197': 'Precertification/authorization/notification absent',
  '198': 'Precertification/authorization exceeded the limits',
  '204': 'Service/equipment/drug not covered under the patient benefit plan',
  '208': 'National Provider Identifier — taxonomy mismatch',
  '223': 'Adjustment code for mandated federal/state/regulatory programs',
  '234': 'Procedure/treatment has not been deemed proven to be effective',
  '236': 'Procedure/treatment not deemed an appropriate level of care',
  '242': 'Services not provided by network/primary care providers',
  '243': 'Services not authorized by network/primary care providers',
  '250': 'Services denied by an authorized representative of the provider network',
  '252': 'Additional information needed to process this claim/service',
  '253': 'Sequestration — reduction in federal payment',
  '256': 'Service not payable under managed care contract',
  '272': 'Coverage/program guidelines were not met',
  'A0': 'Patient refund amount',
  'B15': 'This service requires that a qualifying service or procedure be received and covered',
  'MA130': 'Claim contains incomplete and/or invalid information',
  'N30': 'Patient ineligible for this service',
  'N657': 'This should have been billed with the appropriate code for these services',
};

const GROUP_TEXT = {
  CO: 'Contractual obligation',
  CR: 'Corrections and reversals',
  OA: 'Other adjustments',
  PI: 'Payor initiated reduction',
  PR: 'Patient responsibility',
};

function money(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function ymd(v) {
  if (!v || !/^\d{8}$/.test(v)) return null;
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

// CLP02 claim status codes: 1 paid (primary), 2 paid (secondary),
// 3 denied (no payment), 4 processed as primary/denial-adjacent, 19/20 paid
// forwarded, 21/22 reversal, 25 recovery. Denial is best read from paid=0 +
// CAS reasons, but CLP02=4 on most payer 835s means denied. We expose the
// raw code and let the engine decide.
function parse835(input) {
  const text = String(input || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const segments = text.split('~').map((s) => s.trim()).filter(Boolean);
  if (!segments.length) throw Object.assign(new Error('Empty file'), { status: 400 });

  const out = {
    payerName: null,
    payeeName: null,
    checkNumber: null,
    payDate: null,
    paymentAmount: 0, // BPR02 total
    plb: [],          // [{ref, reason, amount}]
    plbTotal: 0,
    lines: [],
    segmentCount: segments.length,
  };

  let cur = null;    // current CLP line
  let inSvc = false; // inside an SVC service-line loop (CAS still rolls to CLP)

  const pushAdj = (el) => {
    if (!cur) return;
    const group = el[1] || 'OA';
    // CAS triplets: (reason, amount, quantity?) repeating from element 2
    for (let i = 2; i + 1 < el.length; i += 3) {
      const code = el[i];
      const amt = money(el[i + 1]);
      if (!code) continue;
      cur.adjustments.push({
        group,
        groupText: GROUP_TEXT[group] || group,
        code,
        text: REASON_TEXT[code] || `Reason ${code}`,
        amount: amt,
      });
    }
  };

  for (const seg of segments) {
    const el = seg.split('*');
    const tag = el[0];
    switch (tag) {
      case 'BPR':
        out.paymentAmount = money(el[2]);
        out.payDate = ymd(el[16]);
        break;
      case 'TRN':
        out.checkNumber = el[2] || null;
        break;
      case 'N1':
        if (el[1] === 'PR') out.payerName = el[2] || null;
        else if (el[1] === 'PE') out.payeeName = el[2] || null;
        break;
      case 'DTM':
        // 405 = production date at header level (only if no CLP open)
        if (!cur && el[1] === '405' && !out.payDate) out.payDate = ymd(el[2]);
        if (cur && el[1] === '232') cur.serviceStart = ymd(el[2]);
        if (cur && el[1] === '233') cur.serviceEnd = ymd(el[2]);
        break;
      case 'LX':
        inSvc = false;
        break;
      case 'CLP':
        cur = {
          clpRef: el[1] || '',
          statusCode: el[2] || '',
          billed: money(el[3]),
          paid: money(el[4]),
          patientResp: money(el[5]),
          payerIcn: el[7] || null,
          patientName: null,
          patientId: null,
          serviceStart: null,
          serviceEnd: null,
          adjustments: [],
        };
        out.lines.push(cur);
        inSvc = false;
        break;
      case 'NM1':
        if (cur && el[1] === 'QC') {
          const last = el[3] || '';
          const first = el[4] || '';
          cur.patientName = [first, last].filter(Boolean).join(' ').trim() || null;
          cur.patientId = el[9] || null;
        }
        break;
      case 'SVC':
        inSvc = true;
        break;
      case 'CAS':
        pushAdj(el);
        break;
      case 'PLB': {
        // PLB*providerId*date*reason:adjId*amount[*reason:adjId*amount...]
        let total = 0;
        for (let i = 3; i + 1 < el.length; i += 2) {
          const reason = el[i];
          const amt = money(el[i + 1]);
          if (!reason) continue;
          out.plb.push({ ref: el[1] || null, reason, amount: amt });
          total += amt;
        }
        out.plbTotal = Math.round((out.plbTotal + total) * 100) / 100;
        break;
      }
      default:
        break;
    }
    void inSvc;
  }

  // Derive per-line rollup numbers the engine needs.
  for (const l of out.lines) {
    const byGroup = (g) => Math.round(l.adjustments.filter((a) => a.group === g)
      .reduce((s, a) => s + a.amount, 0) * 100) / 100;
    l.coAdjustments = byGroup('CO');
    l.prAdjustments = byGroup('PR');
    l.oaAdjustments = byGroup('OA');
    l.piAdjustments = byGroup('PI');
    l.totalAdjustments = Math.round(l.adjustments.reduce((s, a) => s + a.amount, 0) * 100) / 100;
    // Allowed = paid + patient responsibility + contractual write-off basis:
    // standard read is billed - contractual adjustments.
    l.allowed = Math.round((l.billed - l.coAdjustments) * 100) / 100;
    // Balance equation: billed should equal paid + all CAS adjustments.
    // CLP05 (patient resp summary) duplicates the CAS PR detail when both
    // are present, so only the un-detailed remainder counts as unexplained.
    const unexplainedPr = Math.max(0, l.patientResp - l.prAdjustments);
    l.variance = Math.round((l.billed - l.paid - l.totalAdjustments - unexplainedPr) * 100) / 100;
    l.denialReasons = l.adjustments
      .filter((a) => a.group !== 'PR')
      .map((a) => `${a.code} — ${a.text}`);
  }

  out.totalBilled = Math.round(out.lines.reduce((s, l) => s + l.billed, 0) * 100) / 100;
  out.totalPaid = Math.round(out.lines.reduce((s, l) => s + l.paid, 0) * 100) / 100;
  out.totalAdjustments = Math.round(out.lines.reduce((s, l) => s + l.totalAdjustments, 0) * 100) / 100;
  out.totalPatientResp = Math.round(out.lines.reduce((s, l) => s + l.patientResp, 0) * 100) / 100;
  return out;
}

module.exports = { parse835, REASON_TEXT, GROUP_TEXT };
