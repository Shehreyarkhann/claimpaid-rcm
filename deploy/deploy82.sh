#!/usr/bin/env bash
# Deploy #82: Stripe Connect ships HELD (founder decision 2026-10-27).
# Supersedes the un-run #81. The full Connect build (#81 contents) is in,
# but dormant behind server/src/featureFlags.js statementPaymentsHeld():
# connect/disconnect/pay-link minting all answer 403 FEATURE_HELD before
# any Stripe call; the Statements "Pay link" button renders disabled with
# the hover "Restricted access — patient payment links are on hold.", and
# Settings -> Payments shows the restricted state from the server payload.
# Re-enable later: STATEMENT_PAYMENTS_HELD=0 in the server env + restart,
# or flip the flag default and deploy. Tests: connect 48/48 (held AND
# unheld states), statements 41/41, settings 53/53.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup82.sh
nohup bash vps-setup82.sh > /tmp/deploy82.log 2>&1 &
echo "deploy82 started, log: /tmp/deploy82.log"
