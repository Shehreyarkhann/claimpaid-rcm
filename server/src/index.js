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
const auditRoutes = require('./routes/audit');
const eligibilityRoutes = require('./routes/eligibility');
const orgRoutes = require('./routes/org');
const { billingRoutes, handleWebhook } = require('./routes/billing');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
// Stripe webhook needs the RAW body for signature verification — mount before express.json()
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), handleWebhook);
app.use(express.json());

initSchema();

// Auto-seed on first run if no orgs exist
const orgCount = db.prepare('SELECT COUNT(*) AS n FROM orgs').get().n;
if (orgCount === 0) {
  console.log('No organizations — seeding demo data...');
  require('./seed.js');
}

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
app.use('/api/audit', auditRoutes);
app.use('/api/eligibility', eligibilityRoutes);
app.use('/api/org', orgRoutes);
app.use('/api/billing', billingRoutes);

// Email-code MFA routes
const { registerRoutes: registerMfaRoutes } = require('./mfa');
const { signToken } = require('./auth');
registerMfaRoutes(app, (user) => {
  const org = db.prepare('SELECT name FROM orgs WHERE id = ?').get(user.org_id);
  const safe = { id: user.id, org_id: user.org_id, email: user.email, name: user.name, role: user.role };
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
}
// Fallback: landing page for unknown non-API routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  const landingIndex = path.join(landingDir, 'index.html');
  if (fs.existsSync(landingIndex)) return res.sendFile(landingIndex);
  res.status(404).send('Not found');
});

app.listen(PORT, () => {
  console.log(`Pulse RCM running on http://localhost:${PORT}`);
  if (!process.env.JWT_SECRET) {
    console.log('WARNING: JWT_SECRET not set — using dev default. Set it in production.');
  }
});
