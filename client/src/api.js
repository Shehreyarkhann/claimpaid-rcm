import { authFetch } from './auth';

async function handle(res) {
  if (res.status === 401) {
    localStorage.removeItem('pulse_token');
    window.location.reload();
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body.errors || [body.error || `API error: ${res.status}`]).join('; '));
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
  // ERA / Digest
  digest: () => get('/api/era/digest'),
  claimDetail: (id) => get(`/api/claims/${id}`),
  // Prior authorizations
  authzList: (params = {}) => get(`/api/authz?${new URLSearchParams(params)}`),
  authzStats: () => get('/api/authz/stats'),
  authzDetail: (id) => get(`/api/authz/${id}`),
  authzFindForClaim: (claimId) => get(`/api/authz/find-for-claim/${claimId}`),
  billingStatus: () => get('/api/billing/status'),
  billingCheckout: (plan, trial = false) =>
    authFetch('/api/billing/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, trial }),
    }).then(handle),
  billingPortal: () =>
    authFetch('/api/billing/portal', { method: 'POST' }).then(handle),
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

export const fmtDate = (d) => {
  if (!d) return '—';
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
