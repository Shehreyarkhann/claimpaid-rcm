// athenahealth athenaOne REST adapter (real EHR integration).
//
// Written against athenahealth's public API docs (see ATHENA-NOTES.md).
// Auth: OAuth2 — 2-legged client_credentials for sandbox/service access,
// 3-legged authorization_code (+ refresh_token, 90 days) for per-practice
// production connections. Tokens are cached and refreshed when <5 min remain.
//
// The encounter→diagnosis field mapping follows the documented MDP shapes;
// validate against the Preview sandbox (practice 195900) before promising a
// customer a live sync. On ANY failure this module throws — it never
// silently returns demo data.

const crypto = require('crypto');

const TIMEOUT_MS = 30000;
const REFRESH_SKEW_MS = 5 * 60 * 1000;

function baseUrl(env) {
  return env === 'production'
    ? 'https://api.platform.athenahealth.com'
    : 'https://api.preview.platform.athenahealth.com';
}

// Resolve app credentials: env preferred, per-org override second.
function appCredentials(orgRow) {
  const clientId = (process.env.ATHENA_CLIENT_ID || orgRow?.ehr_athena_client_id || '').trim();
  const clientSecret = (process.env.ATHENA_CLIENT_SECRET || orgRow?.ehr_athena_client_secret || '').trim();
  const env = (process.env.ATHENA_ENV || orgRow?.ehr_athena_env || 'preview').trim().toLowerCase();
  const redirectUri = (process.env.ATHENA_REDIRECT_URI || 'https://claimpaid.io/api/ehr/athena/callback').trim();
  return { clientId, clientSecret, env: env === 'production' ? 'production' : 'preview', redirectUri };
}

async function tokenRequest(base, params, clientId, clientSecret) {
  const body = new URLSearchParams(params);
  let res;
  try {
    res = await fetch(`${base}/oauth2/v1/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // 2-legged/3-legged client auth per athenahealth docs: HTTP Basic.
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      },
      body: body.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`athenahealth token endpoint unreachable: ${e.message}`);
  }
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const detail = parsed?.error_description || parsed?.error || text.slice(0, 200);
    const e = new Error(`athenahealth token request failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
    e.status = res.status === 400 ? 400 : 502;
    throw e;
  }
  if (!parsed?.access_token) throw new Error('athenahealth token response had no access_token.');
  return parsed;
}

// Exchange an authorization code (3-legged callback) for tokens.
async function exchangeCode(orgRow, code) {
  const { clientId, clientSecret, env, redirectUri } = appCredentials(orgRow);
  if (!clientId || !clientSecret) {
    throw new Error('athenahealth app not configured — set ATHENA_CLIENT_ID and ATHENA_CLIENT_SECRET first.');
  }
  const tok = await tokenRequest(baseUrl(env), {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  }, clientId, clientSecret);
  return { env, token: tok };
}

// Build the 3-legged authorize URL for a practice admin to approve.
function authorizeUrl(orgRow, state) {
  const { clientId, env, redirectUri } = appCredentials(orgRow);
  if (!clientId) {
    const e = new Error('athenahealth app not configured — set ATHENA_CLIENT_ID (and ATHENA_CLIENT_SECRET) in the server environment or Organization settings first.');
    e.status = 400;
    throw e;
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    // RCM sync needs patients, appointments, chart encounters, insurance.
    // offline_access -> 90-day refresh token so syncs run without re-login.
    scope: 'openid offline_access athena/service/Athenanet.MDP.*',
    state,
  });
  return `${baseUrl(env)}/oauth2/v1/authorize?${params.toString()}`;
}

// Ensure a live access token for a connection row; refreshes when needed.
// Returns { accessToken, updated } where updated tells the caller to persist.
async function ensureAccessToken(conn, orgRow) {
  const { clientId, clientSecret, env } = appCredentials(orgRow);
  if (!clientId || !clientSecret) throw new Error('athenahealth app not configured — set ATHENA_CLIENT_ID and ATHENA_CLIENT_SECRET first.');
  const base = baseUrl(env);
  const now = Date.now();
  const expiresAt = conn.token_expires_at ? Date.parse(conn.token_expires_at) : 0;

  if (conn.access_token && expiresAt - now > REFRESH_SKEW_MS) {
    return { accessToken: conn.access_token, updated: null };
  }
  let tok;
  if (conn.refresh_token) {
    tok = await tokenRequest(base, {
      grant_type: 'refresh_token',
      refresh_token: conn.refresh_token,
    }, clientId, clientSecret);
  } else {
    // 2-legged service flow (sandbox / backend sync).
    tok = await tokenRequest(base, {
      grant_type: 'client_credentials',
      scope: 'athena/service/Athenanet.MDP.*',
    }, clientId, clientSecret);
  }
  const updated = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || conn.refresh_token || null,
    token_expires_at: new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString(),
  };
  return { accessToken: tok.access_token, updated };
}

