#!/usr/bin/env bash
# Deploy #97: Agent tab approvals fix — a global "Awaiting your approval"
# section fed by GET /api/agent/actions/pending (pending drafts can no
# longer be counted by the alerts strip yet render nowhere), actionable
# brief plan rows and an expandable Needs-attention panel (Open claim /
# Draft appeal wired through the App deep links), brief plan items
# carrying explicit claim_id/appeal_id, alert highlights carrying claim
# ids, and a Rescue wizard "Review & approve in Agent tab" route that
# lands on the approvals section.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup97.sh
nohup bash vps-setup97.sh > /tmp/deploy97.log 2>&1 &
echo "deploy97 started, log: /tmp/deploy97.log"
