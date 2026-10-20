const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired } = require('../auth');

const router = express.Router();
router.use(authRequired, roleRequired('owner'));

// --- Audit log viewer ---
router.get('/', (req, res) => {
  const { user = '', action = '', resource = '', days = 30, limit = 100 } = req.query;
  const since = new Date();
  since.setDate(since.getDate() - parseInt(days));

  const where = ['al.org_id = ?', "al.created_at >= ?"];
  const params = [req.orgId, since.toISOString().slice(0, 10)];
  if (user) { where.push('(al.user_email LIKE ? OR CAST(al.user_id AS TEXT) = ?)'); params.push(`%${user}%`, user); }
  if (action) { where.push('al.action = ?'); params.push(action); }
  if (resource) { where.push('al.resource_type = ?'); params.push(resource); }

  const rows = db.prepare(`
    SELECT al.*, u.name AS user_name
    FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
    WHERE ${where.join(' AND ')}
    ORDER BY al.created_at DESC, al.id DESC
    LIMIT ?
  `).all(...params, Math.min(parseInt(limit) || 100, 500));

  res.json(rows);
});

// --- Summary counts ---
router.get('/summary', (req, res) => {
  const { days = 30 } = req.query;
  const since = new Date();
  since.setDate(since.getDate() - parseInt(days));

  const byAction = db.prepare(`
    SELECT action, COUNT(*) AS n FROM audit_log
    WHERE org_id = ? AND created_at >= ?
    GROUP BY action ORDER BY n DESC
  `).all(req.orgId, since.toISOString().slice(0, 10));

  const byUser = db.prepare(`
    SELECT al.user_id, u.name AS user_name, al.user_email, COUNT(*) AS n
    FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
    WHERE al.org_id = ? AND al.created_at >= ?
    GROUP BY al.user_id ORDER BY n DESC LIMIT 10
  `).all(req.orgId, since.toISOString().slice(0, 10));

  res.json({ byAction, byUser, periodDays: parseInt(days) });
});

module.exports = router;
