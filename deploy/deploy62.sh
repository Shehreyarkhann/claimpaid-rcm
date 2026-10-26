#!/bin/bash
# deploy62.sh — coding-assist evidence grounding + valid/review/abstain
# (RCM: deterministic evidence verification + tri-state in coding API/UI;
#  AI: abstention bias + verbatim-evidence rule in the code-assist prompt)
# Self-contained: exports every var vps-setup.sh hard-requires.
set -u
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o /tmp/vps-setup62.sh
nohup bash /tmp/vps-setup62.sh > /tmp/deploy62.log 2>&1 &
echo "Deploy #62 started — log: /tmp/deploy62.log"
