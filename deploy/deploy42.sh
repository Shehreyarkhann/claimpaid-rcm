#!/usr/bin/env bash
# Deploy #42 bootstrap — EHR auto-pull (athenahealth closed encounters -> draft claims).
set -euo pipefail
export DOMAIN="claimpaid.io"
export APP_DIR="/opt/claimpaid"
export CERTBOT_EMAIL="shehreyarkhann@outlook.com"
export REPO_URL="https://github.com/Shehreyarkhann/claimpaid-rcm.git"
export AI_REPO_URL="https://github.com/Shehreyarkhann/claimpaid-ai.git"
export SUPERADMIN_EMAIL="shehreyarkhann@outlook.com"
cd /tmp
curl -sSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup-42.sh
chmod +x vps-setup-42.sh
if [ -n "${FOREGROUND:-}" ]; then
  bash vps-setup-42.sh 2>&1 | tee /tmp/deploy42.log
else
  nohup bash vps-setup-42.sh > /tmp/deploy42.log 2>&1 &
  echo "deploy42 started in background — tail with: tail -f /tmp/deploy42.log"
fi
