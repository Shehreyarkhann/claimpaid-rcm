#!/usr/bin/env bash
# Deploy #81: Stripe Connect (Express) per-workspace statement payouts.
# Patient money now settles to the PRACTICE's own Stripe account — never
# the ClaimPaid platform account. Ships: orgs.stripe_account_id; Settings ->
# Payments connect/status/disconnect (owner-only, Stripe-hosted Express
# onboarding); statement pay links GATED (no connected account -> 409
# STRIPE_NOT_CONNECTED, zero Stripe calls, no platform fallback) and minted
# on the connected account (MoR opt-out + pinned API version from #80 ride
# along); Connect webhook POST /api/billing/webhook/connect settles paid
# statements via recordPayment (idempotent, account-matched; 503 until
# STRIPE_CONNECT_WEBHOOK_SECRET is set via deploy/set-connect-secret.sh).
# Suites: connect 38/38, statements 41/41, settings 53/53. No platform fee
# in v1 — the practice receives the full amount.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup81.sh
nohup bash vps-setup81.sh > /tmp/deploy81.log 2>&1 &
echo "deploy81 started, log: /tmp/deploy81.log"
