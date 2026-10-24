#!/usr/bin/env bash
# Deploy #49: same payload as #48 (Availity demo hosts tst/qua) with the
# FULL bootstrap env restored. #48 failed twice with
# "DOMAIN: Set DOMAIN" — vps-setup.sh hard-requires DOMAIN, REPO_URL and
# AI_REPO_URL; earlier bootstraps exported them, #46-#48 didn't and only
# passed because the console shell had them exported from a prior run.
# A fresh login loses those, so the bootstrap must carry them itself.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
SCRIPT_URL="https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/${BRANCH}/deploy/vps-setup.sh"
LOG=/tmp/deploy49.log
echo "Starting deploy #49 in background — log: $LOG"
nohup bash -c "curl -sSL '$SCRIPT_URL' | bash" > "$LOG" 2>&1 &
echo "PID $! — watch with: tail -f $LOG"
