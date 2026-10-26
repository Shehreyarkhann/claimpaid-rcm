#!/usr/bin/env bash
# ClaimPaid email port fix v2: probes each Resend SMTP port for a real 220
# banner (TLS-aware), switches SMTP_PORT in the prod .env to the first
# working one, and restarts the app. If 587 already works, changes nothing.
set -u
ENV_FILE=/opt/claimpaid-rcm/server/.env

probe() {
  # $1 = port, $2 = tls (1 = implicit TLS). Prints banner; exit 0 iff 220.
  python3 - "$1" "$2" <<'PYEOF'
import socket, ssl, sys
port = int(sys.argv[1]); tls = sys.argv[2] == "1"
host = "smtp.resend.com"
try:
    raw = socket.create_connection((host, port), timeout=6)
    if tls:
        ctx = ssl.create_default_context()
        s = ctx.wrap_socket(raw, server_hostname=host)
    else:
        s = raw
    s.settimeout(6)
    data = s.recv(160).decode("utf-8", "replace").strip()
    print(data if data else "<empty>")
    sys.exit(0 if data.startswith("220") else 1)
except Exception as e:
    print("ERR %s" % e)
    sys.exit(1)
PYEOF
}

echo "Probing SMTP ports at smtp.resend.com ..."
declare -A OK
for spec in "587 0" "2587 0" "2465 1" "465 1"; do
  set -- $spec
  echo "-- port $1:"
  if out=$(probe "$1" "$2"); then
    echo "   OK: $out"
    OK[$1]=1
  else
    echo "   DEAD: $out"
    OK[$1]=0
  fi
done

if [ "${OK[587]:-0}" = "1" ]; then
  echo "Port 587 answers fine — the problem is NOT the port. Nothing changed."
  echo "Tell Bot: 587 banner OK but mail still hangs"
  exit 0
fi

NEWPORT=""; SECURE=""
for p in 2587 2465 465; do
  if [ "${OK[$p]:-0}" = "1" ]; then NEWPORT=$p; break; fi
done
case "$NEWPORT" in
  2587) SECURE="false" ;;
  2465|465) SECURE="true" ;;
  *) echo "No working SMTP port found. Nothing changed. Tell Bot: all ports dead v2"; exit 1 ;;
esac

cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%s)"
NEWPORT="$NEWPORT" SECURE="$SECURE" python3 - "$ENV_FILE" <<'PYEOF'
import os, sys
path = sys.argv[1]
updates = {"SMTP_PORT": os.environ["NEWPORT"], "SMTP_SECURE": os.environ["SECURE"]}
with open(path) as f:
    lines = f.read().splitlines()
seen = set(); out = []
for line in lines:
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k = s.split("=", 1)[0].strip()
        if k in updates:
            out.append(f"{k}={updates[k]}"); seen.add(k); continue
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
