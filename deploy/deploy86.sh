#!/usr/bin/env bash
# Deploy #86: ClaimPaid Agent Phase 4 — winning-argument learning (outcome
# stats gain the appeal-angle dimension; drafts pick the best-overturning
# angle at n>=5 and say so on the card; predict prefers angle rates),
# watchdog digest (hourly in-process sweep; org-local 6-10am window; one
# branded Resend email per user/day ONLY when they have actionable items;
# agent_digest_log dedupe; GET /api/agent/alerts mirrors the items),
# Denial Rescue wizard (POST /api/agent/tools/run for the three read
# tools via the chat executor; 5-step themed stepper; creates PENDING
# drafts only), and the motion pack (stamp-in on approvals at the brand
# -12 degrees, fade-slide, chip pulse, recovered-dollars count-up band on
# the insights card; all keyframes behind prefers-reduced-motion).
# Roadmap: claimpaid-roadmap-world1-2026-10-28.md. No new env (optional
# AGENT_WATCHDOG=off kill switch). NOTE: agent_outcome_stats is a derived
# cache — a pre-Phase-4 table is dropped/recreated on boot and repopulates
# at the next brief reconciliation. Tests: agent-phase4 33/33, agent
# 51/51, phase2 45/45, phase3 70/70, era-api 41/41, coding-grounding
# 15/15, jsdom smoke PASS (wizard walk-through, recovered band, alerts
# strip, motion CSS), regressions at baselines (worklist-scope 10/10,
# settings 53/53, statements 41/41, connect 48/48).
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup86.sh
nohup bash vps-setup86.sh > /tmp/deploy86.log 2>&1 &
echo "deploy86 started, log: /tmp/deploy86.log"
