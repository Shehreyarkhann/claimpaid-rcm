// wipe-prod.cjs — reset the production RCM database to a clean slate:
// every organization and every user EXCEPT the super-admin login.
// Default is a DRY RUN (report only). Execute with: node wipe-prod.cjs --confirm
//
// Preserved by design:
//   - the super-admin user row (sessions killed via token_version bump)
//   - data_migrations rows (applied-migration bookkeeping — wiping them
//     would re-run data migrations on next boot)
//   - edi_control_numbers (EDI control numbers must stay monotonic)
// sqlite_sequence is left alone so new ids never collide with ids the AI
// database may still reference.
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const CONFIRM = process.argv.includes('--confirm');
const DB_PATH = process.env.DB_PATH || '/opt/claimpaid-rcm/server/rcm.db';

function superadminEmail() {
  if (process.env.SUPERADMIN_EMAIL) return process.env.SUPERADMIN_EMAIL.trim().toLowerCase();
  try {
    const env = fs.readFileSync('/opt/claimpaid-rcm/server/.env', 'utf8');
    const m = env.match(/^SUPERADMIN_EMAIL=(.+)$/m);
    if (m) return m[1].trim().toLowerCase();
  } catch {}
  return 'shehreyarkhann@outlook.com';
}
const KEEPER = superadminEmail();
const KEEP_TABLES = new Set(['data_migrations', 'edi_control_numbers', 'users']);

const db = new DatabaseSync(DB_PATH);
const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map((r) => r.name);

const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
const keeper = db.prepare('SELECT id, email FROM users WHERE LOWER(email) = LOWER(?)').get(KEEPER);
if (!keeper) {
  console.log(`ABORT: super-admin user (${KEEPER}) not found in ${DB_PATH} — nothing touched.`);
  process.exit(1);
}

console.log(`Database: ${DB_PATH}`);
console.log(`Mode: ${CONFIRM ? 'EXECUTE' : 'DRY RUN (report only)'}`);
console.log(`Keeper: user #${keeper.id} <${keeper.email}>`);
console.log('\nRow counts BEFORE:');
let total = 0;
for (const t of tables) { const n = count(t); total += n; console.log(`  ${t.padEnd(28)} ${n}`); }
console.log(`  ${'TOTAL'.padEnd(28)} ${total}`);
const otherUsers = db.prepare('SELECT COUNT(*) c FROM users WHERE LOWER(email) != LOWER(?)').get(KEEPER).c;
console.log(`\nWill delete: ${otherUsers} user(s), ALL organizations, and every row outside the keep list.`);

if (!CONFIRM) {
  console.log('\nDRY RUN — nothing changed. Re-run with --confirm to execute.');
  process.exit(0);
}

db.exec('PRAGMA foreign_keys = OFF');
try {
  db.exec('BEGIN');
  for (const t of tables) {
    if (KEEP_TABLES.has(t)) continue;
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare('DELETE FROM users WHERE LOWER(email) != LOWER(?)').run(KEEPER);
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (userCols.includes('token_version')) {
    db.prepare('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = ?').run(keeper.id);
  }
  db.exec('COMMIT');
} catch (e) {
  try { db.exec('ROLLBACK'); } catch {}
  console.log('WIPE FAILED, rolled back:', e.message);
  process.exit(1);
} finally {
  try { db.exec('PRAGMA foreign_keys = ON'); } catch {}
}
db.exec('VACUUM');

console.log('\nRow counts AFTER:');
for (const t of tables) console.log(`  ${t.padEnd(28)} ${count(t)}`);
console.log('\nWIPE COMPLETE. The super-admin logs in fresh and creates a new workspace.');
