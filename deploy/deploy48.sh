#!/usr/bin/env bash
# Deploy #48: Availity demo HOSTS. /demo/v1 on the production host 404'd
# live, so Demo becomes two documented hosts — tst.api.availity.com/v1
# (Availity Getting Started test host) and qua.api.availity.com/availity/v1
# (QUA developer docs). The org's stored "demo" value now aliases to the
# tst host, so the next live check goes there with no settings change; if
# it 404s, switch Environment to the QA host and re-run. Token fallback to
# the shared production auth host applies to both demo hosts.
set -euo pipefail
export BRANCH=main
SCRIPT_URL="https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/${BRANCH}/deploy/vps-setup.sh"
LOG=/tmp/deploy48.log
echo "Starting deploy #48 in background — log: $LOG"
nohup bash -c "curl -sSL '$SCRIPT_URL' | bash" > "$LOG" 2>&1 &
echo "PID $! — watch with: tail -f $LOG"
