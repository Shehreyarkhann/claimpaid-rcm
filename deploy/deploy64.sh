#!/usr/bin/env bash
# Deploy #64: warm editorial retheme of BOTH apps (RCM dashboard + AI app + widgets)
# to match the #63 landings — cream/stone neutrals, Fraunces display type, emerald
# primary, amber AI accent, deep green-charcoal sidebars. Theme only, no behavior change.
# Also: official logo replaces legacy "P"/"A" letter tiles; RCM login panel's invented
# stats (98% / $2.4M / 4.9 stars) and "SOC 2 controls" line replaced with truthful facts.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup64.sh
nohup bash vps-setup64.sh > /tmp/deploy64.log 2>&1 &
echo "deploy64 started, log: /tmp/deploy64.log"
