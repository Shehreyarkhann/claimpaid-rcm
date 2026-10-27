#!/usr/bin/env bash
# Deploy #74: Stedi eligibility vendor (Phase 1) — 'stedi' joins the
# eligibility vendor registry beside availity/rest: 271 JSON mapper modeled
# on mapAvailityCoverage, payer IDs from the org payer map or resolved via
# Stedi's Payers API (exact displayName match, cached), AAA errors mapped to
# the coverage-inactive result, one structured metering log line per check
# (billable flag mirrors Stedi: test mode and AAA 42/79/80 are not billed).
# The Stedi API key is a PLATFORM credential: it comes from the server env
# (STEDI_API_KEY) only — it is never in this script, the DB, or any payload.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup74.sh
nohup bash vps-setup74.sh > /tmp/deploy74.log 2>&1 &
echo "deploy74 started, log: /tmp/deploy74.log"
echo "REMINDER: STEDI_API_KEY must be present in the prod server .env (/opt/claimpaid-rcm/server/.env) or the Stedi vendor reports itself unconfigured."
echo "REMINDER: enable Stedi per org in Organization settings -> Eligibility vendor (nothing else to paste; the key is server-side only)."
