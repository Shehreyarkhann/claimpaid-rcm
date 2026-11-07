#!/usr/bin/env bash
# Deploy #111 — mobile repair for the #110 home page: pricing comparison
# table gets touch scrolling + sticky row labels + edge fade on phones,
# platform accordion headers realigned at phone widths, iOS hardening
# (text-size-adjust, overflow-x clip net, footer tap targets, AI slip
# clipping). CSS/layout only — no copy changes. Self-contained bootstrap.
set -euo pipefail

export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main

curl -fsSL "https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/${BRANCH}/deploy/vps-setup.sh" -o /tmp/vps-setup.sh
chmod +x /tmp/vps-setup.sh

nohup /tmp/vps-setup.sh > /tmp/deploy111.log 2>&1 &
echo "deploy111 started — log: /tmp/deploy111.log"
