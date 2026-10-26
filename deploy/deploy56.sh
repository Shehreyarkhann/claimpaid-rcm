#!/bin/bash
# deploy56.sh — super-admin mobile responsiveness + user-delete FK fix (deploy #56).
# Self-contained: exports every var vps-setup.sh requires (lesson #48).
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
nohup bash -c 'curl -sSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh | bash' > /tmp/deploy56.log 2>&1 &
echo "deploy56 started — tail with: tail -f /tmp/deploy56.log"
