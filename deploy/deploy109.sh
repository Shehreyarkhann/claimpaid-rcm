#!/usr/bin/env bash
# Deploy #109 — revert the home page to the pre-#107 version (founder verdict:
# the old landing was better). Restores landing/index.html from the #106-era
# tree and removes the ten #107 shot-*.webp cards. Everything else from
# #107/#108 (the seven /deadlines/<payer>/ pages, hub links, sitemap,
# llms.txt) stays. Self-contained bootstrap: exports everything
# vps-setup.sh needs.
set -euo pipefail

export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main

curl -fsSL "https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/${BRANCH}/deploy/vps-setup.sh" -o /tmp/vps-setup.sh
chmod +x /tmp/vps-setup.sh

nohup /tmp/vps-setup.sh > /tmp/deploy109.log 2>&1 &
echo "deploy109 started — log: /tmp/deploy109.log"
