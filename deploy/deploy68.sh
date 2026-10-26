#!/usr/bin/env bash
# Deploy #68: (1) Get started button text forced white on blog/compare (nav-link
# color was beating the button rule — same bug fixed on the main landing in #63).
# (2) Logo click goes home everywhere: main landing #hero -> /; RCM app sidebar +
# mobile bar logos -> My Work; AI app brand -> Knowledge Bases (and its logo
# loses the amber halo tile left behind it).
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup68.sh
nohup bash vps-setup68.sh > /tmp/deploy68.log 2>&1 &
echo "deploy68 started, log: /tmp/deploy68.log"
