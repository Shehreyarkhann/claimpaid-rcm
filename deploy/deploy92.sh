#!/usr/bin/env bash
# Deploy #92: Landing — footer dedupe, richer demo screenshots, agent shot in hero.
# Footer: the standalone stamp image next to the logo lockup is removed
# (one mark, not two); flex spacing tidied for desktop + mobile wrap.
# Screenshots: the demo dataset behind the product shots was enriched
# (19 claims, mixed-stage appeals, 3 ERA remittances with 2 exception
# lines on hold, statements, a seeded agent morning brief with 2 pending
# draft-appeal cards) and both shots were recaptured from the real app:
# product-worklist.webp (Dashboard) is replaced in place, and the new
# product-agent.webp (Agent page brief + approval cards) takes the
# hero's right column in a browser-chrome frame — the composed floating
# claim cards are gone. No landing copy changes outside the hero.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup92.sh
nohup bash vps-setup92.sh > /tmp/deploy92.log 2>&1 &
echo "deploy92 started, log: /tmp/deploy92.log"
