const jwt = require('jsonwebtoken');
const { db } = require('./db');
const { limitsForPlan } = require('./config/planLimits');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRES = '7d';

// Plan + resolved limits are embedded in the token so downstream services
// (ClaimPaid AI, served at /ai/) can enforce quotas without a DB round-trip.
// Limits refresh on re-login (tokens live 7 days) — acceptable and honest.
// The super-admin account (deploy #54): the address in SUPERADMIN_EMAIL gets
// every product with no plan limits — free and unrestricted, by design.
function isSuperAdminEmail(email) {
  const se = (process.env.SUPERADMIN_EMAIL || '').trim().toLowerCase();
  return !!se && !!email && email.toLowerCase() === se;
}

function signToken(user) {
  let plan = null;
  try {
    const org = db.prepare('SELECT plan FROM orgs WHERE id = ?').get(user.org_id);
    plan = org?.plan || null;
  } catch { /* plan lookup failure => grandfathered unlimited, never strand a login */ }
  if (isSuperAdminEmail(user.email)) plan = 'enterprise'; // unlimited limits embed in the token
  return jwt.sign(
    { sub: user.id, org: user.org_id, role: user.role, email: user.email, name: user.name, plan, limits: limitsForPlan(plan) },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Confirm the user still exists AND still belongs to the token's workspace.
    // The workspace comes from the token (set at login/switch), not the home org —
    // this is what makes workspace switching work.
    const member = db.prepare(
      `SELECT u.id, u.email, u.name, u.mfa_enabled, u.is_superadmin, m.org_id, m.role
       FROM user_orgs m JOIN users u ON u.id = m.user_id
       WHERE m.user_id = ? AND m.org_id = ?`
    ).get(payload.sub, payload.org);
    if (!member) return res.status(401).json({ error: 'User no longer exists' });

    // Org-wide MFA enforcement (workstream C): when the token's org requires
    // MFA and the member is not enrolled, block API access until they complete
    // the email-code flow (login / org-challenge). This runs on EVERY request
    // so flipping the flag takes effect immediately, including for sessions
    // issued before the flag was turned on.
    //
    // NOTE on API keys (sibling workstream): this block lives in the
    // INTERACTIVE JWT session path only. API keys authenticate through the
    // separate apiKeyAuth middleware and are NOT gated by org MFA — they are
    // machine credentials, independently revocable. Do not route API-key auth
    // through this block.
    const fullPath = (req.baseUrl || '') + (req.path || '');
    const MFA_BYPASS_PATHS = new Set([
      '/api/auth/me',               // session liveness check — must not log the user out
      '/api/auth/orgs',             // workspace list — lets a blocked user switch away
      '/api/auth/switch',           // switching itself enforces MFA for the target org
      '/api/auth/mfa/org-challenge',// how a blocked member starts the email-code flow
    ]);
    if (!member.is_superadmin && !MFA_BYPASS_PATHS.has(fullPath)) {
      const orgFlag = db.prepare('SELECT mfa_required FROM orgs WHERE id = ?').get(member.org_id);
      if (orgFlag && orgFlag.mfa_required === 1 && !member.mfa_enabled) {
        return res.status(403).json({
          error: 'Your organization requires two-factor authentication. Complete verification to continue.',
          mfaRequired: true,
        });
      }
    }

    req.user = { id: member.id, email: member.email, name: member.name, role: member.role, org_id: member.org_id };
    req.orgId = member.org_id;
    req.isSuperAdmin = isSuperAdminEmail(member.email);
    // Attach subscription products so routes can gate by plan (ai plan => no RCM, etc.)
    // Uses the effective status: an expired trial unlocks nothing.
    // The super-admin bypasses all plan gating (deploy #54).
    if (req.isSuperAdmin) {
      req.plan = 'enterprise';
      req.products = { rcm: true, ai: true };
    } else try {
      const org = db.prepare('SELECT plan, plan_status, trial_ends_at FROM orgs WHERE id = ?').get(member.org_id);
      const { productsForOrg } = require('./routes/billing');
      req.plan = org?.plan || null;
      req.products = productsForOrg(org);
    } catch {
      req.plan = null;
      req.products = { rcm: true, ai: true };
    }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function roleRequired(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Block plans that don't include a product (e.g. AI-only plan calling RCM data APIs).
// Must run after authRequired (which attaches req.products).
function requireProduct(product) {
  return (req, res, next) => {
    if (req.products && req.products[product] === false) {
      return res.status(403).json({
        error: `Your ${req.plan === 'ai' ? 'ClaimPaid AI' : 'current'} plan doesn't include this. Upgrade to RCM Pro to unlock everything.`,
        upgrade: true,
      });
    }
    next();
  };
}


// Super-admin gate: reads is_superadmin from the DB (not the JWT) so flag
// changes take effect immediately. No org scoping — super-admins see everything.
function superAdminRequired(req, res, next) {
  // HARD LOCK: only the SUPERADMIN_EMAIL address may pass — checked against the
  // live env var on every request. A flipped is_superadmin flag in the database
  // alone can never grant access.
  try {
    const superEmail = (process.env.SUPERADMIN_EMAIL || '').trim().toLowerCase();
    if (!superEmail) return res.status(403).json({ error: 'Super-admin access required' });
    const row = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
    if (row && String(row.email).toLowerCase() === superEmail) return next();
  } catch (e) {
    console.error('superAdminRequired check failed:', e.message);
  }
  return res.status(403).json({ error: 'Super-admin access required' });
}

module.exports = { signToken, authRequired, roleRequired, requireProduct, superAdminRequired, JWT_SECRET, isSuperAdminEmail };
