#!/usr/bin/env bash
# deploy98.sh — Deploy #98: appeal letters land on the appeal (not in the
# notes timeline), Denial Appeals gains the letter panel (edit / print /
# mark-submitted), a shared ClaimDetailsModal wired into Denials, Agent,
# MyWork, Claims and ERA, and the claims detail API carries filing +
# appeal + ERA summaries. Includes the guarded one-time repair that
# moves legacy full-letter notes into appeals.letter.
# Self-contained bootstrap: exports every var vps-setup.sh requires,
# pulls vps-setup.sh fresh from main, runs detached.
set -euo pipefail

export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main

cd /tmp
curl -fsSL "https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh" -o vps-setup98.sh
chmod +x vps-setup98.sh
nohup bash vps-setup98.sh > /tmp/deploy98.log 2>&1 &
echo "deploy98 started — log: /tmp/deploy98.log"
