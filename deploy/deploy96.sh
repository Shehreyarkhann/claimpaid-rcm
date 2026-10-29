#!/usr/bin/env bash
# Deploy #96: Install the Cloudflare Web Analytics beacon on every
# public page and both app shells — all landing pages (home, compare,
# blog index + articles), the RCM app shell, the AI landing page, and
# the AI app shell. Manual JS-snippet mode (DNS is gray-cloud, so
# Cloudflare cannot auto-inject). Content change only; no app code.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup96.sh
nohup bash vps-setup96.sh > /tmp/deploy96.log 2>&1 &
echo "deploy96 started, log: /tmp/deploy96.log"
