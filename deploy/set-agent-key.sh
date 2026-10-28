#!/usr/bin/env bash
# set-agent-key.sh — enable the ClaimPaid Agent (Phase 1) on this server.
# Prompts for the Anthropic API key by TYPING — the entry is VISIBLE (echo
# on) so typos can be seen and corrected; up to 5 attempts. The entered key
# is verified against the Anthropic API BEFORE anything is stored: only on
# an HTTP 200 is it written to the RCM server .env as ANTHROPIC_API_KEY
# (replacing any existing line), together with AGENT_ENABLED=1 and
# AGENT_MODEL=claude-haiku-5-5 (replace-or-append; every other .env value is
# preserved), and the RCM service restarted. A key that fails verification
# changes NOTHING — no .env write, no restart — and any previously stored
# key stays in place until a new one verifies. The script's own output
# never prints the key; the confirmation shows its length only. Until a
# verified key is set the agent stays disabled by design (every
# /api/agent route answers AGENT_DISABLED).
set -u
ENV_FILE="${ENV_FILE:-/opt/claimpaid-rcm/server/.env}"

KEY=""
attempt=1
while [ "$attempt" -le 5 ]; do
  echo "Type the Anthropic API key (sk-ant-...), then press Enter (attempt $attempt of 5):"
  if [ -r /dev/tty ]; then IFS= read -r KEY < /dev/tty; else IFS= read -r KEY; fi || { echo "No key entered — nothing changed."; exit 1; }
  KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
  if [ -z "$KEY" ]; then
    echo "Empty entry — nothing stored."
    attempt=$((attempt + 1))
    continue
  fi
  echo "Verifying the key against Anthropic..."
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" "https://api.anthropic.com/v1/models")"
  if [ "$CODE" = "200" ]; then
    echo "Anthropic answered 200 — key verified."
    break
  fi
  if [ "$CODE" = "000" ]; then
    echo "Could not reach Anthropic (network error) — key NOT stored, nothing changed."
  else
    echo "Anthropic answered HTTP $CODE — that key did not verify. Key NOT stored, nothing changed."
  fi
  KEY=""
  attempt=$((attempt + 1))
done
if [ -z "$KEY" ]; then
  echo "No verified key after 5 attempts — nothing changed."
  exit 1
fi

sed -i '/^ANTHROPIC_API_KEY=/d' "$ENV_FILE"
printf 'ANTHROPIC_API_KEY=%s\n' "$KEY" >> "$ENV_FILE"
sed -i '/^AGENT_ENABLED=/d' "$ENV_FILE"
printf 'AGENT_ENABLED=1\n' >> "$ENV_FILE"
sed -i '/^AGENT_MODEL=/d' "$ENV_FILE"
printf 'AGENT_MODEL=claude-haiku-5-5\n' >> "$ENV_FILE"
echo "Key stored (${#KEY} characters). Agent enabled with model claude-haiku-5-5."
systemctl restart claimpaid-rcm
sleep 3
if systemctl is-active --quiet claimpaid-rcm; then
  echo "DONE: claimpaid-rcm restarted with the agent enabled."
else
  echo "WARNING: claimpaid-rcm is not active after restart — check: systemctl status claimpaid-rcm"
  exit 1
fi
