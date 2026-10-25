#!/usr/bin/env bash
# Deploy #50: Patient statements + Stripe Payment Links ($0 plan step 6).
# Balances from ERA patient responsibility -> statement -> PDF -> Stripe
# payment link -> self-settling via the billing webhook; manual cash/check
# recording with oldest-first allocation. Bootstrap is SELF-CONTAINED
# (exports DOMAIN/REPO_URL/AI_REPO_URL) per the deploy #48/#49 lesson.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
SCRIPT_URL="https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/${BRANCH}/deploy/vps-setup.sh"
LOG=/tmp/deploy50.log
echo "Starting deploy #50 in background — log: $LOG"
nohup bash -c "curl -sSL '$SCRIPT_URL' | bash" > "$LOG" 2>&1 &
echo "PID $! — watch with: tail -f $LOG"
