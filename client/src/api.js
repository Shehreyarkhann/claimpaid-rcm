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
  unworkedDenials: () => get('/api/appeals/unworked-denials'),
  dueFollowups: () => get('/api/appeals/due'),
  team: () => get('/api/auth/team'),
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
  setFilingRule: (payerId, filing_days, notes) =>
    authFetch(`/api/filing/rules/${payerId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filing_days, notes }),
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
  },
  billingPortal: () =>
    authFetch('/api/billing/portal', { method: 'POST' }).then(handle),
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
    connectDemo: () =>
      authFetch('/api/ehr/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'demo' }) }).then(handle),
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
  const dt = new Date(d + 'T12:00:00');
  if (orgDateFormat === 'YYYY-MM-DD') {
    const p = (n) => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  }
  if (orgDateFormat === 'DD/MM/YYYY') {
    return dt.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  return dt.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
};
