#!/usr/bin/env bash
# ClaimPaid LIVE flip: sets Stripe live keys + Resend SMTP in the production
# .env and restarts the RCM app. Secrets are prompted interactively and never
# stored in this script. Safe to re-run.
set -u
ENV_FILE=/opt/claimpaid-rcm/server/.env

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found. Are you in the droplet console?"
  exit 1
fi

cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%s)"
echo "Backup of current .env saved."

printf "Paste Stripe LIVE secret key (sk_live_... or rk_live_...): "
read -r SK
case "$SK" in
  sk_live_*|rk_live_*) ;;
  *) echo "ERROR: that does not start with sk_live_ or rk_live_ — aborting, nothing changed."; exit 1 ;;
esac

printf "Paste webhook signing secret (whsec_...): "
read -r WH
case "$WH" in
  whsec_*) ;;
  *) echo "ERROR: that does not start with whsec_ — aborting, nothing changed."; exit 1 ;;
esac

printf "Paste Resend API key (re_...): "
read -r REK
case "$REK" in
  re_*) ;;
  *) echo "ERROR: that does not start with re_ — aborting, nothing changed."; exit 1 ;;
esac

SK="$SK" WH="$WH" REK="$REK" python3 - "$ENV_FILE" <<'PYEOF'
import os, sys

path = sys.argv[1]
updates = {
    "STRIPE_SECRET_KEY": os.environ["SK"],
    "STRIPE_WEBHOOK_SECRET": os.environ["WH"],
    "STRIPE_PRICE_STARTER": "price_1UUoU2RWpGe7EPH4NmR0Lyua",
    "STRIPE_PRICE_PRO": "price_1UUoU2RWpGe7EPH4v9b3muG7",
    "STRIPE_PRICE_AI": "price_1UUoU2RWpGe7EPH4pR0syF9z",
    "EMAIL_PROVIDER": "smtp",
    "SMTP_HOST": "smtp.resend.com",
    "SMTP_PORT": "587",
    "SMTP_USER": "resend",
    "SMTP_PASS": os.environ["REK"],
    "SMTP_FROM": "ClaimPaid <no-reply@claimpaid.io>",
}

with open(path) as f:
    lines = f.read().splitlines()

seen = set()
out = []
for line in lines:
    stripped = line.strip()
    if "=" in stripped and not stripped.startswith("#"):
        key = stripped.split("=", 1)[0].strip()
        if key in updates:
            out.append(f"{key}={updates[key]}")
            seen.add(key)
            continue
    out.append(line)

for key, val in updates.items():
    if key not in seen:
        out.append(f"{key}={val}")

with open(path, "w") as f:
    f.write("\n".join(out) + "\n")
os.chmod(path, 0o600)
print(".env updated: %d settings written." % len(updates))
PYEOF

echo "Restarting claimpaid-rcm..."
if [ "$(id -u)" = "0" ]; then
  systemctl restart claimpaid-rcm
else
  sudo systemctl restart claimpaid-rcm
fi
sleep 3
systemctl is-active claimpaid-rcm || true
echo
echo "Verification (masked):"
grep -E '^(STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|STRIPE_PRICE_|EMAIL_PROVIDER|SMTP_HOST|SMTP_USER|SMTP_PASS|SMTP_FROM)' "$ENV_FILE" | sed -E 's/(sk_live_|rk_live_|whsec_|re_)([A-Za-z0-9]{6}).*/\1\2.../'
echo
echo "DONE. Tell Bot: restart done"
