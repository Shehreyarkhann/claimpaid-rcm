#!/usr/bin/env bash
# Deploy #84: ClaimPaid Agent Phase 2 — proactive morning brief with
# pre-drafted appeal approvals, Payer Policy Handbook as an agent tool
# (AI repo: POST /api/v1/kb-search, service-JWT like code-assist), and
# AI-query metering (agent_usage merged into usageForOrg; 402 cap only
# where the plan carries an AI allowance — Starter counted, not blocked).
# No new env: rides the AGENT_ENABLED + ANTHROPIC_API_KEY set by #83's
# setter and the code-assist service signer. Tests: agent-phase2 45/45,
# kb-search 19/19, agent (Phase 1) 51/51, AskBase chat-history 26/26,
# jsdom agent smoke PASS (incl. brief section), regressions at baselines
# (worklist-scope 10/10, settings 53/53, statements 41/41, connect 48/48).
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup84.sh
nohup bash vps-setup84.sh > /tmp/deploy84.log 2>&1 &
echo "deploy84 started, log: /tmp/deploy84.log"
