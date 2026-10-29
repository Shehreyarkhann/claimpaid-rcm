#!/usr/bin/env bash
# Deploy #94: Landing — replace the full-width Agent screenshot in the
# #agent section with two detail crops (the HV-1015 approval card and the
# morning brief's ranked plan), framed side by side on desktop with the
# card offset upward, stacked on mobile. product-agent.webp is removed;
# no copy changes anywhere else on the page.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup94.sh
nohup bash vps-setup94.sh > /tmp/deploy94.log 2>&1 &
echo "deploy94 started, log: /tmp/deploy94.log"
