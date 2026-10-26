#!/bin/bash
# deploy57.sh — account menu: profile photo, profile edit, change password, log out everywhere (deploy #57).
# Self-contained: exports every var vps-setup.sh requires (lesson #48).
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
nohup bash -c 'curl -sSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh | bash' > /tmp/deploy57.log 2>&1 &
echo "deploy57 started — tail with: tail -f /tmp/deploy57.log"
