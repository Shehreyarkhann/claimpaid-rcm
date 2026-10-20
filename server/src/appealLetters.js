// Appeal letter engine with per-organization customizable templates.
// Each denial category has a default body (with {{placeholders}}); orgs can
// override body + enclosures, which are then used for every generated letter.

const { db } = require('./db');

function categorizeReason(reason) {
  const r = String(reason || '').toLowerCase();
  if (/medical necessity|not medically necessary|mn den/i.test(r)) return 'medical_necessity';
  if (/auth|pre-cert|precert|prior approval/i.test(r)) return 'no_auth';
  if (/timely|filing|untimely/i.test(r)) return 'timely_filing';
  if (/coding|modifier|cpt|bundl|ncci/i.test(r)) return 'coding';
  if (/eligib|coverage|not covered|benefit/i.test(r)) return 'eligibility';
  if (/duplicat/i.test(r)) return 'duplicate';
  if (/experimental|investigational/i.test(r)) return 'experimental';
  return 'general';
}

const CATEGORY_LABELS = {
  medical_necessity: 'Medical necessity',
  no_auth: 'Missing authorization',
  timely_filing: 'Timely filing',
  coding: 'Coding / bundling',
  eligibility: 'Eligibility / coverage',
  duplicate: 'Duplicate claim',
  experimental: 'Experimental / investigational',
  general: 'General / other',
};

// Available placeholders for template bodies
const PLACEHOLDERS = [
  ['patient_name', 'Patient full name'],
  ['claim_number', 'Claim number'],
  ['service_date', 'Date of service'],
  ['billed_amount', 'Billed amount (e.g. $5,183.64)'],
  ['denial_reason', 'Denial reason from payer'],
  ['payer', 'Payer name'],
  ['cpt', 'CPT procedure codes'],
  ['icd', 'ICD-10 diagnosis codes'],
  ['auth_number', 'Authorization number (if linked)'],
  ['auth_valid', 'Authorization validity period (if linked)'],
  ['org_name', 'Your organization name'],
  ['org_phone', 'Your organization phone'],
  ['org_email', 'Your organization email'],
  ['biller_name', 'Name of the biller generating the letter'],
  ['biller_email', 'Email of the biller generating the letter'],
  ['today', "Today's date"],
];

// Placeholders specific to the signature block
const SIGNATURE_PLACEHOLDERS = [
  ['biller_name', 'Name of the biller generating the letter'],
  ['biller_email', 'Email of the biller generating the letter'],
  ['org_name', 'Your organization name'],
  ['org_phone', 'Your organization phone'],
  ['org_email', 'Your organization email'],
  ['today', "Today's date"],
];

// Default signature block (orgs can override)
const DEFAULT_SIGNATURE =
  `Sincerely,\n\n\n` +
  `_________________________________\n` +
  `{{biller_name}}\n` +
  `{{org_name}}\n` +
  `{{org_phone}}`;

function getSignature(orgId) {
  const row = db.prepare(
    "SELECT body FROM appeal_letter_templates WHERE org_id = ? AND category = 'signature'"
  ).get(orgId);
  return { body: row?.body || DEFAULT_SIGNATURE, is_custom: !!row };
}

