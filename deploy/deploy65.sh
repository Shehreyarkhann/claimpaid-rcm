#!/usr/bin/env bash
# Deploy #65: HOTFIX — mobile sidebar drawer would not close. The #64 theme pass
# (slate->stone class rename) corrupted Tailwind's translate-x classes into
# "transtone-x", so the drawer had no off-canvas transform at all: the X button
# and backdrop toggled state but nothing moved. Restores translate-x in Shell.jsx
# (drawer + bottom-nav badge) and OnboardingWizard.jsx (MOST POPULAR pill).
# Verified at 390px viewport: hidden by default, Menu opens, X closes, outside tap closes.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup65.sh
nohup bash vps-setup65.sh > /tmp/deploy65.log 2>&1 &
echo "deploy65 started, log: /tmp/deploy65.log"
