#!/usr/bin/env bash
# Deploy #72: search + AI-answer visibility pack.
# - sitemap.xml: lastmod added, app shells (/app, /ai/app) removed.
# - robots.txt: explicit welcome for AI crawlers (GPTBot, PerplexityBot,
#   ClaudeBot, Google-Extended, OAI-SearchBot...), apps/api disallowed.
# - llms.txt: FAQ section (pricing, timely-filing limits, BAA, local AI,
#   evidence-grounded coding) + company facts for AI extraction.
# - IndexNow key file hosted for instant Bing/Yandex indexing pings.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup72.sh
nohup bash vps-setup72.sh > /tmp/deploy72.log 2>&1 &
echo "deploy72 started, log: /tmp/deploy72.log"
