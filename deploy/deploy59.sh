#!/bin/bash
# deploy59.sh — FK-safe workspace deletion (schema-discovered sweep, no more
# stale table lists), org-less login recovery (heal + create-workspace gate),
# shared user purge. Self-contained: exports every var vps-setup.sh requires.
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
nohup bash -c 'curl -sSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh | bash' > /tmp/deploy59.log 2>&1 &
echo "deploy59 started — tail with: tail -f /tmp/deploy59.log"