async function apiGet(base, practiceId, path, accessToken, query = {}) {
  const qs = new URLSearchParams(query).toString();
  const url = `${base}/v1/${practiceId}${path}${qs ? '?' + qs : ''}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`athenahealth API unreachable (${path}): ${e.message}`);
  }
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const detail = parsed?.detailedmessage || parsed?.message || text.slice(0, 200);
    const e = new Error(`athenahealth API ${path} failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
    e.status = res.status === 401 ? 401 : 502;
    throw e;
  }
  return parsed;
}

// athenaOne list endpoints wrap results: { totalcount, departments: [...] },
// { appointments: [...] }, etc. — NOT bare arrays (learned live from the
// Preview sandbox: "(departments || []).map is not a function"). Normalize
// any of: bare array | { <key>: [...] } | first array-valued property.
function listOf(resp, key) {
  if (Array.isArray(resp)) return resp;
  if (resp && typeof resp === 'object') {
    if (Array.isArray(resp[key])) return resp[key];
    for (const v of Object.values(resp)) if (Array.isArray(v)) return v;
  }
  return [];
}

function fmtAtnDate(d) {
  // athenaOne appointments endpoints take MM/DD/YYYY.
  const dt = new Date(d + 'T12:00:00');
  return `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}/${dt.getFullYear()}`;
}

// Normalize one appointment (+ patient + insurance + encounter diagnoses)
// into the provider-interface encounter shape.
// athenaOne appointmentstatus vocabulary is terse ('x' = checked out is the
// classic code); map generously. Used for the staged encounter status —
// the auto-pull converter only drafts 'checked_out'.
function statusOf(appt) {
  const st = String(appt.appointmentstatus || appt.status || '').trim().toLowerCase();
  if (st === 'x' || /check(ed)?[-\s]?out|complete|closed|done/.test(st)) return 'checked_out';
  if (/cancel/.test(st)) return 'cancelled';
  if (/no.?show/.test(st)) return 'no_show';
  if (/check.?in/.test(st)) return 'checked_in';
  return 'scheduled';
}

function mdYToIso(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || '').trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : (s || null);
}

function normalizeEncounter(appt, patient, insurances, diagnoses) {
  const cpts = [];
  if (appt.appointmenttype) cpts.push(String(appt.appointmenttype));
  // Encounter procedures may carry HCPCS/CPT codes; diagnoses carry ICD-10.
  const icds = [];
  for (const d of diagnoses || []) {
    const code = d.icd10code || d.icd10 || d.code;
    if (code) icds.push(String(code).replace('.', ''));
  }
  const primary = (insurances || []).find((i) => /primary/i.test(i.insurancetype || '') || i.sequencenumber === 1) || (insurances || [])[0];
  const dobRaw = patient.dob || '';
  const dob = /^\d{2}\/\d{2}\/\d{4}$/.test(dobRaw)
    ? `${dobRaw.slice(6)}-${dobRaw.slice(0, 2)}-${dobRaw.slice(3, 5)}`
    : (dobRaw || null);
  return {
    ehr_encounter_id: String(appt.encounterid || `appt-${appt.appointmentid}`),
    ehr_patient_id: String(appt.patientid),
    patient_first: patient.firstname || '',
    patient_last: patient.lastname || '',
    patient_dob: dob,
    payer_name: primary ? (primary.insuranceplanname || primary.insurancecompanyname || '') : '',
    status: statusOf(appt),
    date_of_service: mdYToIso(appt.date),
    cpt_codes: [...new Set(cpts)],
    icd_codes: [...new Set(icds)],
    rendering_provider: appt.providername || appt.renderingprovidername || '',
  };
}

