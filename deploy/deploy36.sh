#!/bin/bash
# Deploy #36 bootstrap — idempotent, safe to run multiple times.
# Type this on the droplet console:
#   curl -sSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/deploy36.sh | bash
curl -sSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o /tmp/vps-setup.sh
chmod +x /tmp/vps-setup.sh
DOMAIN=claimpaid.io \
REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git \
AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git \
SUPERADMIN_EMAIL=shehreyarkhann@outlook.com \
setsid /tmp/vps-setup.sh > /tmp/deploy36.log 2>&1 < /dev/null &
echo "Deploy #36 started in background."
echo "Watch progress with: tail -n 40 /tmp/deploy36.log"
