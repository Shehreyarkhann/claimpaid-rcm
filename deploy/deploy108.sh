#!/usr/bin/env bash
# Deploy #108 — ClaimPaid AEO/visibility pack.
# Seven payer timely-filing pages under /deadlines/<payer>/ (question-titled,
# direct answer first, three-clock table, FAQ + FAQPage schema), hub table
# names linked to them, sitemap 67 -> 74 URLs, llms.txt payer entries.
# Self-contained bootstrap: exports everything vps-setup.sh needs.
set -euo pipefail

export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main

curl -fsSL "https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/${BRANCH}/deploy/vps-setup.sh" -o /tmp/vps-setup.sh
chmod +x /tmp/vps-setup.sh

nohup /tmp/vps-setup.sh > /tmp/deploy108.log 2>&1 &
echo "deploy108 started — log: /tmp/deploy108.log"
