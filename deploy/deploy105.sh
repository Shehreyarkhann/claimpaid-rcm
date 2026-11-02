#!/usr/bin/env bash
# Deploy 105: Stedi submission pipe (Phase A complete except production key)
# + Denial Copilot rules (Phase B: auto-correct, one-click rules, agent tool).
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup105.sh
chmod +x vps-setup105.sh
nohup bash vps-setup105.sh > /tmp/deploy105.log 2>&1 &
echo "deploy 105 running detached — tail /tmp/deploy105.log"
