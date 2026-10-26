#!/usr/bin/env bash
# Deploy #63: warm editorial landing redesign (main + AI) + P0 fixes
# (real hero counters, real product screenshot, proof slot, NY identity, trust band, 7-payers+custom copy).
# Pricing unchanged ($199/$499/$99) per founder decision 2026-10-26.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup63.sh
nohup bash vps-setup63.sh > /tmp/deploy63.log 2>&1 &
echo "deploy63 started, log: /tmp/deploy63.log"
