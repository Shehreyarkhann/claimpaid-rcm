# athenahealth API — integration notes (verified Oct 2026)

Researched via athenahealth's own docs (docs.athenahealth.com/api, via the
public API reference pages) and the Nirmitee athenahealth API guide (reviewed
against athenahealth's live docs 25 Sep 2026). Re-check before building
commitments — athenahealth ships bi-weekly with breaking changes ~3x/year.

## Developer program signup (user's steps)

1. Create an athenahealth Developer Portal account (Okta sign-in at
   `myidentity.platform.athenahealth.com`).
2. Open the Developer Console at `developer.api.athena.io` and register an app:
   - Pick the API family: **Certified APIs** (FHIR R4, free, self-service
     production — a practice enables your app itself) vs **athenaOne APIs**
     (proprietary REST under `/v1/{practiceid}/`, billed by call volume,
     needs a Platform Services contract; calling an endpoint you didn't
     validate returns HTTP 402).
   - For RCM encounter pulls we need athenaOne APIs (appointments, chart,
     patient insurance) — i.e. the contract path for production.
   - Register redirect URIs (needed for 3-legged OAuth below). Ours:
     `https://claimpaid.io/api/ehr/athena/callback`
   - Select scopes per API bundle. For 2-legged service access:
     `athena/service/Athenanet.MDP.*`
3. You get preview (sandbox) credentials immediately — practice `195900`
   (ambulatory; `1128700` hospital, `80000` patient-app test). Production
   credentials follow Tech Spec approval + contract + BAA.

## Auth

- Token endpoint: `POST {base}/oauth2/v1/token`,
  `Content-Type: application/x-www-form-urlencoded`.
- Authorize endpoint (3-legged): `GET {base}/oauth2/v1/authorize`
  (athenahealth login widget → consent → redirect with `code`).
- Grant types: `client_credentials` (2-legged, backend sync),
  `authorization_code` + `refresh_token` (3-legged, per-practice).
- 2-legged client auth: HTTP Basic (`client_id:client_secret`) or
  `private_key_jwt` (SMART Backend Services style).
- Access tokens last 60 minutes; 3-legged refresh tokens last 90 days
  (request `offline_access` scope). New 2-legged token requests are capped
  at 50/min (5/min in preview).
- Our adapter caches the token and refreshes when <5 min remains, so we
  stay well under the token-request caps.

## Base URLs

- Preview (sandbox): `https://api.preview.platform.athenahealth.com`
- Production: `https://api.platform.athenahealth.com`
- athenaOne REST: `{base}/v1/{practiceid}/...`
- FHIR R4: `{base}/fhir/r4` (read/search; not used by our RCM sync)

## Endpoints used by the sync (doc-verified)

| Purpose | Endpoint |
|---|---|
| Health check | `GET /v1/{practiceid}/ping` |
| Departments | `GET /v1/{practiceid}/departments` |
| Booked appointments in window | `GET /v1/{practiceid}/appointments/booked?departmentid={id}&startdate={MM/DD/YYYY}&enddate={MM/DD/YYYY}` |
| Appointment detail | `GET /v1/{practiceid}/appointments/{appointmentid}` |
| Patient demographics | `GET /v1/{practiceid}/patients/{patientid}` |
| Patient insurance (payer) | `GET /v1/{practiceid}/patients/{patientid}/insurances` |
| Encounter diagnoses (ICD) | `GET /v1/{practiceid}/chart/encounter/{encounterid}/diagnoses` |
| Encounter documents | `GET /v1/{practiceid}/patients/{patientid}/documents/encounterdocument?departmentid={id}` |
| Providers | `GET /v1/{practiceid}/providers` |

Notes:
- athenaOne APIs take form parameters on writes and return athenaOne-shaped
  JSON (not FHIR).
- The encounter→diagnosis linkage (`encounterid` on the appointment detail)
  and the exact diagnosis/procedure field names should be validated against
  the Preview sandbox (practice 195900) before promising a customer a live
  sync — docs and reality occasionally diverge.
- Rate limits: Preview 15 calls/sec + 50,000/day; Production 150/sec +
  500,000/day; reset at midnight GMT. Our sync is manual and paginated, so
  this is not a concern at RCM volumes.

## Scopes needed (RCM encounter sync)

- 2-legged (sandbox/service): `athena/service/Athenanet.MDP.*`
- 3-legged (per-practice production): the MDP service scopes covering
  patients, appointments, chart encounters, and patient insurance, plus
  `offline_access` for the 90-day refresh token.

## Sandbox credentials approach

- Preview app credentials from the Developer Console work against practice
  `195900` immediately with 2-legged `client_credentials` — no practice
  involvement needed. Use env `ATHENA_ENV=preview`.
- For a real practice: the practice enables the app (certified) or signs
  Authorization & Consent (non-certified), then an admin completes the
  3-legged OAuth flow in ClaimPaid → we store the refresh token → syncs run
  without further logins.

## Deliberately out of scope

- **Epic**: requires certification (~$10k+, 6–12 months) — noted honestly in
  the UI; not built.
- **eClinicalWorks**: partner program enrollment — not built.
- Write-back to the EHR, real-time webhooks/subscriptions, scheduled
  auto-sync (manual sync only for now), patient demographic master sync.
