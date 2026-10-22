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

module.exports = { signToken, authRequired, roleRequired, JWT_SECRET };
