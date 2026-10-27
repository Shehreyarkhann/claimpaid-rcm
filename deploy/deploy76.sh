#!/usr/bin/env bash
# Deploy #76: rebrand mark swap — founder's new stamp logo replaces the old
# green-square icon everywhere in the product (palette/theme unchanged).
# - New art: dark stamp + lime check (light surfaces), inverted lime stamp
#   (dark surfaces), simplified favicon stamp, dark app-icon tile, full
#   lockups. Rasters generated pixel-exact from the founder's SVGs.
# - claimpaid-icon.png/.webp regenerated in place (light art) so every stable
#   URL (landing header/footer, og:image, schema logo, AI landing) serves the
#   new mark with zero reference changes.
# - All dark in-app placements (RCM + AI sidebars, auth panels, onboarding,
#   loading splash, chat header) now point at claimpaid-icon-reverse.webp.
# - Favicons standardized: SVG favicon + 32/16 PNG fallbacks + apple-touch
#   (app-icon art) on the landing (all pages), both app shells; favicon.ico
#   at the domain root.
# - Branded email header: icon + text replaced by the hosted full reverse
#   lockup (claimpaid-logo-reverse.png on the landing root).
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup76.sh
nohup bash vps-setup76.sh > /tmp/deploy76.log 2>&1 &
echo "deploy76 started, log: /tmp/deploy76.log"
