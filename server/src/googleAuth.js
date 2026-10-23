// Google Identity Services — ID token verification.
// Verifies the JWT signature against Google's published certs
// (https://www.googleapis.com/oauth2/v3/certs, cached in memory ~1h),
// then validates aud/iss/exp/email_verified.
const jwt = require('jsonwebtoken');

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const CERT_CACHE_MS = 3600_000;
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

let certCache = { keys: null, fetchedAt: 0 };
// Test-only hook: lets API tests inject certs without network access.
let testCerts = null;
function _setTestCerts(keys) { testCerts = keys; }

function jwkToPem(jwk) {
  // x5c[0] is the DER-encoded certificate (base64)
  const derB64 = jwk.x5c[0];
  const wrapped = derB64.replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${wrapped}\n-----END CERTIFICATE-----\n`;
}

async function getGoogleCerts() {
  if (testCerts) return testCerts;
  const now = Date.now();
  if (certCache.keys && now - certCache.fetchedAt < CERT_CACHE_MS) return certCache.keys;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error('Could not fetch Google signing certs');
  const jwks = await res.json();
  if (!jwks.keys || !jwks.keys.length) throw new Error('No Google signing certs available');
  certCache = { keys: jwks.keys, fetchedAt: now };
  return jwks.keys;
}

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  throw e;
}

/**
 * Verify a Google ID token. Returns the token claims on success.
 * Throws with .status = 503 when GOOGLE_CLIENT_ID is not configured,
 * .status = 401 for any verification failure.
 */
async function verifyGoogleIdToken(idToken) {
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
  if (!clientId) fail(503, 'Google sign-in is not configured yet.');

  let decoded;
  try {
    decoded = jwt.decode(idToken, { complete: true });
  } catch {
    decoded = null;
  }
  if (!decoded || !decoded.header || !decoded.header.kid) fail(401, 'Google token could not be read. Please try signing in again.');

  let keys;
  try {
    keys = await getGoogleCerts();
  } catch {
    fail(502, 'Could not verify Google token right now. Please try again.');
  }
  const jwk = keys.find((k) => k.kid === decoded.header.kid && k.x5c && k.x5c[0]);
  if (!jwk) fail(401, 'Google signing key not found for this token. Please try signing in again.');

  let payload;
  try {
    payload = jwt.verify(idToken, jwkToPem(jwk), { algorithms: ['RS256'] });
  } catch {
    fail(401, 'Google token signature check failed. Please try signing in again.');
  }

  if (payload.aud !== clientId) fail(401, 'This Google sign-in was set up for a different app.');
  if (!GOOGLE_ISSUERS.includes(payload.iss)) fail(401, 'Invalid Google token.');
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    fail(401, 'Your Google account email is not verified.');
  }
  if (!payload.email) fail(401, 'Invalid Google token.');
  return payload; // exp is validated by jwt.verify
}

module.exports = { verifyGoogleIdToken, _setTestCerts };
