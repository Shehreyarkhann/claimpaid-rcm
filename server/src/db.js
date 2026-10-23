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
  if (!columnExists('users', 'failed_attempts')) db.exec('ALTER TABLE users ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0');
  if (!columnExists('users', 'locked_until')) db.exec('ALTER TABLE users ADD COLUMN locked_until TEXT');
  if (!columnExists('users', 'email_verified')) db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
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
  if (!columnExists('claims', 'readiness_score')) db.exec('ALTER TABLE claims ADD COLUMN readiness_score INTEGER');

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
  // Super-admin: subscription set to cancel at Stripe period end
  if (!columnExists('orgs', 'stripe_cancel_at_period_end')) db.exec('ALTER TABLE orgs ADD COLUMN stripe_cancel_at_period_end INTEGER NOT NULL DEFAULT 0');

  // Onboarding funnel + real 30-day trials
  if (!columnExists('orgs', 'onboarding_completed_at')) db.exec('ALTER TABLE orgs ADD COLUMN onboarding_completed_at TEXT');
  if (!columnExists('orgs', 'onboarding_data')) db.exec('ALTER TABLE orgs ADD COLUMN onboarding_data TEXT');
  if (!columnExists('orgs', 'trial_started_at')) db.exec('ALTER TABLE orgs ADD COLUMN trial_started_at TEXT');
  if (!columnExists('orgs', 'trial_ends_at')) db.exec('ALTER TABLE orgs ADD COLUMN trial_ends_at TEXT');
  // Backfill: existing paying customers and the demo org skip the onboarding funnel
  db.exec(`UPDATE orgs SET onboarding_completed_at = datetime('now') WHERE onboarding_completed_at IS NULL
           AND (stripe_subscription_id IS NOT NULL OR name = 'Demo Billing Co.')`);

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

  // Auth hardening: fixed-window rate limit buckets + auth security events
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_rate_limits (
      rl_key TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      window_start_ms INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (rl_key, endpoint)
    );
    CREATE TABLE IF NOT EXISTS auth_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      email TEXT,
      ip TEXT,
      event TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_authevents_event ON auth_events(event, created_at);
    CREATE INDEX IF NOT EXISTS idx_authevents_user ON auth_events(user_id);
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

  // Denial-to-rule feedback loop: learned scrub rules + pending suggestions
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_scrub_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES orgs(id),
      name TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('error','warning')),
      payer_id INTEGER REFERENCES payers(id),
      cpt_code TEXT,
      icd_code TEXT,
      message TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('suggestion','manual')),
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_custom_rules_org ON custom_scrub_rules(org_id);

    CREATE TABLE IF NOT EXISTS rule_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES orgs(id),
      payer_id INTEGER REFERENCES payers(id),
      denial_reason TEXT,
      cpt_code TEXT,
      icd_code TEXT,
      occurrences INTEGER NOT NULL DEFAULT 0,
      first_seen TEXT,
      last_seen TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','dismissed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rule_sugg_org ON rule_suggestions(org_id);
  `);

  // Super-admin support
  if (!columnExists('users', 'is_superadmin')) db.exec('ALTER TABLE users ADD COLUMN is_superadmin INTEGER NOT NULL DEFAULT 0');
  if (!columnExists('demo_requests', 'notes')) db.exec('ALTER TABLE demo_requests ADD COLUMN notes TEXT DEFAULT \'\'');  db.exec(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER REFERENCES orgs(id),
      user_id INTEGER REFERENCES users(id),
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      internal_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status);
  `);

  // Two-way helpdesk: staff<->customer replies
  db.exec(`
    CREATE TABLE IF NOT EXISTS support_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
      author_type TEXT NOT NULL CHECK (author_type IN ('staff','customer')),
      author_user_id INTEGER REFERENCES users(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_replies_ticket ON support_replies(ticket_id);
  `);

  // Extend support_tickets: 'pending' status + SLA/priority tracking.
  // SQLite cannot ALTER a CHECK constraint, so rebuild the table once (idempotent via column probe).
  if (!columnExists('support_tickets', 'sla_due_at')) {
    db.exec(`
      CREATE TABLE support_tickets_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id INTEGER REFERENCES orgs(id),
        user_id INTEGER REFERENCES users(id),
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        subject TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','closed')),
        internal_note TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
        first_response_at TEXT,
        last_activity_at TEXT,
        sla_due_at TEXT,
        customer_last_seen_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO support_tickets_new
        (id, org_id, user_id, name, email, subject, message, status, internal_note, created_at, updated_at, last_activity_at)
        SELECT id, org_id, user_id, name, email, subject, message, status, internal_note, created_at, updated_at, updated_at
        FROM support_tickets;
      DROP TABLE support_tickets;
      ALTER TABLE support_tickets_new RENAME TO support_tickets;
      CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status);
      UPDATE support_tickets SET sla_due_at = datetime(created_at, '+24 hours') WHERE sla_due_at IS NULL;
    `);
  }

  // BAA (HIPAA) electronic signatures — one per org per version
  db.exec(`
    CREATE TABLE IF NOT EXISTS baa_signatures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES orgs(id),
      org_legal_name TEXT NOT NULL,
      signed_by_name TEXT NOT NULL,
      signed_by_title TEXT,
      signed_by_email TEXT NOT NULL,
      signed_at TEXT NOT NULL,
      ip_address TEXT,
      baa_version TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(org_id)
    );
    CREATE INDEX IF NOT EXISTS idx_baa_org ON baa_signatures(org_id);
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
    WHERE EXISTS (SELECT 1 FROM orgs WHERE orgs.id = users.org_id)
  `);

  // Real-time eligibility lookups (270/271-style vendor responses).
  // Separate from eligibility_checks, which is the manual verification log (portal/phone).
  db.exec(`
    CREATE TABLE IF NOT EXISTS eligibility_lookups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES orgs(id),
      patient_first TEXT NOT NULL,
      patient_last TEXT NOT NULL,
      dob TEXT NOT NULL,
      member_id TEXT NOT NULL,
      payer TEXT NOT NULL,
      date_of_service TEXT NOT NULL,
      vendor TEXT NOT NULL DEFAULT 'demo',
      coverage_active INTEGER,
      plan_name TEXT,
      plan_type TEXT,
      group_number TEXT,
      copay_primary REAL,
      copay_specialist REAL,
      deductible_individual REAL,
      deductible_remaining REAL,
      oop_max REAL,
      effective_date TEXT,
      term_date TEXT,
      raw_request TEXT,
      raw_response TEXT,
      checked_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_eliglookups_org ON eligibility_lookups(org_id, created_at);
  `);

  // Eligibility vendor config on the org (same column pattern as the EDI settings).
  // NOTE (honest posture): these columns live in the same SQLite file as everything
  // else on the droplet, which is NOT encrypted at rest. API keys stored here are
  // protected by DB file permissions and app-level access control only — same as the
  // rest of the app. Rotate the key at the vendor if the DB file is ever exposed.
  if (!columnExists('orgs', 'eligibility_vendor')) db.exec("ALTER TABLE orgs ADD COLUMN eligibility_vendor TEXT NOT NULL DEFAULT 'demo'");
  if (!columnExists('orgs', 'eligibility_endpoint')) db.exec('ALTER TABLE orgs ADD COLUMN eligibility_endpoint TEXT');
  if (!columnExists('orgs', 'eligibility_api_key')) db.exec('ALTER TABLE orgs ADD COLUMN eligibility_api_key TEXT');
  if (!columnExists('orgs', 'eligibility_auth_scheme')) db.exec("ALTER TABLE orgs ADD COLUMN eligibility_auth_scheme TEXT NOT NULL DEFAULT 'Bearer'");

  // ---- Electronic claim transmission (837P batches) ----
  // Subscriber identity needed for valid 837P 2010BA loops.
  if (!columnExists('claims', 'patient_dob')) db.exec('ALTER TABLE claims ADD COLUMN patient_dob TEXT');
  if (!columnExists('claims', 'member_id')) db.exec('ALTER TABLE claims ADD COLUMN member_id TEXT');
  // Per-claim transmission state.
  if (!columnExists('claims', 'last_batch_id')) db.exec('ALTER TABLE claims ADD COLUMN last_batch_id INTEGER REFERENCES claim_batches(id)');
  if (!columnExists('claims', 'x12_status')) db.exec("ALTER TABLE claims ADD COLUMN x12_status TEXT NOT NULL DEFAULT 'not_sent'");

  // EDI envelope identity (extends the existing billing_* EDI columns).
  if (!columnExists('orgs', 'edi_submitter_id')) db.exec('ALTER TABLE orgs ADD COLUMN edi_submitter_id TEXT');
  if (!columnExists('orgs', 'edi_receiver_id')) db.exec('ALTER TABLE orgs ADD COLUMN edi_receiver_id TEXT');

  // Transmission vendor config on the org.
  // NOTE (honest posture): same as the eligibility keys — these columns live in
  // the droplet SQLite file, which is NOT encrypted at rest. SFTP passwords and
  // private keys stored here are protected by DB file permissions and app-level
  // access control only. Rotate credentials at the clearinghouse if the DB file
  // is ever exposed.
  if (!columnExists('orgs', 'xmit_vendor')) db.exec("ALTER TABLE orgs ADD COLUMN xmit_vendor TEXT NOT NULL DEFAULT 'manual'");
  if (!columnExists('orgs', 'xmit_sftp_host')) db.exec('ALTER TABLE orgs ADD COLUMN xmit_sftp_host TEXT');
  if (!columnExists('orgs', 'xmit_sftp_port')) db.exec('ALTER TABLE orgs ADD COLUMN xmit_sftp_port INTEGER');
  if (!columnExists('orgs', 'xmit_sftp_user')) db.exec('ALTER TABLE orgs ADD COLUMN xmit_sftp_user TEXT');
  if (!columnExists('orgs', 'xmit_sftp_auth')) db.exec("ALTER TABLE orgs ADD COLUMN xmit_sftp_auth TEXT NOT NULL DEFAULT 'password'");
  if (!columnExists('orgs', 'xmit_sftp_secret')) db.exec('ALTER TABLE orgs ADD COLUMN xmit_sftp_secret TEXT');
  if (!columnExists('orgs', 'xmit_sftp_dir')) db.exec('ALTER TABLE orgs ADD COLUMN xmit_sftp_dir TEXT');
  if (!columnExists('orgs', 'xmit_rest_endpoint')) db.exec('ALTER TABLE orgs ADD COLUMN xmit_rest_endpoint TEXT');
  if (!columnExists('orgs', 'xmit_rest_api_key')) db.exec('ALTER TABLE orgs ADD COLUMN xmit_rest_api_key TEXT');
  if (!columnExists('orgs', 'xmit_rest_auth_scheme')) db.exec("ALTER TABLE orgs ADD COLUMN xmit_rest_auth_scheme TEXT NOT NULL DEFAULT 'Bearer'");

  // Claim batches: draft → generated → transmitted → acknowledged → accepted/rejected/partial
  db.exec(`
    CREATE TABLE IF NOT EXISTS claim_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES orgs(id),
      batch_number TEXT NOT NULL,
      claim_ids TEXT NOT NULL DEFAULT '[]',
      edi_text TEXT,
      control_number TEXT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','generated','transmitted','acknowledged','accepted','rejected','partial')),
      vendor TEXT NOT NULL DEFAULT 'manual',
      transmitted_at TEXT,
      ack_raw_999 TEXT,
      ack_raw_277ca TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_batches_number ON claim_batches(batch_number);
    CREATE INDEX IF NOT EXISTS idx_batches_org ON claim_batches(org_id);
  `);

  // Interchange control-number sequence (one row per day; see edi/generate837p.js)
  db.exec(`
    CREATE TABLE IF NOT EXISTS edi_control_numbers (
      date TEXT PRIMARY KEY,
      last_seq INTEGER NOT NULL DEFAULT 0
    );
  `);

  // EHR connections: one row per org per provider.
  // NOTE (honest posture): OAuth tokens live in the droplet SQLite file, which
  // is NOT encrypted at rest — same posture as the eligibility/transmission
  // credentials. Protected by DB file permissions + app-level access control;
  // tokens are never exposed through the API (the list endpoint omits them).
  db.exec(`
    CREATE TABLE IF NOT EXISTS ehr_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES orgs(id),
      provider TEXT NOT NULL CHECK (provider IN ('athenahealth','demo')),
      status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected','connected','error')),
      access_token TEXT,
      refresh_token TEXT,
      token_expires_at TEXT,
      practice_id TEXT,
      auth_mode TEXT,
      oauth_state TEXT,
      last_sync_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(org_id, provider)
    );
  `);

  // EHR encounters pulled by sync; convert/ignore workflow into claim drafts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ehr_encounters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES orgs(id),
      connection_id INTEGER NOT NULL REFERENCES ehr_connections(id) ON DELETE CASCADE,
      ehr_encounter_id TEXT NOT NULL,
      ehr_patient_id TEXT,
      patient_first TEXT,
      patient_last TEXT,
      patient_dob TEXT,
      payer_name TEXT,
      date_of_service TEXT,
      cpt_codes TEXT NOT NULL DEFAULT '[]',
      icd_codes TEXT NOT NULL DEFAULT '[]',
      rendering_provider TEXT,
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','converted','ignored')),
      converted_claim_id INTEGER REFERENCES claims(id),
      raw_payload TEXT,
      synced_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(org_id, ehr_encounter_id)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ehrenc_org_status ON ehr_encounters(org_id, status);`);

  // Per-org athenahealth app credentials (env ATHENA_CLIENT_ID/SECRET preferred).
  if (!columnExists('orgs', 'ehr_athena_client_id')) db.exec('ALTER TABLE orgs ADD COLUMN ehr_athena_client_id TEXT');
  if (!columnExists('orgs', 'ehr_athena_client_secret')) db.exec('ALTER TABLE orgs ADD COLUMN ehr_athena_client_secret TEXT');
  if (!columnExists('orgs', 'ehr_athena_env')) db.exec("ALTER TABLE orgs ADD COLUMN ehr_athena_env TEXT NOT NULL DEFAULT 'preview'");
  if (!columnExists('orgs', 'ehr_athena_practice_id')) db.exec('ALTER TABLE orgs ADD COLUMN ehr_athena_practice_id TEXT');

  // AI-assisted coding jobs: async LLM suggestion runs over clinical notes.
  // Suggestions are NEVER auto-applied — a human must accept each code
  // (coding_decisions) before anything touches a claim.
  db.exec(`
    CREATE TABLE IF NOT EXISTS coding_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES orgs(id),
      claim_id INTEGER REFERENCES claims(id),
      encounter_id INTEGER REFERENCES ehr_encounters(id),
      note_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','complete','failed')),
      result_json TEXT,
      error TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS coding_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES coding_jobs(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('CPT','ICD10')),
      decision TEXT NOT NULL CHECK (decision IN ('accepted','rejected','modified')),
      final_code TEXT,
      in_library INTEGER NOT NULL DEFAULT 0,
      decided_by INTEGER REFERENCES users(id),
      decided_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_codingjobs_org ON coding_jobs(org_id, created_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_codingdec_job ON coding_decisions(job_id);`);
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
