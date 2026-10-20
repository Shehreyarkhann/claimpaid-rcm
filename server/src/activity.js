const { db } = require('./db');

function logActivity(orgId, claimId, userId, action, detail = null) {
  try {
    db.prepare(`
      INSERT INTO claim_activity (org_id, claim_id, user_id, action, detail)
      VALUES (?, ?, ?, ?, ?)
    `).run(orgId, claimId, userId, action, detail);
  } catch (e) {
    console.error('Activity log failed:', e.message);
  }
}

module.exports = { logActivity };
