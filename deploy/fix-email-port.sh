#!/usr/bin/env bash
# ClaimPaid email port fix: tests which Resend SMTP ports actually answer
# from this droplet, switches SMTP_PORT in the prod .env to the first
# working one, and restarts the app. If 587 already works, changes nothing.
set -u
HOST=smtp.resend.com
ENV_FILE=/opt/claimpaid-rcm/server/.env

banner_ok() {
  timeout 8 bash -c "exec 3<>/dev/tcp/$HOST/$1; head -c 80 <&3" 2>/dev/null | grep -q "220"
}

echo "Testing SMTP ports at $HOST ..."
declare -A STATUS
for p in 587 2587 2465 465; do
  if banner_ok "$p"; then
    echo "$p OK (SMTP answered)"
    STATUS[$p]=ok
  else
    echo "$p DEAD (no answer)"
    STATUS[$p]=dead
  fi
done

if [ "${STATUS[587]:-dead}" = "ok" ]; then
  echo "Port 587 works — the problem is NOT the port. Nothing changed."
  echo "Tell Bot: 587 OK but mail still hangs"
  exit 0
fi

# Pick the first working alternate. 2587 = STARTTLS, 2465 = implicit TLS, 465 = implicit TLS (auto).
NEWPORT=""
SECURE=""
for p in 2587 2465 465; do
  if [ "${STATUS[$p]:-dead}" = "ok" ]; then NEWPORT=$p; break; fi
done
case "$NEWPORT" in
  2587) SECURE="false" ;;
  2465) SECURE="true" ;;
  465)  SECURE="true" ;;
  *) echo "No working SMTP port found. Nothing changed. Tell Bot: all ports dead"; exit 1 ;;
esac

cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%s)"
NEWPORT="$NEWPORT" SECURE="$SECURE" python3 - "$ENV_FILE" <<'PYEOF'
import os, sys
path = sys.argv[1]
updates = {"SMTP_PORT": os.environ["NEWPORT"], "SMTP_SECURE": os.environ["SECURE"]}
with open(path) as f:
    lines = f.read().splitlines()
seen = set()
out = []
for line in lines:
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k = s.split("=", 1)[0].strip()
        if k in updates:
            out.append(f"{k}={updates[k]}")
            seen.add(k)
            continue
    out.append(line)
for k, v in updates.items():
    if k not in seen:
        out.append(f"{k}={v}")
with open(path, "w") as f:
    f.write("\n".join(out) + "\n")
print("SMTP_PORT=%s SMTP_SECURE=%s written." % (updates["SMTP_PORT"], updates["SMTP_SECURE"]))
PYEOF

echo "Restarting claimpaid-rcm..."
if [ "$(id -u)" = "0" ]; then
  systemctl restart claimpaid-rcm
else
  sudo systemctl restart claimpaid-rcm
fi
sleep 3
systemctl is-active claimpaid-rcm || true
echo "DONE. Tell Bot: port fixed"
