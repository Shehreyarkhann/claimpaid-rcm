'use strict';
// Patient payment automation (deploy #106, Phase C).
//
// Two engines on top of the statements core (#50):
//
// 1) REMINDER CADENCES. Per-workspace settings (on/off + a day list like
//    "0,7,14,28") drive a sweep over sent statements (status open /
//    partially_paid). Day N fires when the statement's age since it was
//    sent reaches N. Dedupe is structural: one statement_reminders row
//    per (statement, step) with a UNIQUE constraint, and a sweep sends at
//    most ONE reminder per statement (the latest due step) — earlier
//    missed steps are recorded 'skipped' as superseded, never blasted.
//    Stop-on-paid is inherent: paid/void statements are outside the
//    sweep's status filter. EMAIL ONLY — no SMS provider has been chosen;
//    the settings row carries a channel column so a future channel is a
//    value, not a migration.
//
//    PHI RULE: reminder emails carry the statement number, balance, due
//    date and the pay link — amounts/dates/links only. No diagnoses, no
//    procedure codes, no claim detail, not even a patient-name greeting.
//
// 2) PAYMENT PLANS. A plan splits a statement's CURRENT balance into N
//    installments on a day cadence. Installment paid state is DERIVED
//    from the statement's recorded payments: syncPlanWithStatement()
//    runs after every recordPayment (manual, Payment Link webhook, and
//    the platform webhook all funnel through statements-core) and marks
//    installments paid in sequence as the cumulative paid amount covers
//    them. When the statement settles, the plan completes and any
//    still-scheduled installments are marked 'skipped'.
//
// AUTODEBIT: saved-card charging rides Stripe Connect, which the owner
// HELD on 2026-10-27 (featureFlags.statementPaymentsHeld). Nothing in
// this module charges a card; the routes keep every autodebit endpoint
// behind that same flag so un-holding is a flag flip only.
const { sendEmail, layout } = require('./email');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const DAY_MS = 86400000;
const ACTIVE_STMT = ['open', 'partially_paid'];

// ---------------------------------------------------------------- settings
function parseCadence(raw) {
  const days = String(raw == null ? '' : raw)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s));
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 365)) return null;
  return [...new Set(days)].sort((a, b) => a - b).slice(0, 10);
}

function getReminderSettings(db, orgId) {
  const row = db.prepare('SELECT * FROM statement_reminder_settings WHERE org_id = ?').get(orgId);
  if (!row) return { org_id: orgId, enabled: 0, cadence_days: '0,7,14,28', cadence: [0, 7, 14, 28], channel: 'email' };
  return { ...row, cadence: parseCadence(row.cadence_days) || [0, 7, 14, 28] };
}

function saveReminderSettings(db, orgId, { enabled, cadenceDays }) {
  const days = parseCadence(cadenceDays);
  if (!days) throw new Error('Cadence must be 1–10 whole days between 0 and 365, e.g. "0,7,14,28"');
  db.prepare(`
    INSERT INTO statement_reminder_settings (org_id, enabled, cadence_days, channel, updated_at)
    VALUES (?, ?, ?, 'email', datetime('now'))
    ON CONFLICT(org_id) DO UPDATE SET enabled = excluded.enabled,
      cadence_days = excluded.cadence_days, updated_at = datetime('now')
  `).run(orgId, enabled ? 1 : 0, days.join(','));
  return getReminderSettings(db, orgId);
}

