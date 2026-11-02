#!/usr/bin/env bash
# Deploy #107 — ClaimPaid landing rebuild (home page only).
# Commure-style scroll experience: near-white design language, real product
# screenshots as floating modal cards, every prior section carried over
# verbatim. Self-contained bootstrap: exports everything vps-setup.sh needs.
set -euo pipefail

export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main

curl -fsSL "https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/${BRANCH}/deploy/vps-setup.sh" -o /tmp/vps-setup.sh
chmod +x /tmp/vps-setup.sh

nohup /tmp/vps-setup.sh > /tmp/deploy107.log 2>&1 &
echo "deploy107 started — log: /tmp/deploy107.log"
