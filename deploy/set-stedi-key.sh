#!/usr/bin/env bash
# set-stedi-key.sh — set or rotate the Stedi platform API key on this server.
# Prompts for the key only (paste it — nothing else to type). Stores it in the
# RCM server .env, replacing any existing STEDI_API_KEY line, verifies it
# against the Stedi Payers API, and restarts the RCM service ONLY if the key
# verifies. A key that fails verification is removed again and nothing is
# restarted. The key is never echoed back.
set -u
ENV_FILE=/opt/claimpaid-rcm/server/.env

echo "Paste the Stedi API key, then press Enter:"
if [ -r /dev/tty ]; then IFS= read -r KEY < /dev/tty; else IFS= read -r KEY; fi
KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
if [ -z "$KEY" ]; then echo "No key entered — nothing changed."; exit 1; fi

sed -i '/^STEDI_API_KEY=/d' "$ENV_FILE"
printf 'STEDI_API_KEY=%s\n' "$KEY" >> "$ENV_FILE"
echo "Key stored. Verifying against Stedi..."

CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -H "Authorization: $KEY" "https://healthcare.us.stedi.com/2024-04-01/payers/search?name=Cigna")"
if [ "$CODE" != "200" ]; then
  sed -i '/^STEDI_API_KEY=/d' "$ENV_FILE"
  echo "Stedi answered HTTP $CODE — the key did not verify, so it was removed and the service was NOT restarted."
  echo "Run this script again and paste the key exactly (use the copy button in Stedi -> API Keys)."
  exit 1
fi
echo "Stedi answered 200 — key verified."
systemctl restart claimpaid-rcm
sleep 3
if systemctl is-active --quiet claimpaid-rcm; then
  echo "DONE: claimpaid-rcm restarted with the verified Stedi key."
else
  echo "WARNING: claimpaid-rcm is not active after restart — check: systemctl status claimpaid-rcm"
  exit 1
fi
