'use strict';
// Patient statements core (deploy #50).
//
// Money flow: ERA posting rolls patient responsibility onto claims
// (claims.patient_resp_amount). A statement snapshots one patient's
// outstanding responsibility across claims into statement_lines. Payments
// (Stripe payment link via webhook, or manual entry) allocate back across
// the lines oldest-first and onto claims.patient_paid_amount, so the
// balances view and the ERA rollups always agree.
//
// A claim appears on at most one ACTIVE statement at a time
// (draft/open/partially_paid) — generation excludes locked claims, so a
// patient can never be double-billed for the same responsibility.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ACTIVE_STATUSES = ['draft', 'open', 'partially_paid'];

function lockedClaimIds(db, orgId) {
  const rows = db.prepare(
    `SELECT sl.claim_id FROM statement_lines sl
     JOIN patient_statements ps ON ps.id = sl.statement_id
     WHERE ps.org_id = ? AND ps.status IN ('draft','open','partially_paid')`
  ).all(orgId);
  return new Set(rows.map((r) => r.claim_id));
}

function availableClaims(db, orgId) {
  const locked = lockedClaimIds(db, orgId);
  const rows = db.prepare(
    `SELECT c.*, p.name AS payer_name FROM claims c
     JOIN payers p ON p.id = c.payer_id
     WHERE c.org_id = ? AND (c.patient_resp_amount - c.patient_paid_amount) > 0.005
     ORDER BY c.patient_name, c.service_date, c.id`
  ).all(orgId);
  return rows.filter((c) => !locked.has(c.id));
}

function patientBalances(db, orgId) {
  const byPatient = new Map();
  for (const c of availableClaims(db, orgId)) {
    const key = `${c.patient_name}||${c.member_id || ''}`;
    if (!byPatient.has(key)) {
      byPatient.set(key, {
        patient_name: c.patient_name,
        member_id: c.member_id || null,
        claims: 0,
        total_due: 0,
        oldest_service_date: c.service_date,
      });
    }
    const b = byPatient.get(key);
    b.claims += 1;
    b.total_due = round2(b.total_due + (c.patient_resp_amount - c.patient_paid_amount));
    if (c.service_date < b.oldest_service_date) b.oldest_service_date = c.service_date;
  }
  return [...byPatient.values()].sort((a, b) => b.total_due - a.total_due);
}

function getStatement(db, orgId, id) {
  const stmt = db.prepare('SELECT * FROM patient_statements WHERE id = ? AND org_id = ?').get(id, orgId);
  if (!stmt) return null;
  const lines = db.prepare('SELECT * FROM statement_lines WHERE statement_id = ? ORDER BY service_date, id').all(id);
  const payments = db.prepare('SELECT * FROM statement_payments WHERE statement_id = ? ORDER BY id').all(id);
  return { ...stmt, lines, payments, balance: round2(stmt.amount_due - stmt.amount_paid) };
}

