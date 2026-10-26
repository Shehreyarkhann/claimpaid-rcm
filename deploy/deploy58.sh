#!/bin/bash
# deploy58.sh — branded ClaimPaid transactional email (logo template, ClaimPaid
# subjects/copy, SMTP timeouts so a stalled mail connection can never hang a
# request again). Self-contained: exports every var vps-setup.sh requires.
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
nohup bash -c 'curl -sSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh | bash' > /tmp/deploy58.log 2>&1 &
echo "deploy58 started — tail with: tail -f /tmp/deploy58.log"
