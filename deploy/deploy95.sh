#!/usr/bin/env bash
# Deploy #95: Remove the Agent-section detail crops entirely (founder
# call — no screenshots or crops in the AI/agent section). The
# .agent-crops block and its CSS come out of the landing #agent section
# and product-agent-card.webp / product-agent-plan.webp are deleted;
# the section returns to headline + intro + bento cards. Nothing else
# on the page changes.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup95.sh
nohup bash vps-setup95.sh > /tmp/deploy95.log 2>&1 &
echo "deploy95 started, log: /tmp/deploy95.log"