function createStatement(db, { orgId, userId, patient_name, member_id }) {
  const claims = availableClaims(db, orgId).filter(
    (c) => c.patient_name === patient_name && (c.member_id || null) === (member_id || null)
  );
  if (!claims.length) return null;
  const total = round2(claims.reduce((s, c) => s + (c.patient_resp_amount - c.patient_paid_amount), 0));
  const due = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO patient_statements (org_id, statement_number, patient_name, member_id, amount_due, status, due_date, created_by)
       VALUES (?, '', ?, ?, ?, 'draft', ?, ?)`
    ).run(orgId, patient_name, member_id || null, total, due, userId || null);
    const id = Number(info.lastInsertRowid);
    const number = `STMT-${String(id).padStart(5, '0')}`;
    db.prepare('UPDATE patient_statements SET statement_number = ? WHERE id = ?').run(number, id);
    const insLine = db.prepare(
      `INSERT INTO statement_lines (statement_id, claim_id, claim_number, service_date, payer_name, billed, insurance_paid, adjustments, patient_resp, amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const c of claims) {
      insLine.run(
        id, c.id, c.claim_number, c.service_date, c.payer_name,
        round2(c.billed_amount), round2(c.paid_amount), round2(c.adjustment_amount),
        round2(c.patient_resp_amount), round2(c.patient_resp_amount - c.patient_paid_amount)
      );
    }
    db.exec('COMMIT');
    return getStatement(db, orgId, id);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function recordPayment(db, { orgId, statementId, amount, method, externalId }) {
  const amt = round2(amount);
  if (!(amt > 0)) throw new Error('Payment amount must be positive');
  const stmt = db.prepare('SELECT * FROM patient_statements WHERE id = ? AND org_id = ?').get(statementId, orgId);
  if (!stmt) throw new Error('Statement not found');
  // Idempotency first: a redelivered webhook for an already-settled
  // statement is a duplicate, not an error.
  if (externalId) {
    const dup = db.prepare('SELECT id FROM statement_payments WHERE external_id = ?').get(externalId);
    if (dup) return { duplicate: true, statement: getStatement(db, orgId, statementId) };
  }
  if (stmt.status === 'void') throw new Error('Statement is void');
  if (stmt.status === 'paid') throw new Error('Statement is already paid in full');
  const remaining = round2(stmt.amount_due - stmt.amount_paid);
  if (amt - remaining > 0.005) throw new Error(`Payment exceeds the statement balance of $${remaining.toFixed(2)}`);
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO statement_payments (statement_id, org_id, amount, method, external_id) VALUES (?, ?, ?, ?, ?)')
      .run(statementId, orgId, amt, method || 'manual', externalId || null);
    let left = amt;
    const lines = db.prepare('SELECT * FROM statement_lines WHERE statement_id = ? ORDER BY service_date, id').all(statementId);
    const updLine = db.prepare('UPDATE statement_lines SET allocated_paid = allocated_paid + ? WHERE id = ?');
    const updClaim = db.prepare('UPDATE claims SET patient_paid_amount = patient_paid_amount + ? WHERE id = ?');
    for (const line of lines) {
      if (left <= 0.005) break;
      const room = round2(line.amount - line.allocated_paid);
      if (room <= 0.005) continue;
      const alloc = Math.min(room, left);
      updLine.run(alloc, line.id);
      updClaim.run(alloc, line.claim_id);
      left = round2(left - alloc);
    }
    const newPaid = round2(stmt.amount_paid + amt);
    const isPaid = newPaid >= stmt.amount_due - 0.005;
    db.prepare('UPDATE patient_statements SET amount_paid = ?, status = ?, paid_at = ? WHERE id = ?')
      .run(newPaid, isPaid ? 'paid' : 'partially_paid', isPaid ? new Date().toISOString() : stmt.paid_at, statementId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { duplicate: false, statement: getStatement(db, orgId, statementId) };
}

// Stripe Payment Link for the statement's remaining balance. A one-off
// Price is created per link (Payment Links require a Price id). Metadata
// carries the statement id so the billing webhook can settle it.
async function createStripePaymentLink(stripe, stmt, orgName) {
  const remaining = round2(stmt.amount_due - stmt.amount_paid);
  if (!(remaining > 0)) throw new Error('Statement has no balance to collect');
  const price = await stripe.prices.create({
    currency: 'usd',
    unit_amount: Math.round(remaining * 100),
    product_data: { name: `Patient statement ${stmt.statement_number} — ${orgName}` },
  });
  const link = await stripe.paymentLinks.create({
    line_items: [{ price: price.id, quantity: 1 }],
    metadata: { statement_id: String(stmt.id), org_id: String(stmt.org_id), kind: 'patient_statement' },
    after_completion: { type: 'redirect', redirect: { url: 'https://claimpaid.io/app/' } },
    // Patient statements are healthcare receivables, never Managed Payments
    // eligible (Stripe MoR covers digital goods only). Accounts with Managed
    // Payments on by default otherwise reject the link for a missing product
    // tax code — so statement links always opt out explicitly.
    managed_payments: { enabled: false },
  }, {
    // The managed_payments opt-out on Payment Links only exists from the API
    // version it launched in (Stripe changelog, dahlia 2026-03-25 preview);
    // on the account's default version the parameter is silently ignored and
    // the MoR tax-code rejection still fires (verified live, deploy #79).
    // Pin the version for this one call only.
    apiVersion: '2026-03-25.preview',
  });
  return { id: link.id, url: link.url };
}

// ---------------------------------------------------------------------------
// Minimal PDF writer (no dependencies): built-in Helvetica, latin1 text.
// ---------------------------------------------------------------------------
function pdfEscape(s) {
  return String(s == null ? '' : s)
    .replace(/[^\x20-\x7E]/g, '-')
    .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

function statementPdf(db, orgId, id) {
  const stmt = getStatement(db, orgId, id);
  if (!stmt) return null;
  const org = db.prepare('SELECT name, billing_npi FROM orgs WHERE id = ?').get(orgId) || {};

  const pages = [];
  let ops = [];
  let pageNo = 0;
  const text = (x, y, size, font, str, color) => {
    if (color) ops.push(`${color} rg`);
    ops.push(`BT /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfEscape(str)}) Tj ET`);
    if (color) ops.push('0 0 0 rg');
  };
  const hline = (x1, x2, y) => { ops.push('0.75 g'); ops.push('0.7 w'); ops.push(`${x1} ${y} m ${x2} ${y} l S`); ops.push('0 g'); };
  const GREEN = '0.05 0.55 0.34';
  const GREY = '0.35 0.38 0.42';

  function header() {
    pageNo += 1;
    ops = [];
    text(54, 742, 19, 'F2', org.name || 'Practice', GREEN);
    text(54, 722, 12, 'F2', 'PATIENT STATEMENT');
    text(420, 742, 9.5, 'F1', `Statement: ${stmt.statement_number}`, GREY);
    text(420, 729, 9.5, 'F1', `Date: ${String(stmt.created_at).slice(0, 10)}`, GREY);
    text(420, 716, 9.5, 'F1', `Due: ${stmt.due_date || 'On receipt'}`, GREY);
    hline(54, 558, 706);
    text(54, 688, 10, 'F1', `Patient: ${stmt.patient_name}`);
    if (stmt.member_id) text(54, 674, 9.5, 'F1', `Member ID: ${stmt.member_id}`, GREY);
    if (org.billing_npi) text(420, 688, 9.5, 'F1', `Billing NPI: ${org.billing_npi}`, GREY);
    text(54, 648, 10.5, 'F2', 'Charges after insurance');
    text(54, 632, 8.8, 'F2', 'DATE', GREY);
    text(104, 632, 8.8, 'F2', 'CLAIM', GREY);
    text(196, 632, 8.8, 'F2', 'PAYER', GREY);
    text(320, 632, 8.8, 'F2', 'BILLED', GREY);
    text(386, 632, 8.8, 'F2', 'INS PAID', GREY);
    text(452, 632, 8.8, 'F2', 'ADJUST', GREY);
    text(506, 632, 8.8, 'F2', 'YOU OWE', GREY);
    hline(54, 558, 626);
  }
  const rtext = (xRight, y, size, font, str) => {
    // right-align approximation: 0.5 * size per char for Helvetica avg
    const w = String(str).length * size * 0.5;
    text(xRight - w, y, size, font, str);
  };

  header();
  let y = 608;
  for (const ln of stmt.lines) {
    if (y < 120) { pages.push(ops.join('\n')); header(); y = 608; }
    text(54, y, 8.8, 'F1', ln.service_date || '');
    text(104, y, 8.8, 'F1', ln.claim_number || '');
    text(196, y, 8.8, 'F1', String(ln.payer_name || '').slice(0, 22));
    rtext(372, y, 8.8, 'F1', money(ln.billed));
    rtext(440, y, 8.8, 'F1', money(ln.insurance_paid));
    rtext(500, y, 8.8, 'F1', money(ln.adjustments));
    rtext(558, y, 8.8, 'F2', money(ln.amount));
    y -= 15;
  }
  if (y < 190) { pages.push(ops.join('\n')); header(); y = 608; }
  hline(54, 558, y + 4);
  text(386, y - 14, 10.5, 'F2', 'Total due:');
  rtext(558, y - 14, 10.5, 'F2', money(stmt.amount_due));
  text(386, y - 30, 10, 'F1', 'Paid:');
  rtext(558, y - 30, 10, 'F1', money(stmt.amount_paid));
  text(386, y - 48, 12, 'F2', 'Balance due:', GREEN);
  rtext(558, y - 48, 12, 'F2', money(stmt.amount_due - stmt.amount_paid));
  let fy = y - 82;
  if (stmt.payment_link_url && stmt.status !== 'paid') {
    text(54, fy, 10.5, 'F2', 'Pay online:', GREEN);
    // Payment links are long; split into chunks that fit the page.
    const url = stmt.payment_link_url;
    for (let i = 0; i < url.length; i += 78) {
      fy -= 13;
      text(54, fy, 8.8, 'F1', url.slice(i, i + 78));
    }
    fy -= 8;
  }
  text(54, fy - 14, 8.8, 'F1', 'This statement shows your responsibility after insurance processing.', GREY);
  text(54, fy - 27, 8.8, 'F1', 'Questions about a charge? Contact the practice billing office.', GREY);
  text(54, 40, 8, 'F1', 'Generated by ClaimPaid', GREY);
  pages.push(ops.join('\n'));

  // Assemble the document.
  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const pageIds = pages.map((_, i) => 3 + i * 2);
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3 + pages.length * 2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objects[4 + pages.length * 2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';
  const fontF1 = 3 + pages.length * 2;
  const fontF2 = 4 + pages.length * 2;
  pages.forEach((content, i) => {
    const pid = 3 + i * 2;
    const cid = pid + 1;
    objects[pid] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontF1} 0 R /F2 ${fontF2} 0 R >> >> /Contents ${cid} 0 R >>`;
    objects[cid] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets = [0];
  const total = Math.max(...Object.keys(objects).map(Number));
  for (let i = 1; i <= total; i++) {
    offsets[i] = Buffer.byteLength(out, 'latin1');
    out += `${i} 0 obj\n${objects[i] || '<< >>'}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= total; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return { buffer: Buffer.from(out, 'latin1'), filename: `${stmt.statement_number}.pdf`, statement: stmt };
}

module.exports = {
  round2, ACTIVE_STATUSES, lockedClaimIds, availableClaims, patientBalances,
  getStatement, createStatement, recordPayment, createStripePaymentLink, statementPdf,
};
