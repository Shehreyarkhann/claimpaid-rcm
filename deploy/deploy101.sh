#!/usr/bin/env bash
# deploy101.sh — Deploy #101: the status-driven core loop (payer
# response windows, ERA feedback won/partial/re-denied, payer-silence
# escalation, Awaiting payer board), scale (approval policy tiers,
# batch decide, ERA pattern resolution, saved import mappings), the
# /super Health tab (metrics rollup + agent cost), and the daily
# rhythm (activation checklist, brief precompute, notification center).
# Self-contained bootstrap: pulls vps-setup.sh fresh from main and runs
# it detached; progress lands in /tmp/deploy101.log on the droplet.
set -euo pipefail

export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main

cd /tmp
curl -fsSL "https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/${BRANCH}/deploy/vps-setup.sh" -o vps-setup101.sh
chmod +x vps-setup101.sh
nohup ./vps-setup101.sh > /tmp/deploy101.log 2>&1 &
echo "deploy101 started — tail the log with: tail -f /tmp/deploy101.log"
