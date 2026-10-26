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
  let tv = user.token_version ?? 0;
  try {
    const org = db.prepare('SELECT plan FROM orgs WHERE id = ?').get(user.org_id);
    plan = org?.plan || null;
    // Always mint with the CURRENT token_version (deploy #57) — callers
    // pass partial user objects (e.g. workspace switch) that may not
    // carry it, and a stale tv would kill the fresh token instantly.
    const row = db.prepare('SELECT token_version FROM users WHERE id = ?').get(user.id);
    if (row && row.token_version != null) tv = row.token_version;
  } catch { /* plan lookup failure => grandfathered unlimited, never strand a login */ }
  if (isSuperAdminEmail(user.email)) plan = 'enterprise'; // unlimited limits embed in the token
  return jwt.sign(
    { sub: user.id, org: user.org_id, role: user.role, email: user.email, name: user.name, plan, limits: limitsForPlan(plan), tv },
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
    let member = db.prepare(
      `SELECT u.id, u.email, u.name, u.mfa_enabled, u.is_superadmin, u.token_version, m.org_id, m.role
       FROM user_orgs m JOIN users u ON u.id = m.user_id
       WHERE m.user_id = ? AND m.org_id = ?`
    ).get(payload.sub, payload.org);
    if (!member) {
      // The token's workspace no longer includes this user — deleted
      // workspace, removed membership, or a stale home-org pointer (the
      // 2026-10-26 dead-login loop). Heal to any remaining membership; if
      // none exists, this is the org-less state: authenticate narrowly so
      // the client can route to workspace creation instead of bouncing the
      // user through a login that can never succeed.
      const u = db.prepare('SELECT id, email, name, role, mfa_enabled, is_superadmin, token_version, org_id FROM users WHERE id = ?').get(payload.sub);
      if (!u || (payload.tv ?? 0) !== (u.token_version ?? 0)) {
        return res.status(401).json({ error: 'User no longer exists' });
      }
      const first = db.prepare('SELECT org_id, role FROM user_orgs WHERE user_id = ? ORDER BY org_id LIMIT 1').get(u.id);
      if (first) {
        db.prepare('UPDATE users SET org_id = ? WHERE id = ?').run(first.org_id, u.id);
        member = { ...u, org_id: first.org_id, role: first.role };
      } else {
        const p = (req.baseUrl || '') + (req.path || '');
        const RECOVERY_PATHS = new Set(['/api/auth/me', '/api/auth/orgs', '/api/auth/switch', '/api/onboarding/status']);
        const isRecovery = RECOVERY_PATHS.has(p)
          || (req.method === 'DELETE' && p.startsWith('/api/auth/orgs/'))
          || p.startsWith('/api/super');
        req.user = { id: u.id, email: u.email, name: u.name, role: u.role, org_id: u.org_id };
        req.orgId = u.org_id;
        req.noOrg = true;
        req.isSuperAdmin = isSuperAdminEmail(u.email);
        req.plan = req.isSuperAdmin ? 'enterprise' : null;
        req.products = req.isSuperAdmin ? { rcm: true, ai: true } : { rcm: false, ai: false };
        if (!isRecovery) {
          return res.status(403).json({ error: 'This account has no workspace yet. Create a workspace to continue.', noOrg: true });
        }
        return next();
      }
    }
    // Log-out-everywhere / password change bumps token_version (deploy #57):
    // any token minted before the bump dies here. Pre-#57 tokens carry no
    // tv and read as 0, matching the column default — the deploy itself
    // logs nobody out.
    if ((payload.tv ?? 0) !== (member.token_version ?? 0)) {
      return res.status(401).json({ error: 'This session has ended. Please sign in again.' });
    }

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
    // Plans-only backstop (deploy #61): an org with NO product access
    // (trial over, or canceled past its window, with no paid plan) may
    // reach only account / billing / onboarding / legal / support / super
    // routes — every business API answers 403 PLAN_REQUIRED and the client
    // shows the plans page. Mirrors the MFA bypass pattern above.
    if (!req.isSuperAdmin && req.products && !req.products.rcm && !req.products.ai) {
      const OPEN_PREFIXES = ['/api/auth', '/api/billing', '/api/onboarding', '/api/super', '/api/legal', '/api/support'];
      if (!OPEN_PREFIXES.some((x) => fullPath.startsWith(x))) {
        return res.status(403).json({
          error: 'Your trial has ended and there is no active plan. Choose a plan to continue.',
          code: 'PLAN_REQUIRED', upgrade: true,
        });
      }
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
