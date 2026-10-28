#!/usr/bin/env bash
# set-agent-key.sh — enable the ClaimPaid Agent (Phase 1) on this server.
# Prompts for the Anthropic API key only (paste it — nothing else to type).
# Stores it in the RCM server .env as ANTHROPIC_API_KEY, replacing any
# existing line, and in the same pass sets AGENT_ENABLED=1 and
# AGENT_MODEL=claude-haiku-5-5 (replace-or-append; every other .env value is
# preserved), then restarts the RCM service. Until this is run the agent
# stays disabled by design (every /api/agent route answers AGENT_DISABLED).
# The key is never echoed back — the confirmation prints its length only.
set -u
ENV_FILE=/opt/claimpaid-rcm/server/.env

echo "Paste the Anthropic API key (sk-ant-...), then press Enter:"
if [ -r /dev/tty ]; then IFS= read -rs KEY < /dev/tty; else IFS= read -rs KEY; fi
echo
KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
if [ -z "$KEY" ]; then echo "No key entered — nothing changed."; exit 1; fi

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
