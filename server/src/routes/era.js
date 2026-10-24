const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { db } = require('../db');
const { authRequired, roleRequired, requireProduct } = require('../auth');
const { logActivity } = require('../activity');
const { auditLog } = require('../audit');
const { parse835 } = require('../edi/parse835');

const router = express.Router();
router.use(authRequired, requireProduct('rcm'));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const AUTH_REASON_CODES = ['197', '198', '39'];
const VARIANCE_TOLERANCE = 0.02;

// ---------------------------------------------------------------------------
// ERA auto-posting engine (deploy #41)
//
// Upload an 835 → parse → store remittance + claim lines → match each line
// to a claim (patient control number first, payer ICN second) → auto-post
// the clean lines immediately (payment, contractual adjustments, patient
// responsibility, denial status + reason) → everything else lands in the
// ERA inbox as an exception: unmatched, unbalanced (variance), reversal,
// duplicate, or a claim that is already closed. Exceptions resolve with
// one click: post, manual match, or ignore.
// ---------------------------------------------------------------------------

function recomputeRemittance(eraId) {
  const era = db.prepare('SELECT * FROM era_remittances WHERE id = ?').get(eraId);
  if (!era) return;
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN post_status = 'posted' THEN 1 ELSE 0 END) AS posted,
      SUM(CASE WHEN post_status = 'pending' THEN 1 ELSE 0 END) AS pending
    FROM era_claim_lines WHERE era_id = ?
  `).get(eraId);
  const posted = counts.posted || 0;
  const pending = counts.pending || 0;
  const status = pending === 0 ? 'posted' : posted > 0 ? 'partially_posted' : 'received';
  db.prepare('UPDATE era_remittances SET posted_count = ?, status = ? WHERE id = ?').run(posted, status, eraId);
}

function findMatch(orgId, line) {
  let claim = db.prepare('SELECT * FROM claims WHERE org_id = ? AND claim_number = ?')
    .get(orgId, line.clpRef);
  if (claim) return { claim, method: 'control_number' };
  if (line.payerIcn) {
    claim = db.prepare('SELECT * FROM claims WHERE org_id = ? AND payer_icn = ?').get(orgId, line.payerIcn);
    if (claim) return { claim, method: 'icn' };
  }
  return { claim: null, method: null };
}

function findSuggestion(orgId, line) {
  // Same billed amount on an open claim + a corroborating signal (patient
  // last name or exact service date). Suggestion only — never auto-posts.
  const rows = db.prepare(`
    SELECT * FROM claims WHERE org_id = ? AND billed_amount = ? AND status != 'paid'
    ORDER BY created_at DESC LIMIT 10
  `).all(orgId, line.billed);
  if (!rows.length) return null;
  const lastName = (line.patientName || '').trim().split(/\s+/).pop()?.toLowerCase();
  for (const c of rows) {
    const nameHit = lastName && c.patient_name.toLowerCase().includes(lastName);
    const dateHit = line.serviceStart && c.service_date === line.serviceStart;
    if (nameHit || dateHit) return c;
  }
  return null;
}

function claimBalance(claim) {
  return round2(claim.billed_amount - claim.paid_amount - (claim.adjustment_amount || 0) - (claim.patient_resp_amount || 0));
}

function computeFlags(orgId, eraCheckNumber, line, claim) {
  const flags = [];
  const isDenialStatus = line.statusCode === '4'
    || (line.paid === 0 && line.denialReasons.length > 0 && line.patientResp === 0 && line.totalAdjustments < line.billed);
  if (!claim) flags.push('unmatched');
  if (line.statusCode === '21' || line.statusCode === '22') flags.push('reversal');
  if (isDenialStatus) flags.push('denial');
  if (Math.abs(line.variance) > VARIANCE_TOLERANCE) flags.push('variance');
  if (line.paid === 0 && !isDenialStatus) flags.push('zero_pay');
  if (claim) {
    const dup = db.prepare(`
      SELECT COUNT(*) AS n FROM era_claim_lines l
      JOIN era_remittances r ON r.id = l.era_id
      WHERE l.org_id = ? AND l.match_claim_id = ? AND l.post_status = 'posted'
        AND r.check_number IS NOT NULL AND r.check_number = ?
    `).get(orgId, claim.id, eraCheckNumber || '');
    if (eraCheckNumber && dup.n > 0) flags.push('duplicate');
    if (claim.status === 'paid' && claimBalance(claim) <= VARIANCE_TOLERANCE && line.paid > 0) flags.push('claim_closed');
  }
  return flags;
}

const BLOCKING_FLAGS = ['unmatched', 'variance', 'reversal', 'duplicate', 'claim_closed'];

// Applies one ERA line to its matched claim. Caller owns the transaction.
function postLine(req, era, line) {
  const claim = db.prepare('SELECT * FROM claims WHERE id = ? AND org_id = ?').get(line.match_claim_id, req.orgId);
  if (!claim) throw Object.assign(new Error('Matched claim not found'), { status: 404 });

  const adj = JSON.parse(line.adjustments || '[]');
  const sumGroup = (...gs) => round2(adj.filter((a) => gs.includes(a.group)).reduce((s, a) => s + a.amount, 0));
  const writeOff = sumGroup('CO', 'OA', 'PI');
  const patientResp = Math.max(Number(line.patient_resp) || 0, sumGroup('PR'));
  const isReversal = line.status_code === '21' || line.status_code === '22';
  const sign = isReversal ? -1 : 1;

  const newPaid = Math.max(0, round2(claim.paid_amount + sign * line.paid));
  const newAdj = Math.max(0, round2((claim.adjustment_amount || 0) + sign * writeOff));
  const newPr = Math.max(0, round2((claim.patient_resp_amount || 0) + sign * patientResp));
  const balance = round2(claim.billed_amount - newPaid - newAdj - newPr);

  const flags = JSON.parse(line.flags || '[]');
  const isDenial = flags.includes('denial');
  let newStatus;
  if (isDenial && !isReversal) newStatus = 'denied';
  else if (balance <= VARIANCE_TOLERANCE) {
    // Fully accounted for. Still 'in_ar' when the payer paid nothing and the
    // balance moved entirely to the patient (deductible/copay) — that money
    // is still collectible, now from the patient.
    newStatus = newPaid === 0 && newPr > 0 ? 'in_ar' : 'paid';
  }
  else if (newPaid > 0 || newPr > 0) newStatus = 'in_ar';
  else newStatus = claim.status;

  db.prepare(`
    UPDATE claims SET paid_amount = ?, adjustment_amount = ?, patient_resp_amount = ?,
      allowed_amount = COALESCE(?, allowed_amount),
      payer_icn = COALESCE(payer_icn, ?),
      status = ?, last_touched_at = datetime('now')
    WHERE id = ?
  `).run(newPaid, newAdj, newPr, isReversal ? null : line.allowed, line.payer_icn, newStatus, claim.id);

  let authLinked = 0;
  if (newStatus === 'denied') {
    if (line.denial_reason) {
      db.prepare('UPDATE claims SET denial_reason = ? WHERE id = ?').run(line.denial_reason, claim.id);
    }
    const codes = adj.map((a) => a.code);
    if (codes.some((c) => AUTH_REASON_CODES.includes(c))) {
      const match = db.prepare(`
        SELECT id FROM auth_requests
        WHERE org_id = ? AND patient_name = ? AND payer_id = ?
          AND linked_claim_id IS NULL
        ORDER BY created_at DESC LIMIT 1
      `).get(req.orgId, claim.patient_name, claim.payer_id);
      if (match) {
        db.prepare('UPDATE auth_requests SET linked_claim_id = ? WHERE id = ?').run(claim.id, match.id);
        logActivity(req.orgId, claim.id, req.user.id, 'auth_linked',
          `Auto-linked to authorization #${match.id} (835 denial reason: authorization)`);
        authLinked = 1;
      }
    }
  }

  const verb = isReversal ? 'reversed' : isDenial ? 'denied' : 'posted';
  logActivity(req.orgId, claim.id, req.user.id, 'payment_posted',
    `ERA ${era.check_number || era.id}: ${verb} $${line.paid.toFixed(2)} paid of $${line.billed.toFixed(2)} billed`
    + (writeOff ? `, $${writeOff.toFixed(2)} adjustments` : '')
    + (patientResp ? `, $${patientResp.toFixed(2)} patient responsibility` : '')
    + (line.denial_reason && isDenial ? ` — ${line.denial_reason}` : ''));

  db.prepare(`UPDATE era_claim_lines SET post_status = 'posted', posted_at = datetime('now'), posted_by = ? WHERE id = ?`)
    .run(req.user.id, line.id);
  return { claimId: claim.id, newStatus, balance, authLinked };
}

