'use strict';
// AI data analyst (deploy #106, Phase D) — natural-language questions over
// the ORG'S OWN claims/A/R data, answered by DETERMINISTIC queries.
//
// This is deliberately NOT a model writing SQL and NOT a model doing
// arithmetic. A question is matched to one of a fixed set of analyses;
// each analysis is a hand-written, org-scoped query; the answer, the
// chart and the summary sentence are all computed from its rows. If a
// question matches nothing, the endpoint says so and lists what it CAN
// answer — it never invents a number. READ-ONLY: no analysis writes.
//
// Every answer carries its scope: workspace name, period, the exact
// date basis, and n (the number of records behind it).
const { db } = require('../db');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `$${round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Valid period keys (labels + bounds come from periodRange below).
const PERIODS = {
  all: 'All time',
  this_quarter: 'This quarter',
  last_quarter: 'Last quarter',
  this_month: 'This month',
  last_90d: 'Last 90 days',
  this_year: 'This year',
};

// Quarter bounds are computed in JS (SQLite quarter math is unreadable
// and error-prone); every other period is a simple date clause.
function periodRange(period, now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const iso = (d) => d.toISOString().slice(0, 10);
  if (period === 'this_quarter') {
    const start = new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1));
    const end = new Date(Date.UTC(y, Math.floor(m / 3) * 3 + 3, 0));
    return { from: iso(start), to: iso(end), label: 'This quarter' };
  }
  if (period === 'last_quarter') {
    const start = new Date(Date.UTC(y, Math.floor(m / 3) * 3 - 3, 1));
    const end = new Date(Date.UTC(y, Math.floor(m / 3) * 3, 0));
    return { from: iso(start), to: iso(end), label: 'Last quarter' };
  }
  if (period === 'this_month') return { from: iso(new Date(Date.UTC(y, m, 1))), to: null, label: 'This month' };
  if (period === 'last_90d') return { from: iso(new Date(now.getTime() - 90 * 86400000)), to: null, label: 'Last 90 days' };
  if (period === 'this_year') return { from: `${y}-01-01`, to: null, label: 'This year' };
  return { from: null, to: null, label: 'All time' };
}

function dateFilter(col, range) {
  const clauses = [];
  const params = [];
  if (range.from) { clauses.push(`${col} >= ?`); params.push(range.from); }
  if (range.to) { clauses.push(`${col} <= ?`); params.push(range.to); }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
}

const OPEN_STATUSES = ['pending', 'in_ar', 'denied'];

// ------------------------------------------------------------- analyses
function topDenialReasons(orgId, period) {
  const range = periodRange(period);
  const f = dateFilter('c.service_date', range);
  const rows = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(c.denial_reason), ''), '(no reason recorded)') AS label,
      COUNT(*) AS claims, COALESCE(SUM(c.billed_amount), 0) AS billed
    FROM claims c
    WHERE c.org_id = ? AND c.status = 'denied'${f.sql}
    GROUP BY label ORDER BY claims DESC, billed DESC LIMIT 15
  `).all(orgId, ...f.params);
  const n = rows.reduce((s, r) => s + r.claims, 0);
  return {
    analysis: 'top_denial_reasons',
    title: 'Top denial reasons',
    basis: 'Denied claims by denial reason, on service date',
    range, n,
    columns: [
      { key: 'label', label: 'Denial reason' },
      { key: 'claims', label: 'Claims', format: 'count' },
      { key: 'billed', label: 'Billed', format: 'money' },
    ],
    rows,
    chart: { value_key: 'claims', format: 'count', bars: rows.slice(0, 8).map((r) => ({ label: r.label, value: r.claims })) },
    summary: rows.length
      ? `${rows[0].label} is the top denial reason — ${rows[0].claims} of ${n} denied claims (${money(rows[0].billed)} billed).`
      : 'No denied claims in this period.',
  };
}

