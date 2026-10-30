#!/usr/bin/env bash
# Deploy 104: unified landing shell — /audit/ rebuilt on the home shell,
# Products nav menu site-wide, phone-responsiveness pass on all landing pages.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup104.sh
chmod +x vps-setup104.sh
nohup bash vps-setup104.sh > /tmp/deploy104.log 2>&1 &
echo "deploy 104 running detached — tail /tmp/deploy104.log"