// ---------------------------------------------------------------- reminders
function reminderEmail({ orgName, stmt, balance }) {
  const subject = `Payment reminder — statement ${stmt.statement_number}: balance $${balance.toFixed(2)}`;
  const lines = [
    `This is a reminder from ${orgName} about your patient statement ${stmt.statement_number}.`,
    '',
    `Balance due: $${balance.toFixed(2)}`,
    stmt.due_date ? `Due date: ${stmt.due_date}` : null,
    stmt.payment_link_url ? `\nPay online: ${stmt.payment_link_url}` : null,
    '',
    'If you have already paid, please disregard this reminder.',
    'Questions about this statement? Reply to this email or contact the practice billing office.',
  ].filter((l) => l !== null);
  const inner =
    `<h2 style="margin:0 0 12px;font-size:20px;color:#0f172a">Payment reminder</h2>` +
    `<p style="margin:0 0 8px">This is a reminder from ${orgName} about your patient statement <strong>${stmt.statement_number}</strong>.</p>` +
    `<p style="margin:0 0 4px">Balance due: <strong>$${balance.toFixed(2)}</strong></p>` +
    (stmt.due_date ? `<p style="margin:0 0 8px">Due date: ${stmt.due_date}</p>` : '') +
    (stmt.payment_link_url
      ? `<a href="${stmt.payment_link_url}" style="display:inline-block;background:#10B981;color:#ffffff;font-weight:700;padding:12px 26px;border-radius:12px;text-decoration:none;margin:14px 0">Pay online</a>`
      : '') +
    `<p style="margin:8px 0 0;color:#64748b;font-size:13px">If you have already paid, please disregard this reminder. Questions? Contact the practice billing office.</p>`;
  return { subject, text: lines.join('\n'), html: layout(inner, 'This is an automated payment reminder. It contains no medical information.') };
}

function recordReminder(db, { orgId, statementId, stepIndex, cadenceDay, recipient, status, detail }) {
  db.prepare(`
    INSERT OR IGNORE INTO statement_reminders
      (org_id, statement_id, step_index, cadence_day, channel, recipient, status, detail)
    VALUES (?, ?, ?, ?, 'email', ?, ?, ?)
  `).run(orgId, statementId, stepIndex, cadenceDay, recipient || null, status, detail || null);
}

// One sweep. `send` is injectable for tests; defaults to the real email
// service. Scoped to one org when orgOnly is set (the manual "run now"
// route), otherwise every org with reminders enabled (the scheduler).
async function runReminderSweep(db, { now = new Date(), orgOnly = null, send = null } = {}) {
  const sendFn = send || sendEmail;
  const settingsRows = orgOnly
    ? [getReminderSettings(db, orgOnly)].filter((s) => s.enabled)
    : db.prepare('SELECT * FROM statement_reminder_settings WHERE enabled = 1').all()
      .map((r) => ({ ...r, cadence: parseCadence(r.cadence_days) || [0, 7, 14, 28] }));
  const summary = { orgs: 0, sent: 0, skipped: 0, failed: 0 };
  for (const settings of settingsRows) {
    summary.orgs++;
    const org = db.prepare('SELECT name FROM orgs WHERE id = ?').get(settings.org_id) || {};
    const stmts = db.prepare(
      `SELECT * FROM patient_statements WHERE org_id = ? AND status IN ('open','partially_paid') ORDER BY id`
    ).all(settings.org_id);
    for (const stmt of stmts) {
      const balance = round2(stmt.amount_due - stmt.amount_paid);
      if (!(balance > 0.005)) continue; // stop-on-paid, belt and braces
      const anchor = new Date(String(stmt.sent_at || stmt.created_at).replace(' ', 'T') + 'Z');
      if (Number.isNaN(anchor.getTime())) continue;
      const ageDays = Math.floor((now.getTime() - anchor.getTime()) / DAY_MS);
      const done = new Set(
        db.prepare('SELECT step_index FROM statement_reminders WHERE statement_id = ?').all(stmt.id)
          .map((r) => r.step_index)
      );
      const dueSteps = settings.cadence
        .map((day, idx) => ({ day, idx }))
        .filter((s) => s.day <= ageDays && !done.has(s.idx));
      if (!dueSteps.length) continue;
      const latest = dueSteps[dueSteps.length - 1];
      // Missed earlier steps are recorded once, as superseded — the
      // patient gets the current reminder, not a burst of stale ones.
      for (const s of dueSteps.slice(0, -1)) {
        recordReminder(db, {
          orgId: settings.org_id, statementId: stmt.id, stepIndex: s.idx, cadenceDay: s.day,
          recipient: stmt.patient_email || null, status: 'skipped', detail: 'Superseded by a later cadence step',
        });
        summary.skipped++;
      }
      if (!stmt.patient_email) {
        recordReminder(db, {
          orgId: settings.org_id, statementId: stmt.id, stepIndex: latest.idx, cadenceDay: latest.day,
          recipient: null, status: 'skipped', detail: 'No patient email on file for this statement',
        });
        summary.skipped++;
        continue;
      }
      const mail = reminderEmail({ orgName: org.name || 'Your practice', stmt, balance });
      try {
        await sendFn({ to: stmt.patient_email, subject: mail.subject, text: mail.text, html: mail.html });
        recordReminder(db, {
          orgId: settings.org_id, statementId: stmt.id, stepIndex: latest.idx, cadenceDay: latest.day,
          recipient: stmt.patient_email, status: 'sent', detail: `Balance $${balance.toFixed(2)} at day ${latest.day}`,
        });
        summary.sent++;
      } catch (e) {
        recordReminder(db, {
          orgId: settings.org_id, statementId: stmt.id, stepIndex: latest.idx, cadenceDay: latest.day,
          recipient: stmt.patient_email, status: 'failed', detail: String(e.message || e).slice(0, 200),
        });
        summary.failed++;
      }
    }
  }
  return summary;
}

