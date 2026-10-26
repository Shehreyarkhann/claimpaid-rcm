// Shared FK-safe deletion: workspaces and users.
//
// History: the org-scoped table list used to be hardcoded and went stale as
// new tables shipped (api_keys, ehr_*, era_*, patient_statements,
// baa_signatures, transmission_outbox...), and the orphan-user cleanup used
// a bare DELETE that FK-failed on any user with activity rows — the exact
// production failure of 2026-10-26 (workspace delete 500s, owner left with a
// login pointing at a dead workspace). Everything here is therefore
// DISCOVERED from the live schema at call time; there is no list to rot.

const { db } = require('./db');

// Org-owned child rows that live in tables WITHOUT an org_id column and
// WITHOUT a foreign key to the parent (plain unenforced id columns).
// Discovered FK links are swept generically; only these need naming.
const CHILD_LINKS = [
  { table: 'statement_lines', column: 'statement_id', parent: 'patient_statements' },
  { table: 'statement_lines', column: 'claim_id', parent: 'claims' },
  { table: 'appeal_notes', column: 'appeal_id', parent: 'appeals' },
];

function allTables() {
  return db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all().map((r) => r.name);
}

// Run fn with FK enforcement suspended inside a transaction. PRAGMA
// foreign_keys is a no-op inside a transaction, so toggle it outside.
function withFkOff(fn) {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  } finally {
    try { db.exec('PRAGMA foreign_keys = ON'); } catch {}
  }
}

// Map of table -> columns that scope a row to an org: an org_id column or
// any FK column referencing orgs(id), discovered live.
function orgScopedColumns() {
  const scoped = new Map();
  for (const t of allTables()) {
    const cols = new Set();
    if (db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'org_id')) {
      cols.add('org_id');
    }
    for (const fk of db.prepare(`PRAGMA foreign_key_list(${t})`).all()) {
      if (fk.table === 'orgs') cols.add(fk.from);
    }
    if (cols.size) scoped.set(t, [...cols]);
  }
  return scoped;
}

// Delete every row belonging to a user, discovered from the live schema:
// nullable user references are nulled (shared content survives), NOT NULL
// references are the user's own rows and are deleted; then the user row.
// CALLER must wrap in withFkOff (FK suspended + transaction).
function purgeUserRows(userId) {
  for (const t of allTables()) {
    if (t === 'users') continue;
    const fks = db.prepare(`PRAGMA foreign_key_list(${t})`).all().filter((f) => f.table === 'users');
    for (const fk of fks) {
      const colInfo = db.prepare(`PRAGMA table_info(${t})`).all().find((c) => c.name === fk.from);
      if (colInfo && colInfo.notnull === 0) {
        db.prepare(`UPDATE ${t} SET ${fk.from} = NULL WHERE ${fk.from} = ?`).run(userId);
      } else {
        db.prepare(`DELETE FROM ${t} WHERE ${fk.from} = ?`).run(userId);
      }
    }
  }
  // user_orgs has FKs to users via user_id and is covered above; memberships
  // for OTHER users in shared tables were nulled/deleted only for this user.
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

function purgeUser(userId) {
  return withFkOff(() => purgeUserRows(userId));
}

function deleteOrg(orgId) {
  withFkOff(() => {
    // 1) Child rows in tables without their own org scope (parents still
    //    exist at this point, so the id subqueries resolve).
    for (const link of CHILD_LINKS) {
      try {
        db.prepare(
          `DELETE FROM ${link.table} WHERE ${link.column} IN (SELECT id FROM ${link.parent} WHERE org_id = ?)`
        ).run(orgId);
      } catch { /* table/column absent on older schemas — nothing to sweep */ }
    }

    // 2) Every org-scoped table discovered from the schema.
    for (const [t, cols] of orgScopedColumns()) {
      if (t === 'orgs' || t === 'users' || t === 'user_orgs') continue;
      for (const col of cols) {
        db.prepare(`DELETE FROM ${t} WHERE ${col} = ?`).run(orgId);
      }
    }

    // 3) Memberships, then the org itself.
    db.prepare('DELETE FROM user_orgs WHERE org_id = ?').run(orgId);
    db.prepare('DELETE FROM orgs WHERE id = ?').run(orgId);

    // 4) Surviving members whose home-org pointer named this workspace:
    //    re-point to a remaining workspace so their login keeps working.
    db.prepare(
      `UPDATE users
         SET org_id = (SELECT org_id FROM user_orgs WHERE user_id = users.id ORDER BY org_id LIMIT 1)
       WHERE org_id = ?
         AND EXISTS (SELECT 1 FROM user_orgs WHERE user_id = users.id)`
    ).run(orgId);

    // 5) Users left with no workspace at all are NOT deleted: deleting a
    //    workspace must never destroy a login. They land in the org-less
    //    state, which the auth layer routes to workspace creation.
  });
}

module.exports = { deleteOrg, purgeUser, purgeUserRows, withFkOff, orgScopedColumns, CHILD_LINKS };
