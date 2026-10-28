#!/usr/bin/env bash
# Deploy #87: ClaimPaid Agent Phase 5 — document intake (EOB / denial
# letter upload; model extraction over Anthropic document/image blocks;
# deterministic validation + claim matching; apply_intake approval action
# creating HELD remittances or attaching denials; files stored in a
# NON-SERVED org-scoped directory — never the public /uploads), payer-call
# copilot (deterministic call brief; structured call logs writing claim
# activity + appeal follow-ups), manager's agent (owner-only team
# insights + strictly-better reassignment suggestions), import wizard
# (CSV mapping/validation/duplicates; commit via the real claim path;
# 837 stays the existing door), deadline-audit wizard (workspace or CSV
# — CSV commits nothing; branded print-ready report, the pilot wedge).
# Roadmap: claimpaid-roadmap-world1-2026-10-28.md. No new env.
# Tests: agent-phase5 107/107, jsdom smoke PASS (6 new Phase 5 segments),
# regressions at baselines (agent 51/51, phase2 45/45, phase3 70/70,
# phase4 33/33 + watchdog 15/15, era-api 41/41, coding-grounding 15/15,
# worklist-scope 10/10, settings 53/53, statements 41/41, connect 48/48).
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup87.sh
nohup bash vps-setup87.sh > /tmp/deploy87.log 2>&1 &
echo "deploy87 started, log: /tmp/deploy87.log"
