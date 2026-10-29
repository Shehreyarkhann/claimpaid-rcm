#!/bin/bash
# deploy102.sh — Deploy #102: cookie consent on the landing surfaces.
# Banner + preferences modal + /cookies/ policy page; the Cloudflare
# Web Analytics beacon is consent-gated on landing pages (app shells
# untouched). Founder runs this in the droplet console:
#   curl -sL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/deploy102.sh | bash
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup102.sh
nohup bash vps-setup102.sh > /tmp/deploy102.log 2>&1 &
echo "Deploy #102 started detached — log: /tmp/deploy102.log (pid $!)"
