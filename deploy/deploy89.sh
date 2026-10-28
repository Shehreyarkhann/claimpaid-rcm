#!/usr/bin/env bash
# Deploy #89: Plan-entitlement truth. Founder decision 2026-10-28:
# Starter includes the agent with 100 AI uses/month (was: an uncapped
# agent running over a declared 0 allowance — planLimits said "no AI
# product" while usage.js counted Starter turns and never blocked),
# then the existing 402 upgrade gate fires. Pro stays 2,000, AI plan
# 1,000, Enterprise unlimited. Server: planLimits starter aiQueries
# 0 -> 100; the brief's narrative call and POST /agent/tools/run now
# respect the same quota gate (chat + document extraction already did;
# the watchdog digest makes no model calls — verified). Billing API
# gains an entitlements payload built ONLY from planLimits +
# productsForPlan (status + usage). Dashboard: Billing page gains a
# "What your plan includes" panel rendered from that payload (live
# used/limit + not-included rows wired to the plan picker) and the
# plan cards are corrected to the same truth. Agent page: a 402
# ai_query_limit_reached renders a persistent upgrade notice with a
# Billing link instead of a raw error toast; "+ New chat" now scrolls
# the thread into view and focuses the composer (the state reset was
# always correct but invisible on mobile — brief + intake sit between
# the header button and the thread). Landing: plan cards carry precise
# included / not-included lines, a verifiable comparison table sits
# under them, the billing-companies section gains a "Book a demo"
# mailto (support@, prefilled) beside the free-audit CTA, and the
# final CTA band gains a secondary demo link. AskBase untouched: its
# product gate (ai:false) already excludes Starter, and its limits
# flow from this repo's planLimits.js by path.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup89.sh
nohup bash vps-setup89.sh > /tmp/deploy89.log 2>&1 &
echo "deploy89 started, log: /tmp/deploy89.log"
