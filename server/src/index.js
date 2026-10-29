require('dotenv').config(); // Load .env file (see .env.example)
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { initSchema, db } = require('./db');
const analyticsRoutes = require('./routes/analytics');
const claimsRoutes = require('./routes/claims');
const appealsRoutes = require('./routes/appeals');
const authRoutes = require('./routes/auth');
const filingRoutes = require('./routes/filing');
const worklistRoutes = require('./routes/worklist');
const reportsRoutes = require('./routes/reports');
const playbookRoutes = require('./routes/playbook');
const eraRoutes = require('./routes/era');
const authzRoutes = require('./routes/authz');
const scrubRoutes = require('./routes/scrub');
const rulesRoutes = require('./routes/rules');
const auditRoutes = require('./routes/audit');
const eligibilityRoutes = require('./routes/eligibility');
const orgRoutes = require('./routes/org');
const { billingRoutes, handleWebhook, handleConnectWebhook } = require('./routes/billing');
const demoRoutes = require('./routes/demo');
const leadsRoutes = require('./routes/leads');
const superRoutes = require('./routes/super');
const supportRoutes = require('./routes/support');
const { legalRoutes } = require('./routes/legal');
const transmissionRoutes = require('./routes/transmission');
const ehrRoutes = require('./routes/ehr');
const codingRoutes = require('./routes/coding');
const agentRoutes = require('./routes/agent');
const onboardingRoutes = require('./routes/onboarding');
const settingsRoutes = require('./routes/settings');
const apiV1Routes = require('./routes/apiV1');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
// Deploy #101: request metrics for the /super Health tab (route-group
// counts + latency only — no paths, bodies, or PHI). Mounted first so
// every response, including webhooks and statics, is timed.
app.use(require('./metrics').metricsMiddleware);
// Stripe webhook needs the RAW body for signature verification — mount before express.json()
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), handleWebhook);
// Connect webhook (events on connected accounts — statement payments) has
// its own endpoint + signing secret; same raw-body requirement.
app.post('/api/billing/webhook/connect', express.raw({ type: 'application/json' }), handleConnectWebhook);
// 512kb: the avatar upload (deploy #57) sends a downscaled data URL in JSON.
app.use(express.json({ limit: '512kb' }));

initSchema();

// No auto-seed (market launch, deploy #52): a fresh database starts empty
// and the first signup creates the first organization.

// Public client config (Google OAuth client ID for the sign-in button;
// null hides the button gracefully). No auth — contains nothing secret.
app.get('/api/config', (req, res) => {
  res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || null });
});

