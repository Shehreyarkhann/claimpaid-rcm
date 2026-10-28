#!/usr/bin/env bash
# Deploy #83: ClaimPaid Agent Phase 1 (dark-shipped).
# Supersedes nothing — the tree also carries everything from #82 (Connect
# still held) unchanged. New: the in-app RCM agent (agent panel, tools,
# human-approval actions) behind server/src/featureFlags.js agentEnabled():
# every /api/agent route answers 403 AGENT_DISABLED until the server env
# carries AGENT_ENABLED=1 and an ANTHROPIC_API_KEY — set by running
# deploy/set-agent-key.sh on the server after this deploy (prompt-only;
# also pins AGENT_MODEL=claude-haiku-5-5). Tests: agent 51/51, agent jsdom
# smoke PASS (incl. the AGENT_DISABLED state), regressions at baselines
# (worklist-scope 10/10, settings 53/53, statements 41/41, connect 48/48).
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup83.sh
nohup bash vps-setup83.sh > /tmp/deploy83.log 2>&1 &
echo "deploy83 started, log: /tmp/deploy83.log"