function arAgingByPayer(orgId) {
  const rows = db.prepare(`
    SELECT p.name AS label,
      COUNT(*) AS claims,
      COALESCE(SUM(c.billed_amount - c.paid_amount), 0) AS total,
      COALESCE(SUM(CASE WHEN julianday('now') - julianday(c.service_date) <= 30 THEN c.billed_amount - c.paid_amount ELSE 0 END), 0) AS b0_30,
      COALESCE(SUM(CASE WHEN julianday('now') - julianday(c.service_date) BETWEEN 31 AND 60 THEN c.billed_amount - c.paid_amount ELSE 0 END), 0) AS b31_60,
      COALESCE(SUM(CASE WHEN julianday('now') - julianday(c.service_date) BETWEEN 61 AND 90 THEN c.billed_amount - c.paid_amount ELSE 0 END), 0) AS b61_90,
      COALESCE(SUM(CASE WHEN julianday('now') - julianday(c.service_date) > 90 THEN c.billed_amount - c.paid_amount ELSE 0 END), 0) AS over_90
    FROM claims c JOIN payers p ON p.id = c.payer_id
    WHERE c.org_id = ? AND c.status IN (${OPEN_STATUSES.map(() => '?').join(',')})
      AND (c.billed_amount - c.paid_amount) > 0.005
    GROUP BY p.id, p.name ORDER BY over_90 DESC, total DESC
  `).all(orgId, ...OPEN_STATUSES);
  const n = rows.reduce((s, r) => s + r.claims, 0);
  const over90 = round2(rows.reduce((s, r) => s + r.over_90, 0));
  return {
    analysis: 'ar_aging_by_payer',
    title: 'A/R aging by payer',
    basis: 'Open claims (pending, in A/R, denied) with a balance, aged from service date',
    range: periodRange('all'), n,
    columns: [
      { key: 'label', label: 'Payer' },
      { key: 'total', label: 'Total A/R', format: 'money' },
      { key: 'b0_30', label: '0–30', format: 'money' },
      { key: 'b31_60', label: '31–60', format: 'money' },
      { key: 'b61_90', label: '61–90', format: 'money' },
      { key: 'over_90', label: 'Over 90', format: 'money' },
    ],
    rows,
    chart: { value_key: 'over_90', format: 'money', bars: rows.slice(0, 8).map((r) => ({ label: r.label, value: round2(r.over_90) })) },
    summary: rows.length
      ? `${money(over90)} of open A/R is over 90 days old${rows[0].over_90 > 0 ? ` — ${rows[0].label} holds the most of it (${money(rows[0].over_90)})` : ''}.`
      : 'No open A/R with a balance right now.',
  };
}

function denialRateByPayer(orgId, period) {
  const range = periodRange(period);
  const f = dateFilter('c.service_date', range);
  const rows = db.prepare(`
    SELECT p.name AS label, COUNT(*) AS claims,
      SUM(CASE WHEN c.status = 'denied' THEN 1 ELSE 0 END) AS denied
    FROM claims c JOIN payers p ON p.id = c.payer_id
    WHERE c.org_id = ?${f.sql}
    GROUP BY p.id, p.name HAVING claims > 0 ORDER BY claims DESC
  `).all(orgId, ...f.params).map((r) => ({ ...r, rate: r.claims ? Math.round((r.denied / r.claims) * 1000) / 10 : 0 }));
  rows.sort((a, b) => b.rate - a.rate);
  const n = rows.reduce((s, r) => s + r.claims, 0);
  const worst = rows.find((r) => r.claims >= 5) || rows[0];
  return {
    analysis: 'denial_rate_by_payer',
    title: 'Denial rate by payer',
    basis: 'Share of claims currently in denied status, on service date',
    range, n,
    columns: [
      { key: 'label', label: 'Payer' },
      { key: 'claims', label: 'Claims', format: 'count' },
      { key: 'denied', label: 'Denied', format: 'count' },
      { key: 'rate', label: 'Denial rate', format: 'pct' },
    ],
    rows,
    chart: { value_key: 'rate', format: 'pct', bars: rows.slice(0, 8).map((r) => ({ label: r.label, value: r.rate })) },
    summary: worst
      ? `${worst.label} has the highest denial rate at ${worst.rate}% (${worst.denied} of ${worst.claims} claims).`
      : 'No claims in this period.',
  };
}

function payerTurnaround(orgId, period) {
  const range = periodRange(period);
  const f = dateFilter('c.service_date', range);
  const rows = db.prepare(`
    SELECT p.name AS label, COUNT(*) AS decided,
      ROUND(AVG(julianday(date(c.last_touched_at)) - julianday(date(c.created_at))), 1) AS avg_days,
      SUM(CASE WHEN c.status = 'denied' THEN 1 ELSE 0 END) AS denied,
      SUM(CASE WHEN c.status = 'paid' THEN 1 ELSE 0 END) AS paid
    FROM claims c JOIN payers p ON p.id = c.payer_id
    WHERE c.org_id = ? AND c.status IN ('paid', 'denied') AND c.last_touched_at IS NOT NULL${f.sql}
    GROUP BY p.id, p.name HAVING decided > 0 ORDER BY avg_days ASC
  `).all(orgId, ...f.params);
  const n = rows.reduce((s, r) => s + r.decided, 0);
  return {
    analysis: 'payer_turnaround',
    title: 'Payer decision turnaround',
    basis: 'Decided claims (paid or denied): average days from claim entry to its last recorded activity (ERA posting stamps this on status change). An approximation from claim timestamps, labeled as such',
    range, n,
    columns: [
      { key: 'label', label: 'Payer' },
      { key: 'decided', label: 'Decided', format: 'count' },
      { key: 'avg_days', label: 'Avg days to decision', format: 'days' },
      { key: 'denied', label: 'Denied', format: 'count' },
      { key: 'paid', label: 'Paid', format: 'count' },
    ],
    rows,
    chart: { value_key: 'avg_days', format: 'days', bars: rows.slice(0, 8).map((r) => ({ label: r.label, value: r.avg_days })) },
    summary: rows.length
      ? `${rows[0].label} decides fastest at ${rows[0].avg_days} days on average (n=${rows[0].decided}); ${rows[rows.length - 1].label} is slowest at ${rows[rows.length - 1].avg_days} days (n=${rows[rows.length - 1].decided}).`
      : 'No decided claims in this period.',
  };
}

