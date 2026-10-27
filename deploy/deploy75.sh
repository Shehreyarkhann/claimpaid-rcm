#!/usr/bin/env bash
# Deploy #75: founder-reported defect fixes + app-wide modal standardization.
# - Patient Statements rebuilt on the shared theme (btn base classes, tbl
#   tables, standard modal chrome; the page predated the #64 retheme and its
#   buttons/tables resolved to no styles). Pay link is now openable/copyable
#   from the list and detail views; the payment-link route's Stripe client
#   honors STRIPE_API_BASE like billing's (route now covered end-to-end).
# - My Work "Open claim" deep link: Claims finally consumes initialClaimId
#   (fetches the claim and opens the same Edit modal as the list).
# - Worklist scope=mine now filters every section (assignment lives on open
#   appeals; unworked denials are team-queue only). Team items name their
#   assignee.
# - Modal standardization: Transmission New Batch rebuilt on the standard
#   pattern; Billing cancel/switch and EHR athena-setup modals moved onto
#   the shared Modal; LimitModal's dead btn-secondary replaced; .btn-sm
#   defined in the theme (20+ call sites used it undefined); ALL
#   window.confirm dialogs replaced by the themed confirmDialog host.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup75.sh
nohup bash vps-setup75.sh > /tmp/deploy75.log 2>&1 &
echo "deploy75 started, log: /tmp/deploy75.log"
