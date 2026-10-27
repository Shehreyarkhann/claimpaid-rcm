#!/usr/bin/env bash
# Deploy #80: statement pay link, round 3 — pin the Stripe API version.
# Deploy #79's live retest proved (wire capture) that the server DOES send
# managed_payments[enabled]=false, but on the account's default API version
# (2026-09-30.endive) Stripe silently ignores the parameter — it only
# exists from the version it launched in (changelog: dahlia 2026-03-25
# preview). statements-core now pins apiVersion '2026-03-25.preview' on
# the paymentLinks.create call only; subscriptions and everything else
# stay on the account default. Suite 38/38 asserts param + version pin.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup80.sh
nohup bash vps-setup80.sh > /tmp/deploy80.log 2>&1 &
echo "deploy80 started, log: /tmp/deploy80.log"
