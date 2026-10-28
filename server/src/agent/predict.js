'use strict';
// Prediction service (agent Phase 3, WS3) — the single implementation
// behind the agent tools, the insights API, the worklist prediction
// field, and the morning brief's plan basis.
//
// Rules that keep this honest:
//   * ORG'S OWN DATA ONLY. No cross-tenant reads, ever — an org's decided
//     appeals and remittances train only its own predictions.
//   * Every prediction returns { value, sampleSize, basis, label }.
//     sampleSize counts the real decided cases behind the number; below
//     THIN_SAMPLE the label says 'early estimate'. No data -> value null.
//   * Filing risk is not a model at all: it reuses the deterministic
//     filing computation the Filing Rules tab serves.
const { db } = require('../db');
const { FILING_SELECT, FILING_JOIN } = require('../routes/filing');

const THIN_SAMPLE = 10;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function labelFor(sampleSize) {
  if (!sampleSize) return 'no data yet';
  return sampleSize < THIN_SAMPLE ? 'early estimate' : 'established';
}

function packRate(hits, sampleSize, basis) {
  if (!sampleSize) return { value: null, sampleSize: 0, basis: 'none', label: 'no data yet' };
  return {
    value: Math.round((hits / sampleSize) * 1000) / 1000,
    sampleSize,
    basis,
    label: labelFor(sampleSize),
  };
}

// ---- Winning-argument learning (Phase 4, WS1) ----
// The stats carry the letter category (angle) each decided appeal argued.
// An angle only earns the right to steer a draft once its OWN decided
// sample for the pair clears ANGLE_MIN_SAMPLE — below that, no guidance
// and no claim. Selection is deterministic: highest overturn rate, ties
// broken by the larger sample.
const ANGLE_MIN_SAMPLE = 5;

function bestAngle(orgId, payerId, denialReason) {
  if (payerId == null || !denialReason) return null;
  const rows = db.prepare(
    'SELECT angle, appeals, overturned FROM agent_outcome_stats WHERE org_id = ? AND payer_id = ? AND denial_reason = ? AND appeals >= ?'
  ).all(orgId, payerId, denialReason, ANGLE_MIN_SAMPLE);
  if (!rows.length) return null;
  rows.sort((a, b) => (b.overturned / b.appeals) - (a.overturned / a.appeals) || b.appeals - a.appeals);
  const top = rows[0];
  return {
    angle: top.angle,
    value: Math.round((top.overturned / top.appeals) * 1000) / 1000,
    sampleSize: top.appeals,
    overturned: top.overturned,
  };
}

// ---- Appeal-overturn likelihood (from WS5's agent_outcome_stats) ----
// Fallback chain: angle-conditioned rate (Phase 4 — the best angle's own
// record for this pair, once it clears the sample threshold; or an
// explicitly requested angle) -> payer + denial reason (summed across
// angles) -> payer overall -> org overall.
function appealOverturn(orgId, payerId, denialReason, angle = null) {
  if (payerId != null && denialReason) {
    if (angle) {
      const row = db.prepare(
        'SELECT appeals, overturned FROM agent_outcome_stats WHERE org_id = ? AND payer_id = ? AND denial_reason = ? AND angle = ?'
      ).get(orgId, payerId, denialReason, angle);
      if (row && row.appeals > 0) {
        return { ...packRate(row.overturned, row.appeals, 'payer + denial reason + angle'), angle };
      }
    } else {
      const best = bestAngle(orgId, payerId, denialReason);
      if (best) {
        return {
          ...packRate(best.overturned, best.sampleSize, 'payer + denial reason + angle'),
          angle: best.angle,
        };
      }
    }
    const row = db.prepare(
      'SELECT COALESCE(SUM(appeals), 0) AS appeals, COALESCE(SUM(overturned), 0) AS overturned FROM agent_outcome_stats WHERE org_id = ? AND payer_id = ? AND denial_reason = ?'
    ).get(orgId, payerId, denialReason);
    if (row && row.appeals > 0) return packRate(row.overturned, row.appeals, 'payer + denial reason');
  }
  if (payerId != null) {
    const row = db.prepare(
      'SELECT COALESCE(SUM(appeals), 0) AS appeals, COALESCE(SUM(overturned), 0) AS overturned FROM agent_outcome_stats WHERE org_id = ? AND payer_id = ?'
    ).get(orgId, payerId);
    if (row && row.appeals > 0) return packRate(row.overturned, row.appeals, 'payer overall');
  }
  const org = db.prepare(
    'SELECT COALESCE(SUM(appeals), 0) AS appeals, COALESCE(SUM(overturned), 0) AS overturned FROM agent_outcome_stats WHERE org_id = ?'
  ).get(orgId);
  if (org && org.appeals > 0) return packRate(org.overturned, org.appeals, 'org overall');
  return { value: null, sampleSize: 0, basis: 'none', label: 'no data yet' };
}