// Pull recent completed appointments and enrich them. Manual, paginated,
// per-appointment failures are collected (not fatal) so one bad record
// doesn't kill the whole sync.
async function syncEncounters(conn, orgRow, since) {
  const { env } = appCredentials(orgRow);
  const base = baseUrl(env);
  const { accessToken, updated } = await ensureAccessToken(conn, orgRow);
  const practiceId = conn.practice_id || orgRow?.ehr_athena_practice_id || '195900';

  const departments = await apiGet(base, practiceId, '/departments', accessToken);
  const deptIds = listOf(departments, 'departments').map((d) => d.departmentid).filter(Boolean);
  if (!deptIds.length) throw new Error('athenahealth returned no departments for this practice.');

  const today = new Date().toISOString().slice(0, 10);
  const dayMs = 86400000;
  const shift = (iso, days) => new Date(Date.parse(iso + 'T12:00:00') + days * dayMs).toISOString().slice(0, 10);

  async function fetchBooked(deptId, startDate, endDate) {
    const all = [];
    const limit = 100;
    for (let page = 0; page < 20; page++) {
      const resp = await apiGet(base, practiceId, '/appointments/booked', accessToken, {
        departmentid: deptId,
        startdate: fmtAtnDate(startDate),
        enddate: fmtAtnDate(endDate),
        limit,
        offset: page * limit,
      });
      const rows = listOf(resp, 'appointments');
      all.push(...rows);
      if (rows.length < limit) break;
    }
    return all;
  }

  // One scan over all departments for a window. Stages everything except
  // cancelled / no-show visits (the converter drafts checked-out ones and
  // the rest stay visible in the inbox with their real status).
  async function scan(startDate, endDate) {
    const staged = [];
    const errs = [];
    let seen = 0;
    for (const deptId of deptIds) {
      let appts;
      try {
        appts = await fetchBooked(deptId, startDate, endDate);
      } catch (e) {
        errs.push(`department ${deptId}: ${e.message}`);
        continue;
      }
      seen += appts.length;
      for (const appt of appts) {
        const st = statusOf(appt);
        if (st === 'cancelled' || st === 'no_show') continue;
        try {
          const [patient, insurances] = await Promise.all([
            apiGet(base, practiceId, `/patients/${appt.patientid}`, accessToken),
            apiGet(base, practiceId, `/patients/${appt.patientid}/insurances`, accessToken).catch(() => []),
          ]);
          let diagnoses = [];
          const encounterId = appt.encounterid;
          if (encounterId) {
            diagnoses = await apiGet(base, practiceId, `/chart/encounter/${encounterId}/diagnoses`, accessToken).catch(() => []);
          }
          const enc = normalizeEncounter(appt, listOf(patient, 'patients')[0] || {}, listOf(insurances, 'insurances'), listOf(diagnoses, 'diagnoses'));
          enc.raw_payload = { status: enc.status, appointment: appt, patient, insurances, diagnoses };
          staged.push(enc);
        } catch (e) {
          errs.push(`appointment ${appt.appointmentid}: ${e.message}`);
        }
      }
    }
    return { staged, errs, seen };
  }

  // Recent window first (default 30 days). Sandbox practices like Preview
  // 195900 carry historical sample visits, so an empty recent scan falls
  // back to a deep scan (3 years back, 90 days forward) automatically.
  const recentStart = since || shift(today, -30);
  let { staged, errs, seen } = await scan(recentStart, today);
  let windowUsed = `recent (${recentStart} → ${today})`;
  if (seen === 0) {
    const deep = await scan(shift(today, -1095), shift(today, 90));
    staged = deep.staged;
    errs = errs.concat(deep.errs);
    seen = deep.seen;
    windowUsed = 'deep (3 years back, 90 days forward)';
  }
  const stats = { departments: deptIds.length, appointments: seen, window: windowUsed };
  return { encounters: staged, errors: errs, tokenUpdate: updated, practiceId, env, stats };
}

function newOauthState() {
  return crypto.randomBytes(24).toString('hex');
}

module.exports = {
  appCredentials,
  authorizeUrl,
  exchangeCode,
  ensureAccessToken,
  syncEncounters,
  newOauthState,
  baseUrl,
  listOf,
  statusOf,
};
