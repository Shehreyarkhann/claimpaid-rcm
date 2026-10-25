#!/bin/bash
# deploy53.sh — fix the AskBase demo cleanup that failed in #52 (deploy #53).
# Self-contained: exports every var vps-setup.sh requires (lesson #48).
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
nohup bash -c 'curl -sSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh | bash' > /tmp/deploy53.log 2>&1 &
echo "deploy53 started — tail with: tail -f /tmp/deploy53.log"
