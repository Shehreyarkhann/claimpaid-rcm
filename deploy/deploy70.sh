#!/usr/bin/env bash
# Deploy #70: logged-in visitors hitting claimpaid.io are redirected straight
# to /app (early head script reads the session token; valid + unexpired ->
# location.replace('/app/'); logged out or expired -> landing as normal).
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup70.sh
nohup bash vps-setup70.sh > /tmp/deploy70.log 2>&1 &
echo "deploy70 started, log: /tmp/deploy70.log"
