#!/bin/bash
# env-doctor.sh — diagnose + repair the production .env after a deploy.
# - Prints masked status of every billing/email setting.
# - Auto-fixes all NON-secret settings to their known-good values
#   (SMTP port 2587 — DigitalOcean blocks 587/465 — price IDs, provider...).
# - Never invents secrets: if a key line is missing it reports MISSING
#   (restore those by re-running deploy/live-flip.sh).
# - Validates the Stripe key against the live Stripe API (balance read).
# - Sends a real SMTP test email with the .env credentials.
# - Restarts claimpaid-rcm if anything changed.
set -u
ENV_FILE=/opt/claimpaid-rcm/server/.env
cd "$(dirname "$ENV_FILE")" 2>/dev/null || true

get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-; }

echo "=== CURRENT STATE (masked) ==="
grep -E '^(EMAIL_PROVIDER|SMTP_HOST|SMTP_PORT|SMTP_SECURE|SMTP_USER|SMTP_PASS|SMTP_FROM|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|STRIPE_PRICE_)' "$ENV_FILE" 2>/dev/null \
  | sed -E 's/(sk_live_|rk_live_|whsec_|re_)([A-Za-z0-9]{4})[A-Za-z0-9]*/\1\2.../'
echo

CHANGED=$(python3 - "$ENV_FILE" <<'PYEOF'
import sys
path = sys.argv[1]
fixes = {
    "EMAIL_PROVIDER": "smtp",
    "SMTP_HOST": "smtp.resend.com",
    "SMTP_PORT": "2587",
    "SMTP_SECURE": "false",
    "SMTP_USER": "resend",
    "SMTP_FROM": "ClaimPaid <no-reply@claimpaid.io>",
    "STRIPE_PRICE_STARTER": "price_1UUoU2RWpGe7EPH4NmR0Lyua",
    "STRIPE_PRICE_PRO": "price_1UUoU2RWpGe7EPH4v9b3muG7",
    "STRIPE_PRICE_AI": "price_1UUoU2RWpGe7EPH4pR0syF9z",
}
with open(path) as f:
    lines = f.read().splitlines()
seen = set(); out = []; changed = []
for line in lines:
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k = s.split("=", 1)[0].strip()
        if k in fixes:
            seen.add(k)
            if s.split("=", 1)[1].strip() != fixes[k]:
                changed.append(k)
                out.append(f"{k}={fixes[k]}")
                continue
    out.append(line)
for k, v in fixes.items():
    if k not in seen:
        changed.append(k + " (added)")
        out.append(f"{k}={v}")
if changed:
    with open(path, "w") as f:
        f.write("\n".join(out) + "\n")
print(",".join(changed) if changed else "none")
PYEOF
)
echo "Non-secret settings fixed: $CHANGED"
echo

echo "=== SECRETS PRESENT? ==="
for k in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET SMTP_PASS; do
  v=$(get "$k")
  if [ -n "$v" ]; then echo "$k: PRESENT"; else echo "$k: *** MISSING ***"; fi
done
echo

SK=$(get STRIPE_SECRET_KEY)
if [ -n "$SK" ]; then
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 -u "$SK:" https://api.stripe.com/v1/balance)
  echo "Stripe API check with server key: HTTP $code (200 = live key valid)"
fi
echo

if [ "$CHANGED" != "none" ]; then
  echo "Restarting claimpaid-rcm to pick up fixes..."
  if [ "$(id -u)" = "0" ]; then systemctl restart claimpaid-rcm; else sudo systemctl restart claimpaid-rcm; fi
  sleep 3
  systemctl is-active claimpaid-rcm || true
  echo
fi

echo "=== SMTP SEND TEST (real email to the owner) ==="
python3 - "$ENV_FILE" <<'PYEOF'
import smtplib, ssl, sys
from email.message import EmailMessage
env = {}
for line in open(sys.argv[1]):
    line = line.strip()
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()
host = env.get("SMTP_HOST", "")
port = int(env.get("SMTP_PORT", "587") or 587)
user = env.get("SMTP_USER", "")
pw = env.get("SMTP_PASS", "")
sender = env.get("SMTP_FROM", "ClaimPaid <no-reply@claimpaid.io>")
if not pw:
    print("SMTP TEST SKIPPED: SMTP_PASS missing")
    sys.exit(0)
msg = EmailMessage()
msg["From"] = sender
msg["To"] = "shehreyarkhann@outlook.com"
msg["Subject"] = "ClaimPaid mail system check"
msg.set_content("This is an automated diagnostic from your ClaimPaid server.\nIf you can read this, production email is working end to end.\n")
try:
    if env.get("SMTP_SECURE") == "true" or port == 465:
        s = smtplib.SMTP_SSL(host, port, timeout=15, context=ssl.create_default_context())
    else:
        s = smtplib.SMTP(host, port, timeout=15)
        s.starttls(context=ssl.create_default_context())
    s.login(user, pw)
    s.send_message(msg)
    s.quit()
    print("SMTP TEST: SENT OK — check the Resend Emails log + your inbox")
except Exception as e:
    print("SMTP TEST: FAILED — %s" % e)
PYEOF
echo
echo "DONE. Tell Bot: doctor done (and screenshot this output)"