app.use('/api/auth', authRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/claims', claimsRoutes);
app.use('/api/appeals', appealsRoutes);
app.use('/api/filing', filingRoutes);
app.use('/api/worklist', worklistRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/playbook', playbookRoutes);
app.use('/api/era', eraRoutes);
app.use('/api/authz', authzRoutes);
app.use('/api/scrub', scrubRoutes);
app.use('/api/rules', rulesRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/eligibility', eligibilityRoutes);
app.use('/api/org', orgRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/demo', demoRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/super', superRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/legal', legalRoutes);
app.use('/api/transmission', transmissionRoutes);
app.use('/api/ehr', ehrRoutes);
app.use('/api/coding', codingRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/statements', require('./routes/statements'));
app.use('/api/settings', settingsRoutes);
app.use('/api', apiV1Routes); // /api/v1/* — developer API keys only

// Org logo uploads (public read — logos are shown in the app header)
const uploadsDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// Email-code MFA routes
const { registerRoutes: registerMfaRoutes } = require('./mfa');
const { signToken } = require('./auth');
registerMfaRoutes(app, (user, orgIdOverride) => {
  // orgIdOverride: org-enforced MFA verification issues the session for the
  // enforced org, which may differ from the user's home org (org-switch flow).
  const effOrgId = orgIdOverride || user.org_id;
  const org = db.prepare('SELECT name FROM orgs WHERE id = ?').get(effOrgId);
  const safe = { id: user.id, org_id: effOrgId, email: user.email, name: user.name, role: user.role };
  return { token: signToken(safe), user: { ...safe, orgName: org ? org.name : '' } };
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Serve the marketing landing page at /
const landingDir = path.join(__dirname, '..', '..', 'landing');
if (fs.existsSync(path.join(landingDir, 'index.html'))) {
  app.use(express.static(landingDir));
}

// Serve the built React app at /app
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use('/app', express.static(clientDist));
  app.get('/app/*', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
  // Super-admin console + public support page live in the same SPA bundle
  app.get('/super', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
  app.get('/support', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}
// Fallback: landing page for unknown non-API routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  const landingIndex = path.join(landingDir, 'index.html');
  if (fs.existsSync(landingIndex)) return res.sendFile(landingIndex);
  res.status(404).send('Not found');
});

app.listen(PORT, () => {
  console.log(`ClaimPaid running on http://localhost:${PORT}`);
  if (!process.env.JWT_SECRET) {
    console.log('WARNING: JWT_SECRET not set — using dev default. Set it in production.');
  }
});

// ---- EHR auto-pull scheduler (deploy #42) ----
// Every EHR_AUTOPULL_MINUTES (default 15), sync every org that has a
// connected EHR with auto_convert on, so closed encounters become claim
// drafts without anyone pressing Sync. Manual sync uses the same code path.
// Disable with EHR_AUTOPULL=off.
if (process.env.EHR_AUTOPULL !== 'off' && typeof ehrRoutes.runSyncForOrg === 'function') {
  const { db: schedDb } = require('./db');
  const intervalMin = Math.max(1, parseInt(process.env.EHR_AUTOPULL_MINUTES || '15', 10) || 15);
  let autopullRunning = false;
  const runAutopull = async () => {
    if (autopullRunning) return;
    autopullRunning = true;
    try {
      const orgs = schedDb.prepare(`
        SELECT DISTINCT org_id FROM ehr_connections
        WHERE status = 'connected' AND auto_convert = 1
      `).all();
      for (const { org_id } of orgs) {
        try {
          const s = await ehrRoutes.runSyncForOrg(org_id, null);
          const created = (s.synced || []).reduce((n, x) => n + (x.auto_created || 0), 0);
          const fresh = (s.synced || []).reduce((n, x) => n + (x.new_encounters || 0), 0);
          if (fresh || created) console.log(`[ehr-autopull] org ${org_id}: ${fresh} new encounters, ${created} draft claims auto-created`);
          for (const e of s.errors || []) console.log(`[ehr-autopull] org ${org_id} ${e.provider}: ${e.errors.join(' | ')}`);
        } catch (e) {
          console.log(`[ehr-autopull] org ${org_id} failed: ${e.message}`);
        }
      }
    } catch (e) {
      console.log(`[ehr-autopull] sweep failed: ${e.message}`);
    } finally {
      autopullRunning = false;
    }
  };
  setTimeout(runAutopull, 5 * 60 * 1000).unref();
  setInterval(runAutopull, intervalMin * 60 * 1000).unref();
  console.log(`EHR auto-pull: every ${intervalMin} min for connected orgs (EHR_AUTOPULL=off to disable)`);
}

// ---- Agent watchdog digest scheduler (Phase 4) ----
// Hourly sweep; watchdog.runDigestOnce enforces everything itself — the
// org-local 6–10am window, the once-per-user-per-day dedupe, the
// nothing-actionable no-send rule, plans-only/agent-disabled skips — so
// this timer stays dumb, exactly like the auto-pull above. Disable with
// AGENT_WATCHDOG=off.
if (process.env.AGENT_WATCHDOG !== 'off') {
  const watchdog = require('./agent/watchdog');
  const { runBriefPrecompute } = require('./agent/precompute');
  let watchdogRunning = false;
  const runWatchdog = async () => {
    if (watchdogRunning) return;
    watchdogRunning = true;
    try {
      const s = await watchdog.runDigestOnce(new Date());
      if (s.sent || s.failed) console.log(`[agent-watchdog] digests: ${s.sent} sent, ${s.failed} failed`);
      // Deploy #101: brief precompute rides the same hourly sweep — it
      // generates the 06:00 org-local briefs ahead of first open, and
      // no-ops outside that hour.
      const p = await runBriefPrecompute(new Date());
      if (p.generated) console.log(`[brief-precompute] generated ${p.generated} brief(s)`);
    } catch (e) {
      console.log(`[agent-watchdog] sweep failed: ${e.message}`);
    } finally {
      watchdogRunning = false;
    }
  };
  setTimeout(runWatchdog, 10 * 60 * 1000).unref();
  setInterval(runWatchdog, 60 * 60 * 1000).unref();
  console.log('Agent watchdog: hourly digest sweep (AGENT_WATCHDOG=off to disable)');
}
