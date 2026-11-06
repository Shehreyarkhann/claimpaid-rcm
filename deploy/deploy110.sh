#!/usr/bin/env bash
# Deploy #110 — new home page (stamp/ledger editorial design, approved by the
# founder 2026-11-06: no dashboard imagery, real brand stamp artwork, expanded
# agent showcase, full hover/transition polish) + payer-clock wording fix
# (Cigna 90 in-network / 180 out, Anthem 90 most state plans, Humana 365 MA)
# aligned across hub, home, blog, llms.txt, audit tool data and payer pages.
# Product tracker defaults unchanged. Self-contained bootstrap: exports
# everything vps-setup.sh needs.
set -euo pipefail

export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main

curl -fsSL "https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/${BRANCH}/deploy/vps-setup.sh" -o /tmp/vps-setup.sh
chmod +x /tmp/vps-setup.sh

nohup /tmp/vps-setup.sh > /tmp/deploy110.log 2>&1 &
echo "deploy110 started — log: /tmp/deploy110.log"
