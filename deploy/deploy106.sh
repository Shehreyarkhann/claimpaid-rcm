#!/usr/bin/env bash
# Deploy #106 — Commure-parity Phases C–F (patient payment automation,
# AI data analyst, bulk appeals + grading, prior auth automation).
# Self-contained bootstrap: exports everything vps-setup.sh requires,
# pulls the setup script fresh from GitHub main, runs detached.
set -euo pipefail

export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main

curl -fsSL "https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh" -o /tmp/vps-setup.sh
chmod +x /tmp/vps-setup.sh

nohup bash /tmp/vps-setup.sh > /tmp/deploy106.log 2>&1 &
echo "deploy106 started (pid $!) — log: /tmp/deploy106.log"
