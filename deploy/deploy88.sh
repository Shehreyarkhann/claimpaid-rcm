#!/usr/bin/env bash
# Deploy #88: Landing — agent-era rewrite. Home: agent-naming hero
# support copy, Meet your agent section, rebuilt 23-card platform grid,
# Learns-your-payers section, billing-companies section, free deadline
# audit CTA, trust rewritten to mechanics (approval-gated writes, audit
# log, per-workspace isolation). AI page (AI repo): handbook + verified
# coding framing. Compare + llms.txt aligned (local-first story RETIRED
# — it stopped being true with the agent; criterion 5 is now AI agent
# safeguards, new criterion 6: agent works the queue). Corrections: Pro
# seats "Unlimited" -> up to 15 (the real limit); hero float card
# de-proofed (no won-appeal claim with zero customers); stale Availity /
# local-AI FAQ answers removed. NO invented proof anywhere: no
# testimonials, no recovery percentages, no compliance overclaims
# (grep-verified: no "HIPAA compliant", no SOC 2, no guarantee).
# Commits: RCM bf95dec + 105e282, AI eea7a3e.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup88.sh
nohup bash vps-setup88.sh > /tmp/deploy88.log 2>&1 &
echo "deploy88 started, log: /tmp/deploy88.log"