const DEFAULT_TEMPLATES = {
  medical_necessity: {
    body:
      `We are writing to formally appeal the denial of the above-referenced claim on the basis of medical necessity.\n\n` +
      `The services rendered ({{cpt}}) were medically necessary and appropriate for the patient's diagnosed condition ({{icd}}). ` +
      `Clinical documentation supporting medical necessity — including physician notes, diagnostic findings, and treatment rationale — is enclosed for your medical reviewer's reconsideration.\n\n` +
      `We respectfully request a peer-to-peer review with your medical director at your earliest convenience, and ask that this denial be overturned and the claim processed for payment.`,
    enclosures: ['Physician clinical notes', 'Diagnostic test results', 'Treatment plan / rationale'],
  },
  no_auth: {
    body:
      `We are writing to appeal the denial of the above-referenced claim for lack of prior authorization.\n\n` +
      `{{auth_section}}` +
      `We respectfully request that this denial be overturned and the claim processed for payment.`,
    enclosures: ['Authorization approval letter', 'Clinical notes supporting medical necessity'],
  },
  timely_filing: {
    body:
      `We are writing to appeal the denial of the above-referenced claim as untimely.\n\n` +
      `Our records indicate the claim for {{patient_name}} ({{claim_number}}, date of service {{service_date}}) was submitted within your timely filing requirements. ` +
      `Please see the enclosed proof of timely submission. If your records reflect a different receipt date, we request a full audit trail of the claim's receipt history.\n\n` +
      `We respectfully request reconsideration and processing of this claim for payment.`,
    enclosures: ['Proof of timely submission (clearinghouse acceptance report)', 'Claim submission log'],
  },
  coding: {
    body:
      `We are writing regarding the denial of the above-referenced claim for coding/bundling reasons.\n\n` +
      `We have reviewed the coding on this claim and believe the services were correctly coded per CPT guidelines ({{cpt}}). ` +
      `Where applicable, appropriate modifiers were appended to distinguish separately identifiable services. Corrected coding detail and supporting documentation are enclosed.\n\n` +
      `We request reprocessing of this claim with correct adjudication.`,
    enclosures: ['Corrected claim detail', 'Operative / procedure report'],
  },
  eligibility: {
    body:
      `We are writing to appeal the denial of the above-referenced claim on eligibility/coverage grounds.\n\n` +
      `Coverage was verified as active for the date of service ({{service_date}}). Enclosed is our eligibility verification record. ` +
      `If your system reflects a coverage termination, we request the exact termination date and supporting enrollment records so we may reconcile the discrepancy.\n\n` +
      `We respectfully request that this denial be overturned and the claim processed for payment.`,
    enclosures: ['Eligibility verification record (dated)', 'Copy of insurance card if available'],
  },
  duplicate: {
    body:
      `We are writing regarding the denial of the above-referenced claim as a duplicate.\n\n` +
      `This claim ({{claim_number}}) represents distinct, separately identifiable services and is not a duplicate submission. ` +
      `Please compare the dates of service, procedure codes, and rendering providers against the claim it was matched to — you will find material differences. Supporting detail is enclosed.\n\n` +
      `We request that this denial be overturned and the claim processed for payment.`,
    enclosures: ['Claim detail comparison', 'Date-of-service documentation'],
  },
  experimental: {
    body:
      `We are writing to appeal the denial of the above-referenced claim as experimental/investigational.\n\n` +
      `The services rendered are established, evidence-based treatments supported by peer-reviewed literature and specialty society guidelines — not experimental. ` +
      `Enclosed are relevant clinical guidelines and literature supporting the standard-of-care status of this treatment for the patient's condition.\n\n` +
      `We respectfully request review by a same-specialty medical director and reversal of this denial.`,
    enclosures: ['Peer-reviewed literature', 'Specialty society guidelines'],
  },
  general: {
    body:
      `We are writing to formally appeal the denial of the above-referenced claim.\n\n` +
      `Denial reason stated: "{{denial_reason}}".\n\n` +
      `We believe this denial was issued in error. Supporting documentation — including clinical notes, authorization records, and proof of timely submission where applicable — is enclosed for your reconsideration.\n\n` +
      `We respectfully request that this denial be overturned and the claim processed for payment in full.`,
    enclosures: ['Clinical documentation', 'Any supporting records'],
  },
};

function renderBody(body, data) {
  return String(body).replace(/\{\{(\w+)\}\}/g, (m, key) =>
    data[key] !== undefined && data[key] !== null ? String(data[key]) : '');
}

// Special-case: {{auth_section}} renders different text depending on linked auth
function renderAuthSection(data) {
  if (data.auth_number) {
    return `Prior authorization WAS obtained for these services. Authorization number ${data.auth_number}${data.auth_valid ? `, valid ${data.auth_valid}` : ''}. A copy of the authorization approval is enclosed. We request that you reprocess this claim against the valid authorization on file.\n\n`;
  }
  return `We are requesting retroactive authorization / reconsideration of the authorization requirement for these services. ` +
    `The services were medically necessary and emergent in nature, and any delay in obtaining prior authorization would have jeopardized the patient's care. Supporting clinical documentation is enclosed.\n\n`;
}