function collectionsByMonth(orgId) {
  const rows = db.prepare(`
    SELECT strftime('%Y-%m', l.posted_at) AS label,
      COUNT(*) AS lines, COALESCE(SUM(l.paid), 0) AS collected
    FROM era_claim_lines l
    WHERE l.org_id = ? AND l.post_status = 'posted' AND l.posted_at >= date('now', 'start of month', '-5 months')
    GROUP BY label ORDER BY label ASC
  `).all(orgId);
  const n = rows.reduce((s, r) => s + r.lines, 0);
  const total = round2(rows.reduce((s, r) => s + r.collected, 0));
  return {
    analysis: 'collections_by_month',
    title: 'Collections posted by month',
    basis: 'ERA lines actually posted in the last 6 months, by posting month',
    range: periodRange('all'), n,
    columns: [
      { key: 'label', label: 'Month' },
      { key: 'lines', label: 'Lines posted', format: 'count' },
      { key: 'collected', label: 'Collected', format: 'money' },
    ],
    rows,
    chart: { value_key: 'collected', format: 'money', bars: rows.map((r) => ({ label: r.label, value: round2(r.collected) })) },
    summary: rows.length
      ? `${money(total)} collected across ${n} posted ERA lines in the last 6 months.`
      : 'No ERA lines have posted in the last 6 months.',
  };
}

const ANALYSES = {
  top_denial_reasons: (orgId, period) => topDenialReasons(orgId, period),
  ar_aging_by_payer: (orgId) => arAgingByPayer(orgId),
  denial_rate_by_payer: (orgId, period) => denialRateByPayer(orgId, period),
  payer_turnaround: (orgId, period) => payerTurnaround(orgId, period),
  collections_by_month: (orgId) => collectionsByMonth(orgId),
};

const SUGGESTIONS = [
  { label: 'Which payer denies fastest?', analysis: 'payer_turnaround', period: 'all' },
  { label: 'A/R over 90 by payer', analysis: 'ar_aging_by_payer', period: 'all' },
  { label: 'Top denial reasons this quarter', analysis: 'top_denial_reasons', period: 'this_quarter' },
  { label: 'Denial rate by payer', analysis: 'denial_rate_by_payer', period: 'all' },
  { label: 'Collections by month', analysis: 'collections_by_month', period: 'all' },
  { label: 'Top denial reasons, all time', analysis: 'top_denial_reasons', period: 'all' },
];

// Keyword matcher for free-text questions. Deliberately narrow: a
// question that doesn't clearly map to an analysis gets "no match" and
// the supported list — never a guessed analysis presented as an answer.
function matchQuestion(question) {
  const q = String(question || '').toLowerCase();
  if (!q.trim()) return null;
  let period = 'all';
  if (/this quarter/.test(q)) period = 'this_quarter';
  else if (/last quarter/.test(q)) period = 'last_quarter';
  else if (/this month/.test(q)) period = 'this_month';
  else if (/last 90|past 90/.test(q)) period = 'last_90d';
  else if (/this year/.test(q)) period = 'this_year';
  if (/denies fastest|deny fastest|fastest.*den|turnaround|slowest|decision time|how fast/.test(q)) return { analysis: 'payer_turnaround', period };
  if (/over 90|aging|ageing|a\/?r by payer|oldest a\/?r|ar aging/.test(q)) return { analysis: 'ar_aging_by_payer', period: 'all' };
  if (/denial rate|deny rate|denied the most|denies (the )?most/.test(q)) return { analysis: 'denial_rate_by_payer', period };
  if (/collection|collected|posted.*month|revenue by month/.test(q)) return { analysis: 'collections_by_month', period: 'all' };
  if (/denial reason|denied for|why.*denied|top denial/.test(q)) return { analysis: 'top_denial_reasons', period };
  return null;
}

function runAnalysis(orgId, { analysis, period }) {
  const fn = ANALYSES[analysis];
  if (!fn) return null;
  const org = db.prepare('SELECT name FROM orgs WHERE id = ?').get(orgId);
  const result = fn(orgId, PERIODS[period] ? period : 'all');
  return {
    ...result,
    scope: {
      workspace: org ? org.name : null,
      period: result.range.label,
      from: result.range.from,
      to: result.range.to,
      n: result.n,
      basis: result.basis,
    },
  };
}

module.exports = { ANALYSES, PERIODS, SUGGESTIONS, matchQuestion, runAnalysis, periodRange };
