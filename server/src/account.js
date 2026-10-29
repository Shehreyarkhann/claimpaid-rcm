// Account model (deploy #100) — the plan, the trial window, the seat roster
// and the monthly claim/AI quotas all belong to the ACCOUNT: the user who
// holds the subscription/trial (the 'owner' of one or more workspaces).
// Workspaces inherit the account's plan; nothing may set a separate plan,
// trial or subscription per workspace.
//
// Definitions:
//   account holder  = the earliest 'owner' member of an org (user_orgs).
//   account orgs    = every org where that holder has role 'owner'.
//   roster          = distinct users who are members of any account org —
//                     seats count roster people, never memberships.
//   plan-of-record  = the account org that carries the canonical plan
//                     fields: prefer one with a Stripe subscription, then
//                     one that completed onboarding, then the lowest id.
//                     Plan changes propagate OUT to every sibling org so
//                     all orgs.plan columns stay in sync (lots of legacy
//                     code reads orgs.plan for the CURRENT org only).
//
// This module takes `db` explicitly and requires only config/planLimits —
// no import cycles with usage.js / routes.

const { limitsForPlan } = require('./config/planLimits');
const { db } = require('./db');

// The account holder (subscription/trial owner) for an org: the earliest
// 'owner' member. Null when the org has no owner row (shouldn't happen).
function ownerOfOrg(orgId) {
  const row = db.prepare(
    "SELECT user_id FROM user_orgs WHERE org_id = ? AND role = 'owner' ORDER BY created_at ASC, user_id ASC LIMIT 1",
  ).get(orgId);
  return row ? row.user_id : null;
}

// Every org id the user holds as 'owner', ascending.
function orgIdsOwnedBy(userId) {
  return db.prepare(
    "SELECT org_id FROM user_orgs WHERE user_id = ? AND role = 'owner' ORDER BY org_id ASC",
  ).all(userId).map((r) => r.org_id);
}

// The full org set of the account that org `orgId` belongs to.
function accountOrgIdsForOrg(orgId) {
  const ownerId = ownerOfOrg(orgId);
  if (!ownerId) return [orgId];
  const ids = orgIdsOwnedBy(ownerId);
  return ids.length ? ids : [orgId];
}

// The org set of the account a USER holds (their own account). A pure
// member who owns nothing resolves to the account(s) of the owners of the
// orgs they belong to — used only for read-side aggregation fallbacks.
function accountOrgIdsForUser(userId) {
  const owned = orgIdsOwnedBy(userId);
  if (owned.length) return owned;
  const rows = db.prepare(
    `SELECT DISTINCT uo.org_id FROM user_orgs uo
      WHERE uo.user_id IN (
        SELECT uo2.user_id FROM user_orgs uo2
         WHERE uo2.role = 'owner'
           AND uo2.org_id IN (SELECT org_id FROM user_orgs WHERE user_id = ?)
      ) AND uo.role = 'owner'`,
  ).all(userId);
  // rows above are owner memberships; the org ids themselves are the set.
  return rows.map((r) => r.org_id);
}