// --- Upload + auto-post ---
router.post('/upload-835', roleRequired('owner', 'biller'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: file)' });

  const text = req.file.buffer.toString('utf-8');
  let parsed;
  try {
    parsed = parse835(text);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
  if (!parsed.lines.length) {
    return res.status(400).json({ error: 'No CLP (claim payment) segments found. Is this a valid 835 file?' });
  }

  const fileHash = crypto.createHash('sha256').update(text).digest('hex');
  const existing = db.prepare('SELECT id FROM era_remittances WHERE org_id = ? AND file_hash = ?')
    .get(req.orgId, fileHash);
  if (existing && req.query.force !== '1') {
    return res.status(409).json({
      error: 'This exact 835 file was already uploaded. Re-upload with force to process it again.',
      remittanceId: existing.id,
    });
  }

  const summary = {
    file: req.file.originalname,
    payer: parsed.payerName,
    checkNumber: parsed.checkNumber,
    payDate: parsed.payDate,
    totalSegments: parsed.lines.length,
    matched: 0, paid: 0, denied: 0, partial: 0,
    unmatched: [], details: [], auths_auto_linked: 0,
    autoPosted: 0, exceptions: 0, remittanceId: null,
    totals: {
      billed: parsed.totalBilled, paid: parsed.totalPaid,
      adjustments: parsed.totalAdjustments, patientResp: parsed.totalPatientResp,
      plb: parsed.plbTotal,
    },
  };

  db.exec('BEGIN');
  try {
    const eraId = db.prepare(`
      INSERT INTO era_remittances (org_id, payer_name, check_number, pay_date, payment_amount,
        plb_total, total_billed, total_paid, total_adjustments, total_patient_resp,
        line_count, source_filename, file_hash, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.orgId, parsed.payerName, parsed.checkNumber, parsed.payDate, parsed.paymentAmount,
      parsed.plbTotal, parsed.totalBilled, parsed.totalPaid, parsed.totalAdjustments,
      parsed.totalPatientResp, parsed.lines.length, req.file.originalname, fileHash, req.user.id).lastInsertRowid;
    summary.remittanceId = eraId;
    const era = db.prepare('SELECT * FROM era_remittances WHERE id = ?').get(eraId);

    const insertLine = db.prepare(`
      INSERT INTO era_claim_lines (era_id, org_id, clp_ref, payer_icn, patient_name,
        service_start, service_end, status_code, billed, paid, patient_resp, allowed,
        adjustments, total_adjustments, variance, denial_reason, flags,
        match_claim_id, suggested_claim_id, match_method)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const p of parsed.lines) {
      const { claim, method } = findMatch(req.orgId, p);
      const suggestion = claim ? null : findSuggestion(req.orgId, p);
      const flags = computeFlags(req.orgId, parsed.checkNumber, p, claim);
      if (!claim && suggestion) flags.push('suggested_match');
      const denialReason = p.denialReasons.length ? p.denialReasons.join('; ') : null;

      const lineId = insertLine.run(eraId, req.orgId, p.clpRef, p.payerIcn, p.patientName,
        p.serviceStart, p.serviceEnd, p.statusCode, p.billed, p.paid, p.patientResp,
        p.allowed, JSON.stringify(p.adjustments), p.totalAdjustments, p.variance,
        denialReason, JSON.stringify(flags), claim ? claim.id : null,
        suggestion ? suggestion.id : null, method).lastInsertRowid;

      if (claim) summary.matched++;
      else summary.unmatched.push(p.clpRef);

      const blocked = flags.some((f) => BLOCKING_FLAGS.includes(f));
      if (claim && !blocked) {
        const lineRow = db.prepare('SELECT * FROM era_claim_lines WHERE id = ?').get(lineId);
        const result = postLine(req, era, lineRow);
        summary.autoPosted++;
        summary.auths_auto_linked += result.authLinked;
        if (result.newStatus === 'paid') summary.paid++;
        else if (result.newStatus === 'denied') summary.denied++;
        else summary.partial++;
        summary.details.push({
          claim_number: p.clpRef, billed: p.billed, paid: p.paid,
          status: result.newStatus, denial_reason: denialReason, posted: true,
        });
      } else {
        summary.exceptions++;
        summary.details.push({
          claim_number: p.clpRef, billed: p.billed, paid: p.paid,
          status: 'exception', flags, denial_reason: denialReason, posted: false,
        });
      }
    }

    recomputeRemittance(eraId);
    auditLog(req, 'create', 'era_remittance', eraId,
      `835 ${req.file.originalname} — ${parsed.lines.length} lines, ${summary.autoPosted} auto-posted, ${summary.exceptions} exceptions`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  res.json(summary);
});

// --- ERA inbox ---
router.get('/remittances', (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, u.name AS uploaded_by_name,
      (SELECT COUNT(*) FROM era_claim_lines l WHERE l.era_id = r.id AND l.post_status = 'pending') AS pending_count
    FROM era_remittances r LEFT JOIN users u ON u.id = r.uploaded_by
    WHERE r.org_id = ? ORDER BY r.created_at DESC LIMIT 100
  `).all(req.orgId);
  res.json({ remittances: rows });
});

router.get('/remittances/:id', (req, res) => {
  const era = db.prepare('SELECT * FROM era_remittances WHERE id = ? AND org_id = ?')
    .get(req.params.id, req.orgId);
  if (!era) return res.status(404).json({ error: 'Remittance not found' });
  const lines = db.prepare(`
    SELECT l.*, c.claim_number AS matched_claim_number, c.patient_name AS matched_patient,
      sc.claim_number AS suggested_claim_number
    FROM era_claim_lines l
    LEFT JOIN claims c ON c.id = l.match_claim_id
    LEFT JOIN claims sc ON sc.id = l.suggested_claim_id
    WHERE l.era_id = ? ORDER BY l.id ASC
  `).all(era.id);
  res.json({
    remittance: era,
    lines: lines.map((l) => ({
      ...l,
      adjustments: JSON.parse(l.adjustments || '[]'),
      flags: JSON.parse(l.flags || '[]'),
    })),
  });
});

function getLine(req, res) {
  const line = db.prepare('SELECT * FROM era_claim_lines WHERE id = ? AND org_id = ?')
    .get(req.params.id, req.orgId);
  if (!line) { res.status(404).json({ error: 'ERA line not found' }); return null; }
  return line;
}

router.post('/lines/:id/post', roleRequired('owner', 'biller'), (req, res) => {
  const line = getLine(req, res);
  if (!line) return;
  if (line.post_status === 'posted') return res.status(409).json({ error: 'Line already posted' });
  if (!line.match_claim_id) return res.status(400).json({ error: 'Match this line to a claim before posting' });
  const era = db.prepare('SELECT * FROM era_remittances WHERE id = ?').get(line.era_id);
  db.exec('BEGIN');
  try {
    const result = postLine(req, era, line);
    recomputeRemittance(line.era_id);
    auditLog(req, 'post', 'era_claim_line', line.id,
      `Manual post to claim ${line.match_claim_id} — $${line.paid.toFixed(2)}`);
    db.exec('COMMIT');
    res.json({ ok: true, ...result });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

router.post('/lines/:id/match', roleRequired('owner', 'biller'), (req, res) => {
  const line = getLine(req, res);
  if (!line) return;
  if (line.post_status === 'posted') return res.status(409).json({ error: 'Line already posted' });
  const claim = db.prepare('SELECT * FROM claims WHERE id = ? AND org_id = ?')
    .get(req.body.claim_id, req.orgId);
  if (!claim) return res.status(404).json({ error: 'Claim not found' });
  const flags = JSON.parse(line.flags || '[]').filter((f) => f !== 'unmatched' && f !== 'suggested_match');
  db.prepare(`UPDATE era_claim_lines SET match_claim_id = ?, match_method = 'manual', flags = ? WHERE id = ?`)
    .run(claim.id, JSON.stringify(flags), line.id);
  auditLog(req, 'match', 'era_claim_line', line.id, `Manually matched to ${claim.claim_number}`);
  if (req.body.post) {
    const era = db.prepare('SELECT * FROM era_remittances WHERE id = ?').get(line.era_id);
    const fresh = db.prepare('SELECT * FROM era_claim_lines WHERE id = ?').get(line.id);
    db.exec('BEGIN');
    try {
      const result = postLine(req, era, fresh);
      recomputeRemittance(line.era_id);
      db.exec('COMMIT');
      return res.json({ ok: true, matched: true, posted: true, ...result });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  res.json({ ok: true, matched: true, posted: false });
});

router.post('/lines/:id/ignore', roleRequired('owner', 'biller'), (req, res) => {
  const line = getLine(req, res);
  if (!line) return;
  if (line.post_status === 'posted') return res.status(409).json({ error: 'Line already posted' });
  db.prepare(`UPDATE era_claim_lines SET post_status = 'ignored' WHERE id = ?`).run(line.id);
  recomputeRemittance(line.era_id);
  auditLog(req, 'ignore', 'era_claim_line', line.id, `Ignored — CLP ${line.clp_ref}`);
  res.json({ ok: true });
});

// Claim search for the manual-match picker.
router.get('/match-candidates', (req, res) => {
  const q = `%${String(req.query.q || '').trim()}%`;
  const rows = db.prepare(`
    SELECT id, claim_number, patient_name, service_date, billed_amount, paid_amount, status
    FROM claims WHERE org_id = ? AND (claim_number LIKE ? OR patient_name LIKE ?)
    ORDER BY created_at DESC LIMIT 20
  `).all(req.orgId, q, q);
  res.json({ claims: rows });
});

// --- Reconciliation ---
function reconciliation(orgId) {
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(billed), 0) AS billed,
      COALESCE(SUM(paid), 0) AS paid,
      COALESCE(SUM(total_adjustments), 0) AS adjustments,
      COALESCE(SUM(patient_resp), 0) AS patient_resp,
      SUM(CASE WHEN post_status = 'posted' THEN 1 ELSE 0 END) AS posted_lines,
      SUM(CASE WHEN post_status = 'pending' THEN 1 ELSE 0 END) AS pending_lines,
      COUNT(*) AS total_lines
    FROM era_claim_lines WHERE org_id = ?
  `).get(orgId);
  const byPayer = db.prepare(`
    SELECT COALESCE(r.payer_name, 'Unknown payer') AS payer,
      COUNT(DISTINCT r.id) AS remittances,
      COALESCE(SUM(l.billed), 0) AS billed,
      COALESCE(SUM(l.paid), 0) AS paid,
      COALESCE(SUM(l.total_adjustments), 0) AS adjustments,
      COALESCE(SUM(l.patient_resp), 0) AS patient_resp,
      SUM(CASE WHEN l.post_status = 'pending' THEN 1 ELSE 0 END) AS pending_lines
    FROM era_remittances r JOIN era_claim_lines l ON l.era_id = r.id
    WHERE r.org_id = ? GROUP BY COALESCE(r.payer_name, 'Unknown payer')
    ORDER BY paid DESC
  `).all(orgId);
  const exceptions = db.prepare(`
    SELECT l.id, l.clp_ref, l.billed, l.paid, l.flags, l.created_at,
      r.payer_name, r.check_number
    FROM era_claim_lines l JOIN era_remittances r ON r.id = l.era_id
    WHERE l.org_id = ? AND l.post_status = 'pending'
    ORDER BY l.created_at DESC LIMIT 100
  `).all(orgId).map((e) => ({ ...e, flags: JSON.parse(e.flags || '[]') }));
  const outstanding = db.prepare(`
    SELECT COALESCE(SUM(billed_amount - paid_amount - adjustment_amount - patient_resp_amount), 0) AS balance
    FROM claims WHERE org_id = ? AND status IN ('pending', 'in_ar')
  `).get(orgId);
  const r2 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? round2(v) : v]));
  return {
    totals: r2(totals),
    byPayer: byPayer.map(r2),
    exceptions,
    openClaimBalance: round2(outstanding.balance),
  };
}

