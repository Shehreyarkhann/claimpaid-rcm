const jwt = require('jsonwebtoken');
const { db } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRES = '7d';

function signToken(user) {
  return jwt.sign(
    { sub: user.id, org: user.org_id, role: user.role, email: user.email, name: user.name },
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
      `SELECT u.id, u.email, u.name, m.org_id, m.role
       FROM user_orgs m JOIN users u ON u.id = m.user_id
       WHERE m.user_id = ? AND m.org_id = ?`
    ).get(payload.sub, payload.org);
    if (!member) return res.status(401).json({ error: 'User no longer exists' });
    req.user = { id: member.id, email: member.email, name: member.name, role: member.role, org_id: member.org_id };
    req.orgId = member.org_id;
    // Attach subscription products so routes can gate by plan (ai plan => no RCM, etc.)
    try {
      const org = db.prepare('SELECT plan FROM orgs WHERE id = ?').get(member.org_id);
      const { productsForPlan } = require('./routes/billing');
      req.plan = org?.plan || null;
      req.products = productsForPlan(org?.plan);
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

module.exports = { signToken, authRequired, roleRequired, requireProduct, superAdminRequired, JWT_SECRET };
