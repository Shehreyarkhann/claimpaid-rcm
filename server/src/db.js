const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'rcm.db');
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');

function columnExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orgs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES orgs(id),
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'biller',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      claim_number TEXT NOT NULL,
      patient_name TEXT NOT NULL,
      payer_id INTEGER NOT NULL REFERENCES payers(id),
      service_date TEXT NOT NULL,
      billed_amount REAL NOT NULL,
      paid_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      denial_reason TEXT,
      days_in_ar INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS appeals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES orgs(id),
      claim_id INTEGER NOT NULL REFERENCES claims(id),
      assigned_to INTEGER REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'medium',
      follow_up_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS appeal_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appeal_id INTEGER NOT NULL REFERENCES appeals(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      note TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payer_filing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES orgs(id),
      payer_id INTEGER NOT NULL REFERENCES payers(id),
      filing_days INTEGER NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(org_id, payer_id)
    );

    CREATE TABLE IF NOT EXISTS payer_playbook (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES orgs(id),
      payer_id INTEGER REFERENCES payers(id),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS demo_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      company TEXT NOT NULL,
      phone TEXT,
      team_size TEXT,
      message TEXT,
      contacted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS claim_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES orgs(id),
      claim_id INTEGER NOT NULL REFERENCES claims(id),
      user_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_activity_claim ON claim_activity(claim_id);
    CREATE INDEX IF NOT EXISTS idx_activity_org ON claim_activity(org_id);

    CREATE TABLE IF NOT EXISTS auth_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES orgs(id),
      patient_name TEXT NOT NULL,
      payer_id INTEGER REFERENCES payers(id),
      provider TEXT,
      cpt_codes TEXT,
      icd_codes TEXT,
      units_requested INTEGER DEFAULT 1,
      service_date TEXT,
      requested_date TEXT,
      needed_by_date TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      auth_number TEXT,
      approved_units INTEGER,
      valid_from TEXT,
      valid_to TEXT,
      denial_reason TEXT,
      notes TEXT,
      assigned_to INTEGER REFERENCES users(id),
      linked_claim_id INTEGER REFERENCES claims(id),
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS auth_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES orgs(id),
      auth_id INTEGER NOT NULL REFERENCES auth_requests(id),
      user_id INTEGER REFERENCES users(id),
      note TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_auth_org ON auth_requests(org_id);
    CREATE INDEX IF NOT EXISTS idx_auth_status ON auth_requests(status);
    CREATE INDEX IF NOT EXISTS idx_auth_notes ON auth_notes(auth_id);

    CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pwreset_user ON password_resets(user_id);

    -- Scrubber fields on claims (added post-launch; ALTERs guarded below)
    -- cpt_codes, icd_codes, rendering_npi, rendering_provider

    CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);
    CREATE INDEX IF NOT EXISTS idx_claims_payer ON claims(payer_id);
    CREATE INDEX IF NOT EXISTS idx_claims_service_date ON claims(service_date);
    CREATE INDEX IF NOT EXISTS idx_appeals_claim ON appeals(claim_id);
    CREATE INDEX IF NOT EXISTS idx_appeals_status ON appeals(status);
  `);

  // --- Migrations for existing databases ---
  if (!columnExists('payers', 'org_id')) db.exec('ALTER TABLE payers ADD COLUMN org_id INTEGER REFERENCES orgs(id)');
  if (!columnExists('claims', 'org_id')) db.exec('ALTER TABLE claims ADD COLUMN org_id INTEGER REFERENCES orgs(id)');
  if (!columnExists('claims', 'last_touched_at')) db.exec('ALTER TABLE claims ADD COLUMN last_touched_at TEXT');
  // claim_number uniqueness is now per-org
  // (SQLite can't easily drop the old unique index; the app enforces per-org uniqueness)

  // Scrubber fields on claims
  if (!columnExists('claims', 'cpt_codes')) db.exec('ALTER TABLE claims ADD COLUMN cpt_codes TEXT');
  if (!columnExists('claims', 'icd_codes')) db.exec('ALTER TABLE claims ADD COLUMN icd_codes TEXT');
  if (!columnExists('claims', 'rendering_npi')) db.exec('ALTER TABLE claims ADD COLUMN rendering_npi TEXT');
  if (!columnExists('claims', 'rendering_provider')) db.exec('ALTER TABLE claims ADD COLUMN rendering_provider TEXT');
  if (!columnExists('claims', 'scrub_status')) db.exec("ALTER TABLE claims ADD COLUMN scrub_status TEXT DEFAULT 'unscreened'");
  if (!columnExists('claims', 'scrubbed_at')) db.exec('ALTER TABLE claims ADD COLUMN scrubbed_at TEXT');

  // Billing provider identity for 837 EDI (per org)
  if (!columnExists('orgs', 'billing_npi')) db.exec('ALTER TABLE orgs ADD COLUMN billing_npi TEXT');
  if (!columnExists('orgs', 'billing_tax_id')) db.exec('ALTER TABLE orgs ADD COLUMN billing_tax_id TEXT');
  if (!columnExists('orgs', 'billing_address')) db.exec('ALTER TABLE orgs ADD COLUMN billing_address TEXT');
  if (!columnExists('orgs', 'billing_city')) db.exec('ALTER TABLE orgs ADD COLUMN billing_city TEXT');
  if (!columnExists('orgs', 'billing_state')) db.exec('ALTER TABLE orgs ADD COLUMN billing_state TEXT');
  if (!columnExists('orgs', 'billing_zip')) db.exec('ALTER TABLE orgs ADD COLUMN billing_zip TEXT');
  if (!columnExists('orgs', 'billing_phone')) db.exec('ALTER TABLE orgs ADD COLUMN billing_phone TEXT');
  if (!columnExists('orgs', 'billing_email')) db.exec('ALTER TABLE orgs ADD COLUMN billing_email TEXT');

  // Stripe billing fields on orgs
  if (!columnExists('orgs', 'plan')) db.exec("ALTER TABLE orgs ADD COLUMN plan TEXT DEFAULT 'trial'");
  if (!columnExists('orgs', 'plan_status')) db.exec("ALTER TABLE orgs ADD COLUMN plan_status TEXT DEFAULT 'trialing'");
  if (!columnExists('orgs', 'stripe_customer_id')) db.exec('ALTER TABLE orgs ADD COLUMN stripe_customer_id TEXT');
  if (!columnExists('orgs', 'stripe_subscription_id')) db.exec('ALTER TABLE orgs ADD COLUMN stripe_subscription_id TEXT');
  if (!columnExists('orgs', 'current_period_end')) db.exec('ALTER TABLE orgs ADD COLUMN current_period_end TEXT');

  // HIPAA audit log — who accessed what PHI and when
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES orgs(id),
      user_id INTEGER REFERENCES users(id),
      user_email TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      resource_label TEXT,
      ip TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log(org_id);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
  `);

  // Eligibility verification log
  db.exec(`
    CREATE TABLE IF NOT EXISTS eligibility_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES orgs(id),
      patient_name TEXT NOT NULL,
      payer_id INTEGER REFERENCES payers(id),
      service_date TEXT,
      coverage_status TEXT NOT NULL DEFAULT 'unknown',
      verified_via TEXT,
      effective_date TEXT,
      term_date TEXT,
      copay REAL,
      deductible_remaining REAL,
      notes TEXT,
      checked_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_elig_org ON eligibility_checks(org_id);
    CREATE INDEX IF NOT EXISTS idx_elig_status ON eligibility_checks(coverage_status);
  `);

  // Custom appeal letter templates (per org, per denial category)
  db.exec(`
    CREATE TABLE IF NOT EXISTS appeal_letter_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES orgs(id),
      category TEXT NOT NULL,
      body TEXT NOT NULL,
      enclosures TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(org_id, category)
    );
    CREATE INDEX IF NOT EXISTS idx_letter_tpl_org ON appeal_letter_templates(org_id);
  `);

  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_org_number ON claims(org_id, claim_number)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_claims_org ON claims(org_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_payers_org ON payers(org_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_appeals_org ON appeals(org_id)');

  // Multi-workspace memberships: one login, many orgs
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_orgs (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'biller',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, org_id)
    );
  `);
  // Backfill: every existing user is a member of their own org
  db.exec(`
    INSERT OR IGNORE INTO user_orgs (user_id, org_id, role)
    SELECT id, org_id, role FROM users
  `);
}

// Thin wrapper so route code keeps working with .prepare().get()/.all()/.run()
function wrap(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        get: (...p) => stmt.get(...p),
        all: (...p) => stmt.all(...p),
        run: (...p) => stmt.run(...p),
      };
    },
    exec: (sql) => db.exec(sql),
  };
}

module.exports = { db: wrap(db), initSchema };
