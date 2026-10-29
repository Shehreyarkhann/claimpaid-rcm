import { authFetch } from './auth';

// 402 limit responses from the plan-quota workstream — surface a friendly
// upgrade modal instead of a raw error. App.jsx listens for this event.
const LIMIT_ERRORS = ['claim_limit_reached', 'seat_limit_reached', 'ai_query_limit_reached'];
export function isLimitError(body) {
  return body && LIMIT_ERRORS.includes(body.error);
}

// Fired when the server blocks a request because the workspace requires
// two-factor authentication the member hasn't completed yet. App.jsx listens
// for this and shows the org-MFA screen instead of a dead end.
function dispatchOrgMfa(detail) {
  window.dispatchEvent(new CustomEvent('claimpaid:org-mfa', { detail }));
}

function mfaRequiredError(body) {
  const err = new Error(body.error || 'Two-factor authentication required');
  err.status = 403;
  err.mfaRequired = true;
  err.mfaToken = body.mfaToken || null;
  err.orgName = body.orgName || null;
  return err;
}

async function handle(res) {
  if (res.status === 401) {
    localStorage.removeItem('pulse_token');
    window.location.reload();
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 402 && isLimitError(body)) {
      window.dispatchEvent(new CustomEvent('plan-limit', { detail: body }));
    }
    if (res.status === 403 && body.mfaRequired) {
      // Org-wide MFA block — NOT a logout: the session stays valid, but this
      // workspace needs the email-code flow completed first.
      dispatchOrgMfa({ mfaToken: null, orgName: null });
      throw mfaRequiredError(body);
    }
    const err = new Error((body.errors || [body.error || `API error: ${res.status}`]).join('; '));
    err.status = res.status;
    err.code = body.code || null;
    err.limitInfo = body;
    throw err;
  }
  return res.json();
}

function get(path) { return authFetch(path).then(handle); }

