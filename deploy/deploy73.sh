#!/usr/bin/env bash
# Deploy #73: hero copy final — sub is "Spreadsheets track denials. Dashboards
# display them. ClaimPaid collects them." + mechanism line; problem-section
# headline becomes "Payers are betting you miss the deadline."; NY/Long Island
# positioning removed (landing trust tile + llms.txt) for US-wide coverage.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup73.sh
nohup bash vps-setup73.sh > /tmp/deploy73.log 2>&1 &
echo "deploy73 started, log: /tmp/deploy73.log"