function getTemplate(orgId, category) {
  const cat = DEFAULT_TEMPLATES[category] ? category : 'general';
  const row = db.prepare(
    'SELECT body, enclosures FROM appeal_letter_templates WHERE org_id = ? AND category = ?'
  ).get(orgId, cat);
  if (row) {
    let enclosures = [];
    try { enclosures = JSON.parse(row.enclosures); } catch { enclosures = []; }
    return { category: cat, body: row.body, enclosures, is_custom: true };
  }
  return { category: cat, ...DEFAULT_TEMPLATES[cat], is_custom: false };
}

function listTemplates(orgId) {
  return Object.keys(DEFAULT_TEMPLATES).map((cat) => {
    const t = getTemplate(orgId, cat);
    return {
      category: cat,
      label: CATEGORY_LABELS[cat],
      body: t.body,
      enclosures: t.enclosures,
      is_custom: t.is_custom,
    };
  });
}

function generateLetter({ claim, appeal, org, auth }) {
  const category = categorizeReason(claim.denial_reason);
  const tpl = getTemplate(org.id, category);
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const data = {
    patient_name: claim.patient_name || '',
    claim_number: claim.claim_number || '',
    service_date: claim.service_date || '',
    billed_amount: `$${Number(claim.billed_amount || 0).toFixed(2)}`,
    denial_reason: claim.denial_reason || '',
    payer: claim.payer || '',
    cpt: claim.cpt_codes || 'as billed',
    icd: claim.icd_codes || 'as coded',
    auth_number: auth?.auth_number || '',
    auth_valid: auth?.valid_from && auth?.valid_to ? `${auth.valid_from} through ${auth.valid_to}` : '',
    org_name: org.name || '',
    org_phone: org.billing_phone || '',
    org_email: org.billing_email || '',
    biller_name: appeal.assignee_name || '[Biller name]',
    biller_email: appeal.assignee_email || '',
    today,
  };

  let body = renderBody(tpl.body, data);
  // Handle the auth conditional section
  body = body.replace('{{auth_section}}', renderAuthSection(data));

  const enclosures = tpl.enclosures.map((e, i) => `  ${i + 1}. ${e}`).join('\n');
  const addr = [org.billing_city, org.billing_state, org.billing_zip].filter(Boolean).join(', ');
  const signature = renderBody(getSignature(org.id).body, data);

  return {
    category,
    category_label: CATEGORY_LABELS[tpl.category],
    is_custom: tpl.is_custom,
    subject: `Appeal of Denied Claim ${claim.claim_number}`,
    text:
      `${org.name || ''}\n${org.billing_address || ''}\n${addr}\n${org.billing_phone || ''}\n\n${today}\n\n` +
      `Appeals Department\n${claim.payer || 'Payer'}\n\n` +
      `Re: Formal Appeal — Denied Claim\n` +
      `Patient: ${claim.patient_name}\n` +
      `Claim Number: ${claim.claim_number}\n` +
      `Date of Service: ${claim.service_date || '—'}\n` +
      `Billed Amount: $${Number(claim.billed_amount || 0).toFixed(2)}\n` +
      `Denial Reason: ${claim.denial_reason || '—'}\n\n` +
      `Dear Appeals Reviewer:\n\n` +
      body +
      `\n\nEnclosures:\n${enclosures}\n\n` +
      `Thank you for your prompt reconsideration. Please direct any questions to the undersigned.\n\n` +
      signature,
  };
}

module.exports = {
  generateLetter, categorizeReason, getTemplate, getSignature, listTemplates,
  CATEGORY_LABELS, PLACEHOLDERS, SIGNATURE_PLACEHOLDERS, DEFAULT_TEMPLATES, DEFAULT_SIGNATURE,
};