// ---- Expected-payment likelihood (org's ERA paid-rate) ----
// Procedure family = the first 3 digits of the first CPT code (the E/M
// family 992xx -> '992', etc.). Primary source: posted ERA lines matched
// to this org's claims for the payer; fallback: decided claims.
function cptFamily(cptCodes) {
  const first = String(cptCodes || '').split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean)[0];
  return first ? first.slice(0, 3).toUpperCase() : null;
}

function payLikelihood(orgId, claim) {
  if (!claim || claim.payer_id == null) return { value: null, sampleSize: 0, basis: 'none', label: 'no data yet' };
  const lines = db.prepare(`
    SELECT l.paid AS paid, c.cpt_codes AS cpt_codes
    FROM era_claim_lines l JOIN claims c ON c.id = l.match_claim_id
    WHERE l.org_id = ? AND c.payer_id = ? AND l.post_status = 'posted'
  `).all(orgId, claim.payer_id);
  if (lines.length) {
    const fam = cptFamily(claim.cpt_codes);
    const famLines = fam ? lines.filter((l) => cptFamily(l.cpt_codes) === fam) : [];
    if (famLines.length) {
      return packRate(famLines.filter((l) => l.paid > 0).length, famLines.length, 'ERA paid-rate · payer + procedure family');
    }
    return packRate(lines.filter((l) => l.paid > 0).length, lines.length, 'ERA paid-rate · payer');
  }
  const decided = db.prepare(`
    SELECT paid_amount FROM claims
    WHERE org_id = ? AND payer_id = ? AND status IN ('paid', 'denied')
  `).all(orgId, claim.payer_id);
  if (decided.length) {
    return packRate(decided.filter((c) => c.paid_amount > 0).length, decided.length, 'decided claims · payer');
  }
  return { value: null, sampleSize: 0, basis: 'none', label: 'no data yet' };
}

// ---- Filing risk (deterministic — the existing computation) ----
function filingRisk(orgId, claimId) {
  const row = db.prepare(`
    SELECT ${FILING_SELECT} FROM claims c ${FILING_JOIN} WHERE c.id = ? AND c.org_id = ?
  `).get(claimId, orgId);
  if (!row) return null;
  const days = row.days_until_filing;
  const state = days == null ? 'unknown' : days < 0 ? 'expired' : days <= 14 ? 'critical' : days <= 30 ? 'watch' : 'ok';
  return {
    filing_deadline: row.filing_deadline || null,
    days_left: days,
    filing_days: row.filing_days || null,
    state,
  };
}

// ---- Compact per-claim prediction for list surfaces ----
// Denied claims get overturn likelihood; open claims get pay likelihood.
function predictionForClaim(orgId, claim) {
  if (!claim) return null;
  const payerName = claim.payer || claim.payer_name || null;
  if (claim.status === 'denied') {
    const p = appealOverturn(orgId, claim.payer_id, claim.denial_reason || null);
    if (p.value == null) return null;
    const pct = Math.round(p.value * 100);
    return {
      kind: 'appeal_overturn',
      ...p,
      headline: p.value >= 0.5 ? 'Appeal likely to overturn' : 'Appeal unlikely to overturn',
      detail: `Appeals to ${payerName || 'this payer'}${claim.denial_reason ? ` on ${claim.denial_reason}` : ''} overturn ${pct}% of the time here (n=${p.sampleSize})`,
    };
  }
  if (claim.status === 'pending' || claim.status === 'in_ar') {
    const p = payLikelihood(orgId, claim);
    if (p.value == null) return null;
    const pct = Math.round(p.value * 100);
    return {
      kind: 'pay_likelihood',
      ...p,
      headline: p.value >= 0.5 ? 'Likely to pay' : 'Payment uncertain',
      detail: `${payerName || 'This payer'} pays ${pct}% of comparable claims here (n=${p.sampleSize}, ${p.basis})`,
    };
  }
  return null;
}

// Batch helper for the worklist route: claim_id -> prediction (or absent).
function predictionsForClaimIds(orgId, claimIds) {
  const out = new Map();
  const ids = [...new Set((claimIds || []).filter((id) => id != null))];
  if (!ids.length) return out;
  const rows = db.prepare(`
    SELECT c.*, p.name AS payer FROM claims c LEFT JOIN payers p ON p.id = c.payer_id
    WHERE c.org_id = ? AND c.id IN (${ids.map(() => '?').join(',')})
  `).all(orgId, ...ids);
  for (const claim of rows) {
    const pred = predictionForClaim(orgId, claim);
    if (pred) out.set(claim.id, pred);
  }
  return out;
}

