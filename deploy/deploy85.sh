#!/usr/bin/env bash
# Deploy #85: ClaimPaid Agent Phase 3 — pre-claim tools (eligibility /
# scrub / quote-verified coding + apply_codes approval action), ERA
# exception resolution (deterministic CAS recommender + resolve_exception
# action through the shared eraPosting engine), predictions from the
# org's OWN data (predict.js + outcome reconciliation in the daily brief),
# insights + claim-analysis endpoints, and agent surfaces in the tabs:
# Dashboard insights card, Worklist prediction chips, claim Agent
# analysis panel. Scope doc: claimpaid-agent-phase3-scope-2026-10-28.md.
# No new env; rides the agent setup from #83/#84 (vps-setup now preserves
# the agent vars across .env regeneration). Tests: agent-phase3 70/70,
# agent 51/51, phase2 45/45, era-api 41/41, coding-grounding 15/15,
# jsdom agent smoke PASS (incl. disabled-hidden surfaces), regressions
# at baselines (worklist-scope 10/10, settings 53/53, statements 41/41,
# connect 48/48).
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup85.sh
nohup bash vps-setup85.sh > /tmp/deploy85.log 2>&1 &
echo "deploy85 started, log: /tmp/deploy85.log"
