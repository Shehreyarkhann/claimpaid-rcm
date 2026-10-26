#!/usr/bin/env bash
# Deploy #66: logo accuracy + floating-chat palette pass.
# - AI app was missing public/claimpaid-icon.webp entirely: every logo img in the
#   AI app (shell, auth, gate, widget) silently fell back to HTML. Asset added.
# - AI plan-gate screen: amber "A" tile -> official logo; indigo backdrop -> deep
#   green/warm-brown editorial gradient; copy color stone-300.
# - Public widget header: indigo gradient -> deep green; "A" tile -> official
#   logo; amber links -> stone; history accents amber -> emerald.
# - RCM FloatingChat: amber header -> deep green with official logo; robot emoji
#   FAB -> clean white chat glyph on the emerald button.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup66.sh
nohup bash vps-setup66.sh > /tmp/deploy66.log 2>&1 &
echo "deploy66 started, log: /tmp/deploy66.log"
