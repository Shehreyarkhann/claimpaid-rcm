// Shared FK-safe workspace deletion. Used by DELETE /api/auth/orgs/:id and
// the super-admin DELETE /api/super/orgs/:id. Callers handle auth + response.

const { db } = require('./db');

// Every org-scoped table that must be wiped with the workspace.
const ORG_TABLES = [
  'claims', 'claim_activity', 'appeals', 'appeal_notes',
  'auth_requests', 'auth_notes', 'eligibility_checks',
  'payers', 'payer_filing_rules', 'payer_playbook',
  'appeal_letter_templates', 'audit_log',
  'custom_scrub_rules', 'rule_suggestions',
  'support_tickets',
];

function deleteOrg(orgId) {
  // Suspend FK enforcement for the wipe (PRAGMA is a no-op inside a txn, so set it outside)
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    for (const t of ORG_TABLES) {
      try { db.prepare(`DELETE FROM ${t} WHERE org_id = ?`).run(orgId); } catch {}
    }
    db.prepare('DELETE FROM user_orgs WHERE org_id = ?').run(orgId);
    db.prepare('DELETE FROM orgs WHERE id = ?').run(orgId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    db.exec('PRAGMA foreign_keys = ON');
    throw e;
  }
  db.exec('PRAGMA foreign_keys = ON');

  // Remove users left with no workspaces — but never orphan-delete the last superadmin
  const orphaned = db.prepare(
    `SELECT u.id FROM users u LEFT JOIN user_orgs m ON m.user_id = u.id WHERE m.user_id IS NULL`
  ).all();
  for (const o of orphaned) {
    const u = db.prepare('SELECT is_superadmin FROM users WHERE id = ?').get(o.id);
    if (u && u.is_superadmin === 1) {
      const n = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_superadmin = 1').get().n;
      if (n <= 1) continue;
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(o.id);
  }
}

module.exports = { deleteOrg, ORG_TABLES };
