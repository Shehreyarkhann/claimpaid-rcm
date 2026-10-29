#!/usr/bin/env bash
# Deploy #90: Landing condense. The #platform section's 23 equal feature
# cards become 4 grouped cluster panels (Work the queue / Before the claim
# goes out / Money in / Set up in an afternoon, covered from day one) --
# all 23 feature names preserved verbatim as compact rows under one
# benefit line per cluster. No other page section changes.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup90.sh
nohup bash vps-setup90.sh > /tmp/deploy90.log 2>&1 &
echo "deploy90 started, log: /tmp/deploy90.log"