// Plan-of-record org row among a set of org ids (see header). Null if the
// set is empty or no org exists.
function planOfRecordOrg(orgIds) {
  if (!orgIds || !orgIds.length) return null;
  const ph = orgIds.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM orgs WHERE id IN (${ph})
      ORDER BY (stripe_subscription_id IS NOT NULL) DESC,
               (onboarding_completed_at IS NOT NULL) DESC,
               id ASC LIMIT 1`,
  ).get(...orgIds) || null;
}

// { ownerId, orgIds, planOrg, plan } for the account behind an org.
function accountForOrg(orgId) {
  const ownerId = ownerOfOrg(orgId);
  const orgIds = accountOrgIdsForOrg(orgId);
  const planOrg = planOfRecordOrg(orgIds);
  return { ownerId, orgIds, planOrg, plan: planOrg ? planOrg.plan : null };
}

// The plan fields a workspace inherits / siblings mirror.
function planFieldsOf(org) {
  if (!org) return null;
  return {
    plan: org.plan,
    plan_status: org.plan_status,
    trial_started_at: org.trial_started_at,
    trial_ends_at: org.trial_ends_at,
  };
}

// Plan fields + the subscription bookkeeping siblings must mirror so a
// cancel/reactivate performed in one workspace reads identically in all.
const PLAN_FIELD_KEYS = ['plan', 'plan_status', 'trial_started_at', 'trial_ends_at', 'stripe_cancel_at_period_end', 'current_period_end'];

// Copy plan fields from one org to every OTHER org in the same account, so
// per-org readers (tokens, product gates, AskBase plan lookup) always see
// the account plan. Only keys present in `fields` are written.
function propagatePlanFields(sourceOrgId, fields) {
  const keys = PLAN_FIELD_KEYS.filter((k) => fields && fields[k] !== undefined);
  if (!keys.length) return 0;
  const { orgIds } = accountForOrg(sourceOrgId);
  const siblings = orgIds.filter((id) => id !== sourceOrgId);
  if (!siblings.length) return 0;
  const setSql = keys.map((k) => `${k} = ?`).join(', ');
  const stmt = db.prepare(`UPDATE orgs SET ${setSql} WHERE id = ?`);
  let n = 0;
  for (const id of siblings) {
    stmt.run(...keys.map((k) => fields[k]), id);
    n++;
  }
  return n;
}

// Roster: every distinct user who is a member of any org the holder owns,
// with their per-workspace access. Account holder first, then by name.
function rosterForOwner(ownerId) {
  const orgIds = orgIdsOwnedBy(ownerId);
  if (!orgIds.length) return { orgs: [], members: [] };
  const ph = orgIds.map(() => '?').join(',');
  const orgs = db.prepare(`SELECT id, name FROM orgs WHERE id IN (${ph}) ORDER BY id ASC`).all(...orgIds);
  const rows = db.prepare(
    `SELECT u.id AS user_id, u.name, u.email, uo.org_id, uo.role
       FROM user_orgs uo JOIN users u ON u.id = uo.user_id
      WHERE uo.org_id IN (${ph})
      ORDER BY u.name ASC, u.id ASC`,
  ).all(...orgIds);
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) {
      byUser.set(r.user_id, {
        id: r.user_id, name: r.name, email: r.email,
        is_account_owner: r.user_id === ownerId, workspaces: [],
      });
    }
    byUser.get(r.user_id).workspaces.push({ org_id: r.org_id, role: r.role });
  }
  const members = [...byUser.values()].sort((a, b) =>
    (b.is_account_owner - a.is_account_owner) || String(a.name).localeCompare(String(b.name)));
  return { orgs, members };
}

function rosterUserIds(ownerId) {
  return rosterForOwner(ownerId).members.map((m) => m.id);
}

// Workspace usage for an account: creation-gated only, grandfathered over.
function workspaceUsage(ownerId, plan) {
  const used = orgIdsOwnedBy(ownerId).length;
  const limit = limitsForPlan(plan).workspaces;
  return { used, limit: limit === undefined ? null : limit };
}

// "Share team across workspaces" — a user-level flag on the account holder.
function shareTeamEnabled(ownerId) {
  if (!ownerId) return false;
  const row = db.prepare('SELECT share_team_across_workspaces AS s FROM users WHERE id = ?').get(ownerId);
  return !!(row && row.s);
}

function setShareTeam(ownerId, enabled) {
  db.prepare('UPDATE users SET share_team_across_workspaces = ? WHERE id = ?')
    .run(enabled ? 1 : 0, ownerId);
}

// The role a member should receive when propagated into a workspace they
// don't belong to yet: the account holder is always 'owner'; anyone else
// keeps the role they hold in the plan-of-record workspace, else their role
// in any account workspace, else the default member role 'biller'.
function resolvedRoleFor(ownerId, userId, orgIds) {
  if (userId === ownerId) return 'owner';
  const planOrg = planOfRecordOrg(orgIds && orgIds.length ? orgIds : orgIdsOwnedBy(ownerId));
  if (planOrg) {
    const r = db.prepare('SELECT role FROM user_orgs WHERE user_id = ? AND org_id = ?').get(userId, planOrg.id);
    if (r) return r.role;
  }
  const any = db.prepare(
    `SELECT role FROM user_orgs WHERE user_id = ?
       AND org_id IN (SELECT org_id FROM user_orgs WHERE user_id = ? AND role = 'owner')
      ORDER BY org_id ASC LIMIT 1`,
  ).get(userId, ownerId);
  return any ? any.role : 'biller';
}

function addUserToOrg(userId, orgId, role) {
  db.prepare('INSERT OR IGNORE INTO user_orgs (user_id, org_id, role) VALUES (?, ?, ?)')
    .run(userId, orgId, role);
}

// Backfill: every roster member becomes a member of every account org
// (existing memberships keep their role). Returns how many were added.
function backfillRoster(ownerId) {
  const orgIds = orgIdsOwnedBy(ownerId);
  const { members } = rosterForOwner(ownerId);
  let added = 0;
  for (const m of members) {
    const have = new Set(m.workspaces.map((w) => w.org_id));
    for (const orgId of orgIds) {
      if (have.has(orgId)) continue;
      addUserToOrg(m.id, orgId, resolvedRoleFor(ownerId, m.id, orgIds));
      added++;
    }
  }
  return added;
}

// Add the whole current roster to a freshly created org (share-team ON at
// creation time). The creator is already a member — INSERT OR IGNORE.
function addRosterToOrg(ownerId, orgId) {
  const orgIds = orgIdsOwnedBy(ownerId);
  const { members } = rosterForOwner(ownerId);
  for (const m of members) {
    addUserToOrg(m.id, orgId, m.id === ownerId ? 'owner' : resolvedRoleFor(ownerId, m.id, orgIds));
  }
}

// Add one user to every account org (share-team ON at invite time).
function addUserToAllAccountOrgs(ownerId, userId, inviteRole) {
  const orgIds = orgIdsOwnedBy(ownerId);
  for (const orgId of orgIds) {
    const existing = db.prepare('SELECT role FROM user_orgs WHERE user_id = ? AND org_id = ?').get(userId, orgId);
    if (!existing) addUserToOrg(userId, orgId, inviteRole || resolvedRoleFor(ownerId, userId, orgIds));
  }
}

module.exports = {
  ownerOfOrg,
  orgIdsOwnedBy,
  accountOrgIdsForOrg,
  accountOrgIdsForUser,
  planOfRecordOrg,
  accountForOrg,
  planFieldsOf,
  propagatePlanFields,
  rosterForOwner,
  rosterUserIds,
  workspaceUsage,
  shareTeamEnabled,
  setShareTeam,
  resolvedRoleFor,
  addUserToOrg,
  backfillRoster,
  addRosterToOrg,
  addUserToAllAccountOrgs,
};
