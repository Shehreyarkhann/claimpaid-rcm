#!/usr/bin/env bash
# Deploy #78: statement pay link, round 2 — Managed Payments opt-out.
# Deploy #77 fixed the rejected `after_payment` parameter; the live retest
# then surfaced the next gate: this Stripe account has Managed Payments
# (Stripe as merchant of record) on by default, and it rejects payment
# links whose product lacks an eligible tax code. Managed Payments covers
# digital goods only — patient statements (healthcare receivables) can
# never be eligible, so statements-core now creates statement links with
# managed_payments.enabled=false. Suite asserts the opt-out (37/37).
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup78.sh
nohup bash vps-setup78.sh > /tmp/deploy78.log 2>&1 &
echo "deploy78 started, log: /tmp/deploy78.log"