router.get('/reconciliation', (req, res) => {
  res.json(reconciliation(req.orgId));
});

router.get('/reconciliation.csv', (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.payer_name, r.check_number, r.pay_date, r.source_filename,
      r.total_billed, r.total_paid, r.total_adjustments, r.total_patient_resp,
      r.payment_amount, r.plb_total, r.line_count, r.posted_count, r.status, r.created_at
    FROM era_remittances r WHERE r.org_id = ? ORDER BY r.created_at ASC
  `).all(req.orgId);
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['era_id', 'payer', 'check_number', 'pay_date', 'file', 'billed', 'paid', 'adjustments', 'patient_resp', 'check_amount', 'plb_adjustments', 'lines', 'lines_posted', 'status', 'uploaded_at'];
  const body = rows.map((r) => [r.id, r.payer_name, r.check_number, r.pay_date, r.source_filename,
    r.total_billed, r.total_paid, r.total_adjustments, r.total_patient_resp, r.payment_amount,
    r.plb_total, r.line_count, r.posted_count, r.status, r.created_at].map(esc).join(','));
  auditLog(req, 'export', 'era_reconciliation', null, `CSV export — ${rows.length} remittances`);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="era-reconciliation.csv"');
  res.send([head.join(','), ...body].join('\n'));
});

// --- Daily digest data (morning briefing) ---
router.get('/digest', (req, res) => {
  const org = req.orgId;
  const today = new Date().toISOString().slice(0, 10);

  const worklist = db.prepare(`
    SELECT COUNT(*) AS n FROM appeals
    WHERE org_id = ? AND status NOT IN ('won','lost')
      AND follow_up_date IS NOT NULL AND follow_up_date < ?
  `).get(org, today).n;

  const { FILING_SELECT, FILING_JOIN } = require('./filing');
  const filing = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(c.billed_amount - c.paid_amount), 0) AS amt
    FROM claims c ${FILING_JOIN}
    WHERE c.org_id = ? AND c.status IN ('pending','in_ar','denied')
      AND CAST(julianday(date(c.service_date, '+' || COALESCE(fr.filing_days, 365) || ' days')) - julianday('now') AS INTEGER) <= 14
  `).get(org);

  const unworked = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(c.billed_amount - c.paid_amount), 0) AS amt
    FROM claims c LEFT JOIN appeals a ON a.claim_id = c.id AND a.org_id = ?
    WHERE c.org_id = ? AND c.status = 'denied' AND a.id IS NULL
  `).get(org, org);

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const activity = db.prepare(`
    SELECT ca.action, ca.detail, ca.created_at, c.claim_number, u.name AS user_name
    FROM claim_activity ca
    LEFT JOIN claims c ON c.id = ca.claim_id
    LEFT JOIN users u ON u.id = ca.user_id
    WHERE ca.org_id = ? AND ca.created_at >= ?
    ORDER BY ca.created_at DESC LIMIT 15
  `).all(org, yesterday.toISOString().slice(0, 10));

  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const recovered = db.prepare(`
    SELECT COALESCE(SUM(c.billed_amount), 0) AS amt, COUNT(*) AS n
    FROM appeals a JOIN claims c ON c.id = a.claim_id
    WHERE a.org_id = ? AND a.status = 'won' AND a.updated_at >= ?
  `).get(org, weekAgo.toISOString().slice(0, 10));

  // Prior auth alerts: expiring soon + expired + waiting too long
  const authExpiring = db.prepare(`
    SELECT id, patient_name, valid_to,
      CAST(julianday(valid_to) - julianday('now') AS INTEGER) AS days_left
    FROM auth_requests
    WHERE org_id = ? AND status = 'approved' AND valid_to IS NOT NULL
      AND CAST(julianday(valid_to) - julianday('now') AS INTEGER) <= 14
    ORDER BY days_left ASC LIMIT 5
  `).all(org);
  const authWaiting = db.prepare(`
    SELECT COUNT(*) AS n FROM auth_requests
    WHERE org_id = ? AND status IN ('submitted','pending_info')
      AND CAST(julianday('now') - julianday(requested_date) AS INTEGER) > 10
  `).get(org).n;

  // Denial patterns: payer x reason clusters (top 3 by dollars at stake)
  const patterns = db.prepare(`
    SELECT p.name AS payer, c.denial_reason, COUNT(*) AS n,
      SUM(c.billed_amount - c.paid_amount) AS at_stake
    FROM claims c LEFT JOIN payers p ON p.id = c.payer_id
    WHERE c.org_id = ? AND c.status = 'denied'
      AND c.created_at >= date('now', '-90 days')
      AND c.denial_reason IS NOT NULL AND c.denial_reason != ''
    GROUP BY p.id, c.denial_reason
    HAVING COUNT(*) >= 4
    ORDER BY at_stake DESC LIMIT 3
  `).all(org);

  // Unappealed denials aging past 14 days
  const unappealed = db.prepare(`
    SELECT COUNT(*) AS n, SUM(c.billed_amount - c.paid_amount) AS at_stake
    FROM claims c LEFT JOIN appeals a ON a.claim_id = c.id
    WHERE c.org_id = ? AND c.status = 'denied' AND a.id IS NULL
      AND c.created_at < date('now', '-14 days')
  `).get(org);

  res.json({
    date: today,
    overdueFollowups: worklist,
    filingCritical: { count: filing.n, amount: Math.round(filing.amt * 100) / 100 },
    unworkedDenials: { count: unworked.n, amount: Math.round(unworked.amt * 100) / 100 },
    recoveredThisWeek: { count: recovered.n, amount: Math.round(recovered.amt * 100) / 100 },
    authAlerts: { expiring: authExpiring, staleWaiting: authWaiting },
    denialPatterns: patterns.map((p) => ({ ...p, at_stake: Math.round(p.at_stake * 100) / 100 })),
    unappealedDenials: { count: unappealed.n, amount: Math.round((unappealed.at_stake || 0) * 100) / 100 },
    recentActivity: activity,
  });
});

module.exports = router;
