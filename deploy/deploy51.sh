#!/usr/bin/env bash
# Deploy #51: 837 claim-file import — the universal inbound adapter.
# Any EHR/PM system exports 837s; ClaimPaid now parses them straight
# into the worklist (dedupe by claim number, payer match-or-create
# reported, dependent-patient hierarchies honored). Bootstrap is
# SELF-CONTAINED (exports DOMAIN/REPO_URL/AI_REPO_URL) per the
# deploy #48/#49 lesson.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
SCRIPT_URL="https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/${BRANCH}/deploy/vps-setup.sh"
LOG=/tmp/deploy51.log
echo "Starting deploy #51 in background — log: $LOG"
nohup bash -c "curl -sSL '$SCRIPT_URL' | bash" > "$LOG" 2>&1 &
echo "PID $! — watch with: tail -f $LOG"