export const api = {
  kpis: () => get('/api/analytics/kpis'),
  arAging: () => get('/api/analytics/ar-aging'),
  revenueTrend: () => get('/api/analytics/revenue-trend'),
  denialsByReason: () => get('/api/analytics/denials-by-reason'),
  payerMix: () => get('/api/analytics/payer-mix'),
  appealStats: () => get('/api/analytics/appeal-stats'),
  claimQuality: () => get('/api/analytics/claim-quality'),
  claims: (params = {}) => get(`/api/claims?${new URLSearchParams(params)}`),
  payers: () => get('/api/claims/meta/payers'),
  createPayer: (data) =>
    authFetch('/api/claims/meta/payers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(handle),
  appeals: (params = {}) => get(`/api/appeals?${new URLSearchParams(params)}`),
  awaitingPayer: () => get('/api/appeals/awaiting-payer'),
  unworkedDenials: () => get('/api/appeals/unworked-denials'),
  dueFollowups: () => get('/api/appeals/due'),
  team: () => get('/api/auth/team'),
  // Account team (deploy #100) — roster across the account's workspaces.
  accountTeam: () => get('/api/auth/account/team'),
  accountGrantAccess: (data) =>
    authFetch('/api/auth/account/team/access', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(handle),
  accountRevokeAccess: (data) =>
    authFetch('/api/auth/account/team/access/revoke', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(handle),
  accountShareTeam: (enabled) =>
    authFetch('/api/auth/account/team/share', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).then(handle),
  worklist: (scope = 'all') => get(`/api/worklist?scope=${scope}`),
  touchClaim: (id) => authFetch(`/api/worklist/touch/${id}`, { method: 'POST' }).then(handle),
  bulkClaims: (claim_ids, action, value) =>
    authFetch('/api/worklist/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claim_ids, action, value }),
    }).then(handle),
  filingRules: () => get('/api/filing/rules'),
  filingRisk: () => get('/api/filing/risk'),
  filingAtRisk: (days = 30) => get(`/api/filing/at-risk?days=${days}`),
  // Scrub rules (denial-to-rule feedback loop)
  ruleSuggestions: () => get('/api/rules/suggestions'),
  analyzeDenials: () =>
    authFetch('/api/rules/analyze', { method: 'POST' }).then(handle),
  acceptSuggestion: (id) =>
    authFetch(`/api/rules/suggestions/${id}/accept`, { method: 'POST' }).then(handle),
  dismissSuggestion: (id) =>
    authFetch(`/api/rules/suggestions/${id}/dismiss`, { method: 'POST' }).then(handle),
  customRules: () => get('/api/rules/custom'),
  createCustomRule: (data) =>
    authFetch('/api/rules/custom', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(handle),
  deleteCustomRule: (id) =>
    authFetch(`/api/rules/custom/${id}`, { method: 'DELETE' }).then(handle),
  setFilingRule: (payerId, filing_days, notes, response_days) =>
    authFetch(`/api/filing/rules/${payerId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(response_days === undefined ? { filing_days, notes } : { filing_days, notes, response_days }),
    }).then(handle),
  // Reports
  reportArAging: () => get('/api/reports/ar-aging'),
  reportDenials: () => get('/api/reports/denial-analysis'),
  reportProductivity: (days = 30) => get(`/api/reports/productivity?days=${days}`),
  reportCollections: () => get('/api/reports/collections'),
  reportFiling: () => get('/api/reports/filing-compliance'),
  // Playbook
  playbook: (params = {}) => get(`/api/playbook?${new URLSearchParams(params)}`),
  payerStats: () => get('/api/playbook/payer-stats'),
  // ERA / Digest
  digest: () => get('/api/era/digest'),
  era: {
    exceptionGroups: () => get('/api/era/exception-groups'),
    applyExceptionGroup: (lineIds) =>
      authFetch('/api/era/exception-groups/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line_ids: lineIds }),
      }).then(handle),
    remittances: () => get('/api/era/remittances'),
    remittance: (id) => get(`/api/era/remittances/${id}`),
    reconciliation: () => get('/api/era/reconciliation'),
    matchCandidates: (q) => get(`/api/era/match-candidates?q=${encodeURIComponent(q)}`),
    postLine: (id) => authFetch(`/api/era/lines/${id}/post`, { method: 'POST' }).then(handle),
    ignoreLine: (id) => authFetch(`/api/era/lines/${id}/ignore`, { method: 'POST' }).then(handle),
    matchLine: (id, claimId, post) =>
      authFetch(`/api/era/lines/${id}/match`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claim_id: claimId, post: !!post }),
      }).then(handle),
  },
  statements: {
    balances: () => get('/api/statements/balances'),
    list: () => get('/api/statements'),
    detail: (id) => get(`/api/statements/${id}`),
    generate: (data) =>
      authFetch('/api/statements/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).then(handle),
    paymentLink: (id) => authFetch(`/api/statements/${id}/payment-link`, { method: 'POST' }).then(handle),
    recordPayment: (id, data) =>
      authFetch(`/api/statements/${id}/payments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).then(handle),
    void: (id) => authFetch(`/api/statements/${id}/void`, { method: 'POST' }).then(handle),
  },
  claimDetail: (id) => get(`/api/claims/${id}`),
  // Prior authorizations
  authzList: (params = {}) => get(`/api/authz?${new URLSearchParams(params)}`),
  authzStats: () => get('/api/authz/stats'),
  authzDetail: (id) => get(`/api/authz/${id}`),
  authzFindForClaim: (claimId) => get(`/api/authz/find-for-claim/${claimId}`),
  billingStatus: () => get('/api/billing/status'),
  billingUsage: () => get('/api/billing/usage'),
  billingCheckout: (plan) =>
    authFetch('/api/billing/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan }),
    }).then(handle),
  billingInvoices: () => get('/api/billing/invoices'),
  onboardingStatus: () => get('/api/onboarding/status'),
  onboardingComplete: (data) =>
    authFetch('/api/onboarding/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(handle),
  myOrgs: () => get('/api/auth/orgs'),
  createOrg: (name) =>
    authFetch('/api/auth/orgs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then(handle),
  switchOrg: (org_id) =>
    authFetch('/api/auth/switch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id }),
    }).then(handle).then((r) => {
      // Switching into an MFA-enforcing workspace: no session token is issued
      // until the email-code flow completes — surface the org-MFA screen.
      if (r && r.mfaRequired) {
        dispatchOrgMfa({ mfaToken: r.mfaToken, orgName: r.orgName });
        throw mfaRequiredError(r);
      }
      return r;
    }),
  // Org-wide MFA enforcement (workstream C) — used by Settings → Security tab
  // and by the org-MFA challenge screen.
  securitySettings: () => get('/api/settings/security'),
  updateSecuritySettings: (mfa_required) =>
    authFetch('/api/settings/security', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mfa_required }),
    }).then(handle),
  orgMfaChallenge: () =>
    authFetch('/api/auth/mfa/org-challenge', { method: 'POST' }).then(handle),
  deleteOrg: (org_id) =>
    authFetch(`/api/auth/orgs/${org_id}`, { method: 'DELETE' }).then(handle),
  renameOrg: (name) =>
    authFetch('/api/org', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then(handle),
  orgProfile: () => get('/api/org'),
  // ---- Org settings (tabs) ----
  settings: {
    get: () => get('/api/settings'),
    saveGeneral: (data) =>
      authFetch('/api/settings/general', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).then(handle),
    seats: () => get('/api/settings/seats'),
    apiKeys: () => get('/api/settings/api-keys'),
    createApiKey: (name) =>
      authFetch('/api/settings/api-keys', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }).then(handle),
    revokeApiKey: (id) =>
      authFetch(`/api/settings/api-keys/${id}`, { method: 'DELETE' }).then(handle),
    notifications: () => get('/api/settings/notifications'),
    saveNotifications: (prefs) =>
      authFetch('/api/settings/notifications', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prefs),
      }).then(handle),
    // MFA enforcement toggle — backend owned by the MFA workstream
    // (PUT /api/settings/security { mfa_required }); this call targets it exactly.
    saveSecurity: (mfa_required) =>
      authFetch('/api/settings/security', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mfa_required }),
      }).then(handle),
    uploadLogo: (file) => {
      const fd = new FormData();
      fd.append('logo', file);
      return authFetch('/api/settings/logo', { method: 'POST', body: fd }).then(handle);
    },
    deleteLogo: () =>
      authFetch('/api/settings/logo', { method: 'DELETE' }).then(handle),
    saveBrand: (brand_color) =>
      authFetch('/api/settings/brand', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand_color }),
      }).then(handle),
    // Stripe Connect (Express) — patient statement payouts to the practice's
    // own Stripe account (Settings → Payments).
    payments: () => get('/api/settings/payments'),
    connectPayments: () =>
      authFetch('/api/settings/payments/connect', { method: 'POST' }).then(handle),
    disconnectPayments: () =>
      authFetch('/api/settings/payments/disconnect', { method: 'POST' }).then(handle),
  },
  billingPortal: () =>
    authFetch('/api/billing/portal', { method: 'POST' }).then(handle),
  billingCancel: (mode) =>
    authFetch('/api/billing/cancel', { method: 'POST', body: JSON.stringify({ mode }) }).then(handle),
  billingReactivate: () =>
    authFetch('/api/billing/reactivate', { method: 'POST' }).then(handle),
  billingChangePlan: (plan) =>
    authFetch('/api/billing/change-plan', { method: 'POST', body: JSON.stringify({ plan }) }).then(handle),
  updateMe: (fields) =>
    authFetch('/api/auth/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) }).then(handle),
  uploadAvatar: (dataUrl) =>
    authFetch('/api/auth/me/avatar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl }) }).then(handle),
  deleteAvatar: () =>
    authFetch('/api/auth/me/avatar', { method: 'DELETE' }).then(handle),
  changePassword: (currentPassword, newPassword) =>
    authFetch('/api/auth/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword, newPassword }) }).then(handle),
  logoutAll: () =>
    authFetch('/api/auth/logout-all', { method: 'POST' }).then(handle),
  // ---- Legal / BAA ----
  legalDocuments: () =>
    fetch('/api/legal/documents').then((r) => {
      if (!r.ok) throw new Error('Could not load legal documents');
      return r.json();
    }),
  baaStatus: () => get('/api/legal/baa/status'),
  signBaa: (data) =>
    authFetch('/api/legal/baa/sign', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(handle),
  // ---- Super-admin ----
  super: {
    health: () => get('/api/super/health'),
    overview: () => get('/api/super/overview'),
    orgs: () => get('/api/super/orgs'),
    orgDetail: (id) => get(`/api/super/orgs/${id}`),
    setPlan: (id, plan, plan_status) =>
      authFetch(`/api/super/orgs/${id}/plan`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan, plan_status }) }).then(handle),
    deleteOrg: (id) =>
      authFetch(`/api/super/orgs/${id}`, { method: 'DELETE' }).then(handle),
    trialAction: (id, action, days) =>
      authFetch(`/api/super/orgs/${id}/trial`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, days }) }).then(handle),
    cancelSubscription: (id, immediate) =>
      authFetch(`/api/super/orgs/${id}/subscription/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ immediate }) }).then(handle),
    resetOnboarding: (id) =>
      authFetch(`/api/super/orgs/${id}/onboarding/reset`, { method: 'POST' }).then(handle),
    aiOrgs: () => get('/api/super/ai-orgs'),
    users: (search = '') => get(`/api/super/users?${new URLSearchParams({ search })}`),
    updateUser: (id, data) =>
      authFetch(`/api/super/users/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(handle),
    deleteUser: (id) =>
      authFetch(`/api/super/users/${id}`, { method: 'DELETE' }).then(handle),
    resetPassword: (id) =>
      authFetch(`/api/super/users/${id}/reset-password`, { method: 'POST' }).then(handle),
    subscriptions: () => get('/api/super/subscriptions'),
    demos: () => get('/api/super/demos'),
    updateDemo: (id, data) =>
      authFetch(`/api/super/demos/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(handle),
    tickets: () => get('/api/super/tickets'),
    ticketDetail: (id) => get(`/api/super/tickets/${id}`),
    replyTicket: (id, body) =>
      authFetch(`/api/super/tickets/${id}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) }).then(handle),
    updateTicket: (id, data) =>
      authFetch(`/api/super/tickets/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(handle),
    tables: () => get('/api/super/tables'),
    tableRows: (name, params = {}) => get(`/api/super/tables/${name}?${new URLSearchParams(params)}`),
    insertRow: (name, data) =>
      authFetch(`/api/super/tables/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(handle),
    updateRow: (name, id, data) =>
      authFetch(`/api/super/tables/${name}/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(handle),
    deleteRow: (name, id) =>
      authFetch(`/api/super/tables/${name}/${id}`, { method: 'DELETE' }).then(handle),
  },
  submitSupport: (data) =>
    fetch('/api/support', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then((r) => r.json().then((b) => { if (!r.ok) throw new Error(b.error || 'Submit failed'); return b; })),
  support: {
    mine: () => get('/api/support/mine'),
    thread: (id) => get(`/api/support/${id}`),
    reply: (id, body) =>
      authFetch(`/api/support/${id}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) }).then(handle),
  },
  transmission: {
    transmittable: () => get('/api/transmission/transmittable'),
    batches: () => get('/api/transmission/batches'),
    batchDetail: (id) => get(`/api/transmission/batches/${id}`),
    createBatch: (claim_ids) =>
      authFetch('/api/transmission/batches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ claim_ids }) }).then(handle),
    generateBatch: (id) =>
      authFetch(`/api/transmission/batches/${id}/generate`, { method: 'POST' }).then(handle),
    transmitBatch: (id, data) =>
      authFetch(`/api/transmission/batches/${id}/transmit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(handle),
    uploadAck: (id, file, type) => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('type', type);
      return authFetch(`/api/transmission/batches/${id}/ack`, { method: 'POST', body: fd }).then(handle);
    },
    deleteBatch: (id) =>
      authFetch(`/api/transmission/batches/${id}`, { method: 'DELETE' }).then(handle),
    getConfig: () => get('/api/transmission/config'),
    saveConfig: (data) =>
      authFetch('/api/transmission/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(handle),
    outbox: () => get('/api/transmission/outbox'),
    requeueOutbox: (id) =>
      authFetch(`/api/transmission/outbox/${id}/requeue`, { method: 'POST' }).then(handle),
  },
  eligibility: {
    check: (data) =>
      authFetch('/api/eligibility/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(handle),
    history: (limit = 50) => get(`/api/eligibility/history?limit=${limit}`),
    lookup: (id) => get(`/api/eligibility/lookup/${id}`),
    getConfig: () => get('/api/eligibility/config'),
    mode: () => get('/api/eligibility/mode'),
    saveConfig: (data) =>
      authFetch('/api/eligibility/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(handle),
  },
  ehr: {
    connections: () => get('/api/ehr/connections'),
    disconnect: (provider) =>
      authFetch('/api/ehr/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider }) }).then(handle),
    athenaAuthorize: () => get('/api/ehr/athena/authorize'),
    connectAthenaService: () => authFetch('/api/ehr/athena/connect-service', { method: 'POST' }).then(handle),
    sync: () => authFetch('/api/ehr/sync', { method: 'POST' }).then(handle),
    setAutoConvert: (provider, enabled) =>
      authFetch('/api/ehr/auto-convert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, enabled }) }).then(handle),
    encounters: (status = 'new') => get(`/api/ehr/encounters?status=${status}`),
    encounter: (id) => get(`/api/ehr/encounters/${id}`),
    convert: (id) => authFetch(`/api/ehr/encounters/${id}/convert`, { method: 'POST' }).then(handle),
    ignore: (id) => authFetch(`/api/ehr/encounters/${id}/ignore`, { method: 'POST' }).then(handle),
    unignore: (id) => authFetch(`/api/ehr/encounters/${id}/unignore`, { method: 'POST' }).then(handle),
    getAthenaConfig: () => get('/api/ehr/athena/config'),
    saveAthenaConfig: (data) =>
      authFetch('/api/ehr/athena/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(handle),
  },
  coding: {
    analyze: (data) =>
      authFetch('/api/coding/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(handle),
    job: (id) => get(`/api/coding/jobs/${id}`),
    decide: (id, data) =>
      authFetch(`/api/coding/jobs/${id}/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(handle),
  },
  // ---- In-app agent (Phase 1; dark-shipped behind AGENT_ENABLED + key) ----
  agent: {
    brief: () => get('/api/agent/brief'),
    // Deploy #97: every pending approval in the org — the Agent page's
    // approvals section source of truth (brief/thread cards can orphan).
    pendingActions: () => get('/api/agent/actions/pending'),
    conversations: () => get('/api/agent/conversations'),
    conversation: (id) => get(`/api/agent/conversations/${id}`),
    chat: (convoId, message) =>
      authFetch('/api/agent/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ convo_id: convoId ?? undefined, message }),
      }).then(handle),
    approveAction: (id) =>
      authFetch(`/api/agent/actions/${id}/approve`, { method: 'POST' }).then(handle),
    rejectAction: (id) =>
      authFetch(`/api/agent/actions/${id}/reject`, { method: 'POST' }).then(handle),
    // Deploy #101: batch decide, the auto-approved review stream + void,
    // the owner approval policy, the activation checklist, saved import
    // mappings, and the notification center.
    batchDecide: (ids, decision) =>
      authFetch('/api/agent/actions/batch-decide', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, decision }),
      }).then(handle),
    autoApproved: () => get('/api/agent/actions/auto-approved'),
    voidAuto: (id) =>
      authFetch(`/api/agent/actions/${id}/void-auto`, { method: 'POST' }).then(handle),
    policy: () => get('/api/agent/policy'),
    updatePolicy: (data) =>
      authFetch('/api/agent/policy', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).then(handle),
    checklist: () => get('/api/agent/checklist'),
    dismissChecklist: () =>
      authFetch('/api/agent/checklist/dismiss', { method: 'PUT' }).then(handle),
    importMappings: () => get('/api/agent/import/mappings'),
    saveImportMapping: (data) =>
      authFetch('/api/agent/import/mappings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).then(handle),
    deleteImportMapping: (id) =>
      authFetch(`/api/agent/import/mappings/${id}`, { method: 'DELETE' }).then(handle),
    notifications: () => get('/api/agent/notifications'),
    markNotificationsRead: () =>
      authFetch('/api/agent/notifications/read', { method: 'POST' }).then(handle),
    digestPref: (optOut) =>
      authFetch('/api/agent/notifications/digest-pref', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opt_out: optOut }),
      }).then(handle),
    // Phase 4: watchdog alerts strip + running the read tools directly
    // (the Denial Rescue wizard's engine).
    alerts: () => get('/api/agent/alerts'),
    runTool: (tool, claimId) =>
      authFetch('/api/agent/tools/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, claim_id: claimId }),
      }).then(handle),
    // Phase 3 surfaces: dashboard insights, per-claim analysis, and
    // proposing a pending action from outside the chat (claim panel).
    insights: () => get('/api/agent/insights'),
    claimAnalysis: (id) => get(`/api/agent/claims/${id}/analysis`),
    propose: (data) =>
      authFetch('/api/agent/actions/propose', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).then(handle),
    // Phase 5 — document intake (WS1): upload, review, match, propose.
    uploadDocument: (file) => {
      const fd = new FormData();
      fd.append('file', file);
      return authFetch('/api/agent/documents', { method: 'POST', body: fd }).then(handle);
    },
    documents: () => get('/api/agent/documents'),
    document: (id) => get(`/api/agent/documents/${id}`),
    documentFile: (id) => authFetch(`/api/agent/documents/${id}/file`),
    matchDocument: (id, data) =>
      authFetch(`/api/agent/documents/${id}/match`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).then(handle),
    dismissDocument: (id) =>
      authFetch(`/api/agent/documents/${id}/dismiss`, { method: 'POST' }).then(handle),
    proposeApplyDocument: (id) =>
      authFetch(`/api/agent/documents/${id}/propose-apply`, { method: 'POST' }).then(handle),
    // Phase 5 — payer-call copilot (WS2).
    callBrief: (claimId) => get(`/api/agent/claims/${claimId}/call-brief`),
    logCall: (claimId, data) =>
      authFetch(`/api/agent/claims/${claimId}/call-log`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).then(handle),
    // Phase 5 — manager's agent (WS3). 403s for members; callers hide.
    teamInsights: () => get('/api/agent/team-insights'),
    // Phase 5 — CSV import wizard (WS4).
    importPreview: (file) => {
      const fd = new FormData();
      fd.append('file', file);
      return authFetch('/api/agent/import/preview', { method: 'POST', body: fd }).then(handle);
    },
    importRemap: (id, mapping) =>
      authFetch(`/api/agent/import/preview/${id}/mapping`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapping }),
      }).then(handle),
    importCommit: (previewId) =>
      authFetch('/api/agent/import/commit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preview_id: previewId }),
      }).then(handle),
    importTemplate: () => authFetch('/api/agent/import/template'),
    // Phase 5 — deadline audit (WS5).
    runAudit: (data) =>
      authFetch('/api/agent/audit/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).then(handle),
    audits: () => get('/api/agent/audit'),
    audit: (id) => get(`/api/agent/audit/${id}`),
  },
};