function listReminders(db, orgId, statementId) {
  return db.prepare(
    'SELECT * FROM statement_reminders WHERE org_id = ? AND statement_id = ? ORDER BY step_index, id'
  ).all(orgId, statementId);
}

// ------------------------------------------------------------------- plans
function createPaymentPlan(db, { orgId, userId, statementId, installments, frequencyDays, startDate }) {
  const stmt = db.prepare('SELECT * FROM patient_statements WHERE id = ? AND org_id = ?').get(statementId, orgId);
  if (!stmt) throw new Error('Statement not found');
  if (stmt.status === 'paid' || stmt.status === 'void') throw new Error(`Statement is ${stmt.status} — a plan needs an open balance`);
  const balance = round2(stmt.amount_due - stmt.amount_paid);
  if (!(balance > 0)) throw new Error('Statement has no balance to split');
  const n = Number(installments);
  if (!Number.isInteger(n) || n < 2 || n > 24) throw new Error('Installments must be a whole number between 2 and 24');
  const freq = frequencyDays == null ? 30 : Number(frequencyDays);
  if (!Number.isInteger(freq) || freq < 7 || freq > 90) throw new Error('Installment frequency must be 7–90 days');
  const existing = db.prepare(
    "SELECT id FROM payment_plans WHERE org_id = ? AND statement_id = ? AND status = 'active'"
  ).get(orgId, statementId);
  if (existing) throw new Error('This statement already has an active payment plan — cancel it before creating another');
  const start = startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)
    ? startDate
    : new Date().toISOString().slice(0, 10);
  const base = Math.floor((balance / n) * 100) / 100;
  const info = db.prepare(`
    INSERT INTO payment_plans (org_id, statement_id, total_amount, installments_count, installment_amount, frequency_days, start_date, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(orgId, statementId, balance, n, base, freq, start, userId || null);
  const planId = Number(info.lastInsertRowid);
  const ins = db.prepare(`
    INSERT INTO payment_plan_installments (plan_id, org_id, seq, due_date, amount, status)
    VALUES (?, ?, ?, ?, ?, 'scheduled')
  `);
  let allocated = 0;
  for (let i = 0; i < n; i++) {
    const amount = i === n - 1 ? round2(balance - allocated) : base;
    allocated = round2(allocated + amount);
    const due = new Date(new Date(`${start}T00:00:00Z`).getTime() + i * freq * DAY_MS).toISOString().slice(0, 10);
    ins.run(planId, orgId, i + 1, due, amount);
  }
  return getPlan(db, orgId, planId);
}

function getPlan(db, orgId, planId) {
  const plan = db.prepare(`
    SELECT pp.*, ps.statement_number, ps.patient_name,
      (ps.amount_due - ps.amount_paid) AS statement_balance, ps.status AS statement_status
    FROM payment_plans pp JOIN patient_statements ps ON ps.id = pp.statement_id
    WHERE pp.id = ? AND pp.org_id = ?
  `).get(planId, orgId);
  if (!plan) return null;
  plan.installments = db.prepare(
    'SELECT * FROM payment_plan_installments WHERE plan_id = ? ORDER BY seq'
  ).all(planId);
  plan.paid_installments = plan.installments.filter((i) => i.status === 'paid').length;
  return plan;
}

function listPlans(db, orgId, statementId = null) {
  const rows = statementId
    ? db.prepare('SELECT id FROM payment_plans WHERE org_id = ? AND statement_id = ? ORDER BY id DESC').all(orgId, statementId)
    : db.prepare('SELECT id FROM payment_plans WHERE org_id = ? ORDER BY id DESC LIMIT 200').all(orgId);
  return rows.map((r) => getPlan(db, orgId, r.id)).filter(Boolean);
}

function cancelPlan(db, orgId, planId) {
  const plan = db.prepare('SELECT * FROM payment_plans WHERE id = ? AND org_id = ?').get(planId, orgId);
  if (!plan) throw new Error('Payment plan not found');
  if (plan.status !== 'active') throw new Error(`Plan is already ${plan.status}`);
  db.prepare("UPDATE payment_plans SET status = 'cancelled' WHERE id = ?").run(planId);
  db.prepare("UPDATE payment_plan_installments SET status = 'cancelled' WHERE plan_id = ? AND status = 'scheduled'").run(planId);
  return getPlan(db, orgId, planId);
}

// Derive installment state from the statement's recorded payments.
// Runs after every recordPayment; fully idempotent (recomputes from
// amount_paid each time, only ever moves installments forward).
function syncPlanWithStatement(db, statementId) {
  const stmt = db.prepare('SELECT * FROM patient_statements WHERE id = ?').get(statementId);
  if (!stmt) return;
  const plans = db.prepare(
    "SELECT * FROM payment_plans WHERE statement_id = ? AND status = 'active'"
  ).all(statementId);
  for (const plan of plans) {
    const installments = db.prepare(
      'SELECT * FROM payment_plan_installments WHERE plan_id = ? ORDER BY seq'
    ).all(plan.id);
    // The plan was cut from the balance at creation; payments recorded
    // BEFORE the plan existed already reduced that balance, so coverage
    // is measured from the paid amount beyond the pre-plan baseline.
    const baselinePaid = round2(stmt.amount_due - plan.total_amount);
    let covered = round2(stmt.amount_paid - baselinePaid);
    for (const inst of installments) {
      if (inst.status === 'paid') { covered = round2(covered - inst.amount); continue; }
      if (inst.status !== 'scheduled') continue;
      if (covered >= inst.amount - 0.005) {
        db.prepare("UPDATE payment_plan_installments SET status = 'paid', paid_at = datetime('now') WHERE id = ?")
          .run(inst.id);
        covered = round2(covered - inst.amount);
      }
    }
    if (stmt.status === 'paid') {
      db.prepare("UPDATE payment_plan_installments SET status = 'skipped' WHERE plan_id = ? AND status = 'scheduled'").run(plan.id);
      db.prepare("UPDATE payment_plans SET status = 'completed' WHERE id = ?").run(plan.id);
    }
  }
}

module.exports = {
  parseCadence, getReminderSettings, saveReminderSettings,
  runReminderSweep, listReminders, reminderEmail,
  createPaymentPlan, getPlan, listPlans, cancelPlan, syncPlanWithStatement,
};
