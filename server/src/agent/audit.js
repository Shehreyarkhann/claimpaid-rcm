'use strict';
// Deadline audit (agent Phase 5, WS5) — the sales wedge. Answers one
// question with the org's own numbers: how much money dies at a filing
// deadline in the next 14 / 30 / 60 days if nobody works it?
//
// Workspace mode reads live claims through the same filing-rule join
// every other deadline surface uses. CSV mode reuses the import
// wizard's preview machinery (same mapping + validation) and computes
// from those rows WITHOUT committing anything — the audited practice
// keeps its data; the rows live only inside the audit result.
// Every run is persisted in agent_audits so it can be reopened and
// shared in-app (and printed as the pilot leave-behind).
const { db } = require('../db');
const { FILING_SELECT, FILING_JOIN } = require('../routes/filing');
const importWizard = require('./importWizard');

function bucketize(items) {
  const horizons = {
    d14: { days: 14, count: 0, amount: 0 },
    d30: { days: 30, count: 0, amount: 0 },
    d60: { days: 60, count: 0, amount: 0 },
  };
  const expired = { count: 0, amount: 0 };
  const byPayer = new Map();
  for (const it of items) {
    const bal = Math.round((it.balance || 0) * 100) / 100;
    if (it.days_left < 0) { expired.count += 1; expired.amount += bal; }
    if (it.days_left >= 0 && it.days_left <= 14) { horizons.d14.count += 1; horizons.d14.amount += bal; }
    if (it.days_left >= 0 && it.days_left <= 30) { horizons.d30.count += 1; horizons.d30.amount += bal; }
    if (it.days_left >= 0 && it.days_left <= 60) { horizons.d60.count += 1; horizons.d60.amount += bal; }
    if (it.days_left <= 60) {
      const key = it.payer || 'Unknown payer';
      const p = byPayer.get(key) || { payer: key, count: 0, amount: 0, earliest_days: it.days_left };
      p.count += 1; p.amount += bal;
      p.earliest_days = Math.min(p.earliest_days, it.days_left);
      byPayer.set(key, p);
    }
  }
  for (const h of Object.values(horizons)) h.amount = Math.round(h.amount * 100) / 100;
  expired.amount = Math.round(expired.amount * 100) / 100;
  const payers = [...byPayer.values()]
    .map((p) => ({ ...p, amount: Math.round(p.amount * 100) / 100 }))
    .sort((a, b) => b.amount - a.amount);
  const top = [...items]
    .filter((it) => it.days_left <= 60)
    .sort((a, b) => (a.days_left - b.days_left) || (b.balance - a.balance))
    .slice(0, 25);
  return { horizons, expired, by_payer: payers, top };
}

function workspaceItems(orgId) {
  return db.prepare(`
    SELECT * FROM (
      SELECT c.claim_number, c.patient_name, p.name AS payer, c.status,
        round(c.billed_amount - c.paid_amount, 2) AS balance,
        ${FILING_SELECT}
      FROM claims c ${FILING_JOIN} JOIN payers p ON p.id = c.payer_id
      WHERE c.org_id = ? AND c.status IN ('pending', 'in_ar', 'denied')
    ) WHERE days_until_filing <= 60
    ORDER BY days_until_filing ASC, balance DESC
  `).all(orgId).map((r) => ({
    claim_number: r.claim_number, patient: r.patient_name, payer: r.payer,
    status: r.status, balance: r.balance, deadline: r.filing_deadline, days_left: r.days_until_filing,
  }));
}

function daysBetweenIso(a, b) {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86400000);
}

function csvItems(orgId, preview) {
  const validation = JSON.parse(preview.validation || '{"rows":[]}');
  const { resolvePayerId } = require('../routes/claims');
  const today = new Date().toISOString().slice(0, 10);
  const items = [];
  let skipped = 0;
  for (const row of validation.rows) {
    const v = row.values || {};
    if (!v.claim_number || !v.service_date || v.billed_amount == null) { skipped += 1; continue; }
    let filingDays = 365;
    const payerId = v.payer ? resolvePayerId(orgId, v.payer) : null;
    if (payerId) {
      const rule = db.prepare('SELECT filing_days FROM payer_filing_rules WHERE org_id = ? AND payer_id = ?')
        .get(orgId, payerId);
      if (rule && rule.filing_days) filingDays = rule.filing_days;
    }
    // deadline = service_date + filingDays (calendar math on ISO dates)
    const svc = new Date(Date.parse(`${v.service_date}T00:00:00Z`));
    svc.setUTCDate(svc.getUTCDate() + filingDays);
    const deadline = svc.toISOString().slice(0, 10);
    items.push({
      claim_number: v.claim_number,
      patient: v.patient_name,
      payer: v.payer || 'Unknown payer',
      status: 'csv',
      balance: Math.round(((v.billed_amount || 0) - (v.paid_amount || 0)) * 100) / 100,
      deadline,
      days_left: daysBetweenIso(today, deadline),
    });
  }
  return { items, skipped };
}

function runAudit({ orgId, userId, source, previewId }) {
  const org = db.prepare('SELECT name FROM orgs WHERE id = ?').get(orgId);
  let items;
  let sourceLabel;
  let skippedRows = 0;
  if (source === 'csv') {
    const preview = importWizard.getPreview(previewId, orgId);
    if (!preview) { const e = new Error('Import preview not found — upload the CSV again.'); e.status = 404; throw e; }
    const out = csvItems(orgId, preview);
    items = out.items;
    skippedRows = out.skipped;
    sourceLabel = preview.filename || 'CSV file';
  } else {
    items = workspaceItems(orgId);
    sourceLabel = 'This workspace';
  }
  const { horizons, expired, by_payer, top } = bucketize(items);
  const result = {
    source,
    source_label: sourceLabel,
    workspace: org ? org.name : null,
    generated_at: new Date().toISOString(),
    horizons,
    expired,
    by_payer,
    top,
    audited_claims: items.length,
    skipped_rows: skippedRows,
  };
  const info = db.prepare(`
    INSERT INTO agent_audits (org_id, user_id, source, source_label, result) VALUES (?, ?, ?, ?, ?)
  `).run(orgId, userId, source, sourceLabel, JSON.stringify(result));
  return { id: Number(info.lastInsertRowid), created_at: new Date().toISOString(), result };
}

function serializeAudit(row) {
  if (!row) return null;
  let result = null;
  try { result = JSON.parse(row.result || 'null'); } catch { result = null; }
  return { id: row.id, source: row.source, source_label: row.source_label, created_at: row.created_at, result };
}

function listAudits(orgId, limit = 20) {
  return db.prepare('SELECT * FROM agent_audits WHERE org_id = ? ORDER BY id DESC LIMIT ?')
    .all(orgId, limit).map((row) => {
      const s = serializeAudit(row);
      return {
        id: s.id, source: s.source, source_label: s.source_label, created_at: s.created_at,
        horizons: s.result ? s.result.horizons : null,
        expired: s.result ? s.result.expired : null,
      };
    });
}

function getAudit(id, orgId) {
  const row = db.prepare('SELECT * FROM agent_audits WHERE id = ? AND org_id = ?').get(id, orgId);
  return serializeAudit(row);
}

module.exports = { runAudit, listAudits, getAudit, bucketize };