export const csvUrl = (path) => path; // auth via cookie-less; use fetch for authed CSV

export const fmtMoney = (n) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);

// Compact money for tight KPI cards: $4.25M, $380K, $1.10B
export const fmtMoneyCompact = (n) => {
  n = Number(n) || 0;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return fmtMoney(n);
};

export const fmtMoney2 = (n) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n || 0);

// Org date-format preference (set at boot from the org profile; defaults to MM/DD/YYYY).
let orgDateFormat = 'MM/DD/YYYY';
export const setOrgDateFormat = (f) => {
  if (['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'].includes(f)) orgDateFormat = f;
};

export const fmtDate = (d) => {
  if (!d) return '—';
  // Accepts date-only ('2026-10-26'), SQLite datetimes ('2026-10-26 12:10:32')
  // and ISO strings — appending 'T12:00:00' to a datetime produced
  // "Invalid Date" (e.g. ERA upload timestamps).
  const s = String(d);
  const dt = new Date(s.includes('T') ? s : s.includes(' ') ? s.replace(' ', 'T') : s + 'T12:00:00');
  if (orgDateFormat === 'YYYY-MM-DD') {
    const p = (n) => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  }
  if (orgDateFormat === 'DD/MM/YYYY') {
    return dt.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  return dt.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
};
