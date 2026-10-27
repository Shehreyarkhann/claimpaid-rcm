#!/usr/bin/env bash
# Deploy #77: statement pay link hotfix.
# - statements-core: Stripe Payment Links create used the legacy parameter
#   name `after_payment`, which the current Stripe API rejects (live 502:
#   "Received unknown parameter: after_payment. Did you mean
#   after_completion?"). Renamed to `after_completion`; statements suite
#   now asserts the parameter shape so a fake Stripe can never pass it
#   silently again. Verified live after deploy by creating a real payment
#   link on the Harborview demo statement.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup77.sh
nohup bash vps-setup77.sh > /tmp/deploy77.log 2>&1 &
echo "deploy77 started, log: /tmp/deploy77.log"
