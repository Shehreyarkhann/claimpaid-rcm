#!/usr/bin/env bash
# Deploy #99: (1) The Denials drawer's manually generated appeal letter
# gains "Save to appeal letter" — it saves through the #98 PUT letter
# endpoint into the saved-letter panel (Edit/Print/Mark as submitted),
# with an explicit inline confirm before replacing an existing saved
# letter. (2) One-time labeling pass (appeal-letter-label-99): full
# draft letters left as plain notes on appeals that HAVE a letter get
# the executor's 'Additional draft letter (agent)' prefix, so leftover
# drafts no longer read like comment dumps. Prefix only — no text
# moved or deleted; letterless appeals untouched.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup99.sh
nohup bash vps-setup99.sh > /tmp/deploy99.log 2>&1 &
echo "deploy99 started, log: /tmp/deploy99.log"
