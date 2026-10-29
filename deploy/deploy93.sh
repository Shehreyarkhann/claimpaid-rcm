#!/usr/bin/env bash
# Deploy #93: Hero correction (founder feedback on #92). The hero goes
# back to its deploy-91 form — stamp watermark plus the floating stat
# cards (desktop-only) with their float/parallax behavior — and the
# Agent screenshot moves out of the hero into the top of the "Meet your
# agent" section, framed, full width. Footer (single logo lockup) and
# the refreshed dashboard screenshot from #92 are unchanged.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup93.sh
nohup bash vps-setup93.sh > /tmp/deploy93.log 2>&1 &
echo "deploy93 started, log: /tmp/deploy93.log"