// ---- Dashboard insights ----
function insights(orgId) {
  const risk = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(c.billed_amount - c.paid_amount), 0) AS amt
    FROM claims c ${FILING_JOIN}
    WHERE c.org_id = ? AND c.status IN ('pending', 'in_ar', 'denied')
      AND CAST(julianday(date(c.service_date, '+' || COALESCE(fr.filing_days, 365) || ' days')) - julianday('now') AS INTEGER) <= 14
  `).get(orgId);

  // Expected collections: open balances weighted by each payer's paid-rate
  // (family-agnostic at dashboard level). Claims whose payer has no rate
  // are counted but contribute nothing — coverage is reported, not hidden.
  const open = db.prepare(`
    SELECT id, payer_id, cpt_codes, (billed_amount - paid_amount) AS balance
    FROM claims WHERE org_id = ? AND status IN ('pending', 'in_ar') AND (billed_amount - paid_amount) > 0
  `).all(orgId);
  const rateByPayer = new Map();
  let expected = 0;
  let covered = 0;
  let sampleTotal = 0;
  for (const c of open) {
    if (!rateByPayer.has(c.payer_id)) {
      rateByPayer.set(c.payer_id, payLikelihood(orgId, { payer_id: c.payer_id, cpt_codes: null }));
    }
    const rate = rateByPayer.get(c.payer_id);
    if (rate.value != null) {
      expected += c.balance * rate.value;
      covered++;
      if (!rateByPayer.get(c.payer_id)._counted) { sampleTotal += rate.sampleSize; rateByPayer.get(c.payer_id)._counted = true; }
    }
  }

  const trendRows = db.prepare(`
    SELECT p.id AS payer_id, p.name AS payer,
      SUM(CASE WHEN c.created_at >= date('now', '-30 days') THEN 1 ELSE 0 END) AS cur_total,
      SUM(CASE WHEN c.created_at >= date('now', '-30 days') AND c.status = 'denied' THEN 1 ELSE 0 END) AS cur_denied,
      SUM(CASE WHEN c.created_at < date('now', '-30 days') THEN 1 ELSE 0 END) AS prior_total,
      SUM(CASE WHEN c.created_at < date('now', '-30 days') AND c.status = 'denied' THEN 1 ELSE 0 END) AS prior_denied
    FROM claims c JOIN payers p ON p.id = c.payer_id
    WHERE c.org_id = ? AND c.created_at >= date('now', '-60 days')
    GROUP BY p.id, p.name
  `).all(orgId);
  const trendWatch = [];
  for (const r of trendRows) {
    if (!r.cur_total) continue;
    const curRate = r.cur_denied / r.cur_total;
    const priorRate = r.prior_total ? r.prior_denied / r.prior_total : null;
    const rising = r.cur_total >= 5 && priorRate != null && curRate - priorRate >= 0.05;
    if (rising || (priorRate != null && curRate >= 0.25 && r.cur_total >= 5)) {
      trendWatch.push({
        payer: r.payer,
        current_rate: Math.round(curRate * 1000) / 1000,
        prior_rate: Math.round(priorRate * 1000) / 1000,
        delta_points: Math.round((curRate - priorRate) * 100),
        sample_size: r.cur_total,
        label: labelFor(r.cur_total),
      });
    }
  }
  trendWatch.sort((a, b) => b.delta_points - a.delta_points);

  const backlog = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(billed), 0) AS amt FROM era_claim_lines
    WHERE org_id = ? AND post_status = 'pending' AND flags IS NOT NULL AND flags != '[]'
  `).get(orgId);

  // Recovered via agent-assisted appeals (Phase 4): dollars actually
  // collected on claims whose agent-drafted appeal was approved AND
  // reached an overturned outcome — the same outcome definition
  // outcomes.js reconciles (appeal won, or claim paid with money in
  // after the appeal). Counted from paid_amount only: money in the door,
  // never billed amounts or projections.
  const recovered = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(c.paid_amount), 0) AS amt
    FROM agent_actions a
    JOIN appeals ap ON ap.id = CAST(json_extract(a.result, '$.appeal_id') AS INTEGER)
    JOIN claims c ON c.id = ap.claim_id
    WHERE a.org_id = ? AND a.kind = 'draft_appeal' AND a.status = 'executed' AND a.result IS NOT NULL
      AND (ap.status = 'won' OR (c.status = 'paid' AND c.paid_amount > 0))
  `).get(orgId);

  return {
    recovered_via_agent_appeals: { amount: round2(recovered.amt), appeals: recovered.n },
    filing_risk_14d: { claims: risk.n, amount: round2(risk.amt) },
    expected_collections_30d: {
      amount: round2(expected),
      claims_with_estimate: covered,
      open_claims: open.length,
      sample_size: sampleTotal,
      label: labelFor(sampleTotal),
      note: 'Open A/R balances weighted by each payer\'s historical paid-rate in this workspace. An estimate, not a guarantee.',
    },
    denial_trend_watch: trendWatch,
    exception_backlog: { count: backlog.n, amount: round2(backlog.amt) },
  };
}

module.exports = {
  THIN_SAMPLE, ANGLE_MIN_SAMPLE, labelFor, appealOverturn, bestAngle, payLikelihood, filingRisk,
  predictionForClaim, predictionsForClaimIds, insights, cptFamily,
};
