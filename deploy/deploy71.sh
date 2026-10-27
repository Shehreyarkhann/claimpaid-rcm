#!/usr/bin/env bash
# Deploy #71: AI landing gets the same logged-in redirect as #70 — a valid
# session token (pulse_token or askbase_token; one shared login) sends
# claimpaid.io/ai/ straight to /ai/app/. Blog and compare stay public.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup71.sh
nohup bash vps-setup71.sh > /tmp/deploy71.log 2>&1 &
echo "deploy71 started, log: /tmp/deploy71.log"
