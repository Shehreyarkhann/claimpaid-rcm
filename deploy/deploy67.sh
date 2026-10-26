#!/usr/bin/env bash
# Deploy #67: blog (index + 28 articles) and compare page redesigned in the warm
# editorial theme — cream paper, Fraunces headlines, Playfair wordmark, emerald
# accents, amber reserved for notes/disclaimers, deep-green CTA bands. Random
# placeholder photos hidden (typographic cards/headers); all copy, SEO meta and
# JSON-LD untouched.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup67.sh
nohup bash vps-setup67.sh > /tmp/deploy67.log 2>&1 &
echo "deploy67 started, log: /tmp/deploy67.log"
