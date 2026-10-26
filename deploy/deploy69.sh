#!/usr/bin/env bash
# Deploy #69: widget header drops its logo (name only) — inside the floating
# chat it repeated the panel header's logo directly above it.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup69.sh
nohup bash vps-setup69.sh > /tmp/deploy69.log 2>&1 &
echo "deploy69 started, log: /tmp/deploy69.log"
