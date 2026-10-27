#!/usr/bin/env bash
# set-connect-secret.sh — set the Stripe Connect webhook signing secret.
# Prompts for the secret only (paste the whsec_... from the Connect webhook
# endpoint in the Stripe Dashboard — nothing else to type). Stores it in the
# RCM server .env as STRIPE_CONNECT_WEBHOOK_SECRET, replacing any existing
# line, sanity-checks the shape, and restarts the RCM service. The secret is
# never echoed back. Until this is set, the connect webhook endpoint answers
# 503 by design and statement payments settle manually.
set -u
ENV_FILE=/opt/claimpaid-rcm/server/.env

echo "Paste the Connect webhook signing secret (whsec_...), then press Enter:"
if [ -r /dev/tty ]; then IFS= read -r SECRET < /dev/tty; else IFS= read -r SECRET; fi
SECRET="$(printf '%s' "$SECRET" | tr -d '[:space:]')"
if [ -z "$SECRET" ]; then echo "No secret entered — nothing changed."; exit 1; fi
case "$SECRET" in
  whsec_*) ;;
  *) echo "That does not look like a webhook signing secret (it should start with whsec_) — nothing changed."; exit 1 ;;
esac

sed -i '/^STRIPE_CONNECT_WEBHOOK_SECRET=/d' "$ENV_FILE"
printf 'STRIPE_CONNECT_WEBHOOK_SECRET=%s\n' "$SECRET" >> "$ENV_FILE"
echo "Secret stored."
systemctl restart claimpaid-rcm
sleep 3
if systemctl is-active --quiet claimpaid-rcm; then
  echo "DONE: claimpaid-rcm restarted with the Connect webhook secret."
else
  echo "WARNING: claimpaid-rcm is not active after restart — check: systemctl status claimpaid-rcm"
  exit 1
fi
