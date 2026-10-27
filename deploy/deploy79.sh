#!/usr/bin/env bash
# Deploy #79: org MFA toggle state + transparent email logo. Supersedes the
# un-run #78 (statement pay-link Managed Payments opt-out ships inside,
# deploys are cumulative from main).
#  1) SecurityTab read its toggle state from GET /api/org, whose column
#     list omits orgs.mfa_required — the switch always rendered OFF and
#     snapped back after a save even though enforcement was live. It now
#     reads GET /api/settings/security (its purpose-built endpoint).
#     Round-trip pinned in the settings suite (53/53).
#  2) claimpaid-logo-reverse.png re-rendered with a transparent background
#     (the founder SVG's baked #0D1A14 rect read as a contrast plate on the
#     #0B1220 email header). Same filename/URL; mailer unchanged.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup79.sh
nohup bash vps-setup79.sh > /tmp/deploy79.log 2>&1 &
echo "deploy79 started, log: /tmp/deploy79.log"
