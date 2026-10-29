#!/usr/bin/env bash
# Deploy #103 — public deadline audit tool (/audit/) + denial code library
# (/denial-codes/, /deadlines/). Self-contained bootstrap: exports every
# variable vps-setup.sh requires, fetches it fresh from main, runs detached.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup103.sh
chmod +x vps-setup103.sh
nohup ./vps-setup103.sh > /tmp/deploy103.log 2>&1 &
echo "Deploy #103 started detached — log: /tmp/deploy103.log (pid $!)"
