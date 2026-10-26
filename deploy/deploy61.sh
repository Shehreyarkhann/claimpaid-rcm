#!/bin/bash
# deploy61.sh — trial & access policy: ONE 30-day trial per user (window on
# the account, mirrored by every workspace; no re-trials, checkout grants
# no trial days once used); canceling during the trial schedules the end at
# the trial end date with full access until then (never truncates); no
# trial + no plan = plans-only paywall (client gate + server PLAN_REQUIRED
# backstop); fixes the silent JSON Content-Type bug that broke plan
# switching and forced cancels to the default mode. Self-contained exports.
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
nohup bash -c 'curl -sSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh | bash' > /tmp/deploy61.log 2>&1 &
echo "deploy61 started — tail with: tail -f /tmp/deploy61.log"
