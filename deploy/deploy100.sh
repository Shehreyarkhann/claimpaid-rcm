#!/usr/bin/env bash
# Deploy #100 — the ACCOUNT model: plan, trial, seats and quotas belong to
# the account, never to a workspace.
#   - Workspaces inherit the account plan + trial window at creation;
#     creation is gated by the account workspace limit (Starter 1, Pro 3,
#     AI 1, Enterprise unlimited) — over-limit accounts are grandfathered.
#   - Seats count unique people on the account roster (Starter now 5);
#     account team endpoints (roster, grant/revoke, share-team switch).
#   - Claims/month + AI-uses/month are ACCOUNT POOLS with a per-workspace
#     breakdown on the Billing page (AskBase gate pools the same way).
#   - Carries deploy #99 (appeal-letter save + labeling) — deploy99.sh is
#     superseded by this script and removed in the same commit.
# Self-contained bootstrap: exports every variable vps-setup.sh requires,
# fetches it fresh from GitHub main, runs it detached.
set -euo pipefail

export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main

cd /tmp
curl -fsSL "https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh" -o /tmp/vps-setup.sh
chmod +x /tmp/vps-setup.sh
nohup bash /tmp/vps-setup.sh > /tmp/deploy100.log 2>&1 &
echo "Deploy #100 started detached — log: /tmp/deploy100.log (pid $!)"
