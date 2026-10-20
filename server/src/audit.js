// HIPAA audit logging — records who accessed PHI and when.
// Log reads of individual records and bulk exports; list endpoints are
// intentionally not logged (too noisy, low signal).

const { db } = require('./db');

function auditLog(req, action, resourceType, resourceId = null, resourceLabel = null) {
  try {
    db.prepare(`
      INSERT INTO audit_log (org_id, user_id, user_email, action, resource_type, resource_id, resource_label, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.orgId,
      req.user?.id || null,
      req.user?.email || null,
      action,
      resourceType,
      resourceId ? String(resourceId) : null,
      resourceLabel,
      req.ip || req.headers['x-forwarded-for'] || null,
    );
  } catch (e) {
    console.error('Audit log failed:', e.message);
  }
}

module.exports = { auditLog };
