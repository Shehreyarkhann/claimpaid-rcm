const express = require('express');
const multer = require('multer');
const { db } = require('../db');
const { authRequired, roleRequired, requireProduct } = require('../auth');
const { logActivity } = require('../activity');

const router = express.Router();
router.use(authRequired, requireProduct('rcm'));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// --- 835 ERA (Electronic Remittance Advice) parser ---
// Parses CLP segments: CLP*claim_id*status*billed*paid*patient_resp*claim_type*...
// Status: 1/19=paid primary, 2/20=paid secondary, 4=denied, 22=reversal
router.post('/upload-835', roleRequired('owner', 'biller'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: file)' });

  const text = req.file.buffer.toString('utf-8').replace(/\r\n/g, '\n');
  // 835 uses ~ as segment terminator, * as element separator
  const segments = text.split('~').map((s) => s.trim()).filter(Boolean);

  let checkNumber = null, payDate = null, payerName = null;
  const clpEntries = [];
  let currentClp = null;

  // CARC reason codes → human denial reasons (subset that matters for automation)
  const REASON_MAP = {
    '197': 'Precertification/authorization absent',
    '198': 'Precertification authorization exceeded',
    '39': 'Services denied at time of authorization',
    '50': 'Non-covered services — medical necessity',
    '96': 'Non-covered charges',
    '18': 'Duplicate claim',
    '29': 'Timely filing expired',
    '16': 'Claim lacks information',
    '109': 'Claim not covered by payer',
  };

  for (const seg of segments) {
    const el = seg.split('*');
    const tag = el[0];
    if (tag === 'BPR') {
      // BPR*I*amount*C*... — payment amount is el[2]
      payDate = el[16] || null; // BPR16 = EFT effective date (YYYYMMDD)
    } else if (tag === 'TRN') {
      checkNumber = el[2] || null; // TRN02 = check/EFT trace number
    } else if (tag === 'N1' && el[1] === 'PR') {
      payerName = el[2] || null; // N1*PR*payer name
    } else if (tag === 'CLP') {
      currentClp = {
        claimId: el[1] || '',
        statusCode: el[2] || '',
        billed: parseFloat(el[3]) || 0,
        paid: parseFloat(el[4]) || 0,
        patientResp: parseFloat(el[5]) || 0,
        reasonCodes: [],
      };
      clpEntries.push(currentClp);
    } else if (tag === 'CAS' && currentClp) {
      // CAS*CO*197*amount — group code + reason code triplets
      for (let i = 2; i + 1 < el.length; i += 3) {
        const code = el[i];
        if (code && REASON_MAP[code] && !currentClp.reasonCodes.includes(code)) {
          currentClp.reasonCodes.push(code);
        }
      }
    }
  }

  if (!clpEntries.length) {
    return res.status(400).json({ error: 'No CLP (claim payment) segments found. Is this a valid 835 file?' });
  }

  const findClaim = db.prepare('SELECT * FROM claims WHERE org_id = ? AND claim_number = ?');
  const updateClaim = db.prepare('UPDATE claims SET paid_amount = ?, status = ?, last_touched_at = datetime(\'now\') WHERE id = ?');

  const results = { matched: 0, paid: 0, denied: 0, partial: 0, unmatched: [], details: [], auths_auto_linked: 0 };
  const AUTH_REASONS = ['197', '198', '39'];

  for (const e of clpEntries) {
    const claim = findClaim.get(req.orgId, e.claimId);
    if (!claim) {
      results.unmatched.push(e.claimId);
      continue;
    }
    results.matched++;
    const newPaid = Math.round((claim.paid_amount + e.paid) * 100) / 100;
    let newStatus = claim.status;
    let action;
    const denialReason = e.reasonCodes.map((c) => REASON_MAP[c]).filter(Boolean).join('; ') || null;

    if (['4'].includes(e.statusCode)) {
      newStatus = 'denied';
      results.denied++;
      action = `835: denied, $${e.paid.toFixed(2)} paid of $${e.billed.toFixed(2)} billed`;
      if (denialReason) action += ` — ${denialReason}`;
    } else if (e.paid >= e.billed * 0.98) {
      newStatus = 'paid';
      results.paid++;
      action = `835: paid $${e.paid.toFixed(2)}`;
    } else if (e.paid > 0) {
      newStatus = claim.status === 'denied' ? 'denied' : 'in_ar';
      results.partial++;
      action = `835: partial payment $${e.paid.toFixed(2)} of $${e.billed.toFixed(2)}`;
    } else {
      action = `835: $0 payment posted`;
    }

    if (denialReason && newStatus === 'denied') {
      db.prepare('UPDATE claims SET denial_reason = ? WHERE id = ?').run(denialReason, claim.id);
    }
    updateClaim.run(newPaid, newStatus, claim.id);
    logActivity(req.orgId, claim.id, req.user.id, 'payment_posted', action);

    // AUTO-LINK: auth-related denial → find matching auth and link it
    if (newStatus === 'denied' && e.reasonCodes.some((c) => AUTH_REASONS.includes(c))) {
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
        results.auths_auto_linked++;
      }
    }

    results.details.push({ claim_number: e.claimId, billed: e.billed, paid: e.paid, status: newStatus, denial_reason: denialReason });
  }

  res.json({
    file: req.file.originalname,
    payer: payerName, checkNumber,
    payDate: payDate ? `${payDate.slice(0, 4)}-${payDate.slice(4, 6)}-${payDate.slice(6, 8)}` : null,
    totalSegments: clpEntries.length,
    ...results,
  });
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
