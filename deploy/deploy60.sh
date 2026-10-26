#!/bin/bash
# deploy60.sh — plan switching: POST /api/billing/change-plan (Stripe price
# swap with proration / instant trial flip / checkout for canceled orgs),
# billing-page switch picker for active subscribers, plan-switch doors on
# both product lockout screens. Self-contained exports.
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
nohup bash -c 'curl -sSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh | bash' > /tmp/deploy60.log 2>&1 &
echo "deploy60 started — tail with: tail -f /tmp/deploy60.log"
