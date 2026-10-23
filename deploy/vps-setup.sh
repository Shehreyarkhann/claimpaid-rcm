#!/usr/bin/env bash
# ClaimPaid — VPS setup script (Hetzner/DigitalOcean)
# Deploys: landing page + RCM app (/) and ClaimPaid AI (/ai/) on one domain.
# Run as root on a FRESH Ubuntu 24.04 VPS:
#   curl -fsSL https://raw.githubusercontent.com/<you>/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup.sh
#   chmod +x vps-setup.sh
#   DOMAIN=claimpaid.io \
#   REPO_URL=https://github.com/<you>/claimpaid-rcm.git \
#   AI_REPO_URL=https://github.com/<you>/claimpaid-ai.git \
#   SMTP_PASS='re_...' SMTP_FROM='noreply@claimpaid.io' \
#   ./vps-setup.sh
#
# Prerequisites (do these first, ~5 min):
#   1. VPS created (Hetzner CX22 ~$4.50/mo or DO $6 droplet), Ubuntu 24.04
#   2. Domain registered (claimpaid.io) with DNS A record @ -> VPS IP. Verify:
#        dig +short claimpaid.io   # must print your VPS IP
#   3. Resend API key (https://resend.com) for transactional email
#
# What this script does:
#   - hardens SSH + firewall (ufw: 22/80/443) + fail2ban
#   - installs Node.js 22, nginx, certbot
#   - creates a dedicated `claimpaid` user, clones both repos
#   - builds both clients, installs server deps, writes server/.env files
#   - seeds demo orgs (RCM + AI Payer Policy Handbook KB) on fresh DBs
#   - installs systemd services (auto-restart, start on boot)
#   - configures nginx reverse proxy (/ -> :4000, /ai/ -> :4001) + Let's Encrypt SSL
#   - daily SQLite backups (7-day rotation)
#
# Idempotent: safe to re-run (it will rebuild + restart everything).
set -euo pipefail

# ---------- config (override via env) ----------
DOMAIN="${DOMAIN:?Set DOMAIN, e.g. DOMAIN=claimpaid.io}"
REPO_URL="${REPO_URL:?Set REPO_URL, e.g. REPO_URL=https://github.com/you/claimpaid-rcm.git}"
AI_REPO_URL="${AI_REPO_URL:?Set AI_REPO_URL, e.g. AI_REPO_URL=https://github.com/you/claimpaid-ai.git}"
APP_DIR="${APP_DIR:-/opt/claimpaid-rcm}"
AI_DIR="${AI_DIR:-/opt/claimpaid-ai}"
APP_USER="${APP_USER:-claimpaid}"
SEED_DEMO="${SEED_DEMO:-true}"          # seed demo org + claims + AI KB
# ClaimPaid AI answers: local Ollama model (private — no external APIs, no data leaves the server).
# Override with LLM_PROVIDER=openai|groq|together + LLM_API_KEY for cloud models.
LLM_PROVIDER="${LLM_PROVIDER:-ollama}"
LLM_API_KEY="${LLM_API_KEY:-}"
LLM_MODEL="${LLM_MODEL:-qwen2.5:3b-instruct}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5:3b-instruct}"
BRAVE_API_KEY="${BRAVE_API_KEY:-}"      # optional web-fallback search
# Email (Resend SMTP). Leave SMTP_PASS empty to run without email
# (MFA codes then print to the server log instead of sending).
EMAIL_PROVIDER="${EMAIL_PROVIDER:-smtp}"
SMTP_HOST="${SMTP_HOST:-smtp.resend.com}"
SMTP_PORT="${SMTP_PORT:-587}"
SMTP_USER="${SMTP_USER:-resend}"
SMTP_PASS="${SMTP_PASS:-}"
SMTP_FROM="${SMTP_FROM:-noreply@claimpaid.io}"
# Stripe billing (leave empty to run without online checkout)
STRIPE_SECRET_KEY="${STRIPE_SECRET_KEY:-}"
STRIPE_PRICE_STARTER="${STRIPE_PRICE_STARTER:-}"
STRIPE_PRICE_PRO="${STRIPE_PRICE_PRO:-}"
STRIPE_WEBHOOK_SECRET="${STRIPE_WEBHOOK_SECRET:-}"
APP_URL="${APP_URL:-https://${DOMAIN}}"
# Google Sign-In (GIS ID-token flow). Leave empty to hide the Google button.
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}"

echo "==> ClaimPaid setup for ${DOMAIN}"

# ---------- preflight: DNS ----------
VPS_IP="$(curl -fsSL --max-time 10 https://api.ipify.org || true)"
DNS_IP="$(dig +short "${DOMAIN}" | tail -n1 || true)"
echo "    VPS IP: ${VPS_IP}   DNS ${DOMAIN} -> ${DNS_IP}"
if [[ "${VPS_IP}" != "${DNS_IP}" ]]; then
  echo "!! WARNING: ${DOMAIN} does not resolve to this VPS."
  echo "!! Fix the DNS A record first, then re-run. Continuing anyway in 10s..."
  sleep 10
fi

# ---------- base packages ----------
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ufw fail2ban sqlite3 dnsutils certbot python3-certbot-nginx > /dev/null

# ---------- Node.js 22 ----------
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  echo "==> Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null
  apt-get install -y -qq nodejs > /dev/null
fi
echo "    node $(node -v)"

# ---------- firewall + hardening ----------
echo "==> Firewall (22/80/443)"
ufw --force reset > /dev/null
ufw default deny incoming > /dev/null
ufw default allow outgoing > /dev/null
ufw allow 22/tcp > /dev/null
ufw allow 80/tcp > /dev/null
ufw allow 443/tcp > /dev/null
ufw --force enable > /dev/null
systemctl enable --now fail2ban > /dev/null 2>&1 || true

# ---------- app user ----------
if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "${APP_USER}"
fi

# ---------- fetch code ----------
echo "==> Fetching code into ${APP_DIR} and ${AI_DIR}"
if [[ -d "${APP_DIR}/.git" ]]; then
  git -C "${APP_DIR}" pull --ff-only
else
  rm -rf "${APP_DIR}"
  git clone --depth 1 "${REPO_URL}" "${APP_DIR}"
fi
if [[ -d "${AI_DIR}/.git" ]]; then
  git -C "${AI_DIR}" pull --ff-only
else
  rm -rf "${AI_DIR}"
  git clone --depth 1 "${AI_REPO_URL}" "${AI_DIR}"
fi
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}" "${AI_DIR}"

# ---------- build ----------
echo "==> Installing deps + building clients (RCM + AI)"
sudo -u "${APP_USER}" bash -lc "
  set -e
  cd '${APP_DIR}/client' && npm install --no-audit --no-fund
  rm -rf dist && npm run build
  cd '${APP_DIR}/server' && npm install --omit=dev --no-audit --no-fund
  cd '${AI_DIR}/client' && npm install --no-audit --no-fund
  rm -rf dist && VITE_BASE=/ai/app/ VITE_API_BASE=/ai npm run build
  cd '${AI_DIR}/server' && npm install --omit=dev --no-audit --no-fund
"

# ---------- render smoke test (fail-closed blank-screen guard) ----------
echo "==> Render smoke test (blank-screen guard)"
if [[ ! -d "$(npm root -g)/jsdom" ]]; then
  echo "    installing jsdom (one-time, for smoke test)..."
  npm install -g jsdom --no-audit --no-fund
fi
export NODE_PATH="$(npm root -g)${NODE_PATH:+:${NODE_PATH}}"
SMOKE="${APP_DIR}/deploy/render-smoke-test.cjs"
if [[ ! -f "${SMOKE}" ]]; then
  echo "!! smoke test script missing at ${SMOKE} — refusing to deploy blind"
  exit 1
fi
node "${SMOKE}" "${APP_DIR}/client/dist" "/app/" || {
  echo ""
  echo "!! RENDER SMOKE TEST FAILED — deploy aborted BEFORE restarting services."
  echo "   The previous working build is still serving. Fix the frontend and re-run."
  exit 1
}
node "${SMOKE}" "${AI_DIR}/client/dist" "/ai/app/" --ai || {
  echo ""
  echo "!! AI RENDER SMOKE TEST FAILED — deploy aborted BEFORE restarting services."
  echo "   The previous working build is still serving. Fix the frontend and re-run."
  exit 1
}

# ---------- .env (preserves existing secrets on re-run) ----------
echo "==> Writing server/.env"
if [[ ! -f "${APP_DIR}/server/.env" ]]; then
  JWT_SECRET="$(openssl rand -hex 32)"
else
  JWT_SECRET="$(grep -E '^JWT_SECRET=' "${APP_DIR}/server/.env" | cut -d= -f2 || true)"
  [[ -z "${JWT_SECRET}" ]] && JWT_SECRET="$(openssl rand -hex 32)"
fi
# On re-run, keep existing values unless a new one was passed
keep_or() { # $1 = env var name passed in, $2 = existing .env value
  if [[ -n "${!1:-}" ]]; then printf '%s' "${!1}"; else printf '%s' "$2"; fi
}
if [[ -f "${APP_DIR}/server/.env" ]]; then
  _EXISTING="$(cat "${APP_DIR}/server/.env")"
  _get() { grep -E "^$1=" <<<"$_EXISTING" | cut -d= -f2- || true; }
  EMAIL_PROVIDER="$(keep_or EMAIL_PROVIDER "$(_get EMAIL_PROVIDER)")"; [[ -z "$EMAIL_PROVIDER" ]] && EMAIL_PROVIDER="smtp"
  SMTP_HOST="$(keep_or SMTP_HOST "$(_get SMTP_HOST)")";       [[ -z "$SMTP_HOST" ]] && SMTP_HOST="smtp.resend.com"
  SMTP_PORT="$(keep_or SMTP_PORT "$(_get SMTP_PORT)")";       [[ -z "$SMTP_PORT" ]] && SMTP_PORT="587"
  SMTP_USER="$(keep_or SMTP_USER "$(_get SMTP_USER)")";       [[ -z "$SMTP_USER" ]] && SMTP_USER="resend"
  SMTP_PASS="$(keep_or SMTP_PASS "$(_get SMTP_PASS)")"
  SMTP_FROM="$(keep_or SMTP_FROM "$(_get SMTP_FROM)")"
  STRIPE_SECRET_KEY="$(keep_or STRIPE_SECRET_KEY "$(_get STRIPE_SECRET_KEY)")"
  STRIPE_PRICE_STARTER="$(keep_or STRIPE_PRICE_STARTER "$(_get STRIPE_PRICE_STARTER)")"
  STRIPE_PRICE_PRO="$(keep_or STRIPE_PRICE_PRO "$(_get STRIPE_PRICE_PRO)")"
  STRIPE_PRICE_AI="$(keep_or STRIPE_PRICE_AI "$(_get STRIPE_PRICE_AI)")"
  STRIPE_WEBHOOK_SECRET="$(keep_or STRIPE_WEBHOOK_SECRET "$(_get STRIPE_WEBHOOK_SECRET)")"
  APP_URL="$(keep_or APP_URL "$(_get APP_URL)")";             [[ -z "$APP_URL" ]] && APP_URL="https://${DOMAIN}"
  SUPERADMIN_EMAIL="$(keep_or SUPERADMIN_EMAIL "$(_get SUPERADMIN_EMAIL)")"
  GOOGLE_CLIENT_ID="$(keep_or GOOGLE_CLIENT_ID "$(_get GOOGLE_CLIENT_ID)")"
  AI_DB_PATH="$(keep_or AI_DB_PATH "$(_get AI_DB_PATH)")";           [[ -z "$AI_DB_PATH" ]] && AI_DB_PATH="/opt/claimpaid-ai/server/askbase.db"
fi
cat > "${APP_DIR}/server/.env" <<EOF
# generated by vps-setup.sh — do not commit
PORT=4000
NODE_ENV=production
JWT_SECRET=${JWT_SECRET}
EMAIL_PROVIDER=${EMAIL_PROVIDER}
SMTP_HOST=${SMTP_HOST}
SMTP_PORT=${SMTP_PORT}
SMTP_USER=${SMTP_USER}
SMTP_PASS=${SMTP_PASS}
SMTP_FROM=${SMTP_FROM}
# Stripe billing
STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY}
STRIPE_PRICE_STARTER=${STRIPE_PRICE_STARTER}
STRIPE_PRICE_PRO=${STRIPE_PRICE_PRO}
STRIPE_PRICE_AI=${STRIPE_PRICE_AI:-}
STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET}
APP_URL=${APP_URL}
SUPERADMIN_EMAIL=${SUPERADMIN_EMAIL:-}
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-}
AI_DB_PATH=${AI_DB_PATH}
EOF
chmod 600 "${APP_DIR}/server/.env"
chown "${APP_USER}:${APP_USER}" "${APP_DIR}/server/.env"

# ---------- AI .env (before seeding — the seed server reads it) ----------
echo "==> Writing AI server/.env"
if [[ ! -f "${AI_DIR}/server/.env" ]]; then
  AI_JWT_SECRET="$(openssl rand -hex 32)"
else
  AI_JWT_SECRET="$(grep -E '^JWT_SECRET=' "${AI_DIR}/server/.env" | cut -d= -f2 || true)"
  [[ -z "${AI_JWT_SECRET}" ]] && AI_JWT_SECRET="$(openssl rand -hex 32)"
  _AI_EXISTING="$(cat "${AI_DIR}/server/.env")"
  _aget() { grep -E "^$1=" <<<"$_AI_EXISTING" | cut -d= -f2- || true; }
  [[ -n "${LLM_API_KEY:-}" ]] || LLM_API_KEY="$(_aget LLM_API_KEY)"
  [[ -n "${LLM_MODEL:-}" ]] || LLM_MODEL="$(_aget LLM_MODEL)"
  [[ -n "${BRAVE_API_KEY:-}" ]] || BRAVE_API_KEY="$(_aget BRAVE_API_KEY)"
  [[ -n "${LLM_PROVIDER:-}" && "${LLM_PROVIDER}" != "demo" ]] || LLM_PROVIDER="$(_aget LLM_PROVIDER)"
  # Migrate legacy "demo" (extractive) installs to the private local model
  [[ "$LLM_PROVIDER" == "demo" || -z "$LLM_PROVIDER" ]] && LLM_PROVIDER="ollama"
  [[ -n "${LLM_MODEL:-}" ]] || LLM_MODEL="$(_aget LLM_MODEL)"
  [[ -n "${LLM_MODEL:-}" ]] || LLM_MODEL="qwen2.5:3b-instruct"
fi
cat > "${AI_DIR}/server/.env" <<EOF
# generated by vps-setup.sh — do not commit
PORT=4001
NODE_ENV=production
JWT_SECRET=${AI_JWT_SECRET}
SEED_DEMO=false
LLM_PROVIDER=${LLM_PROVIDER}
LLM_API_KEY=${LLM_API_KEY}
LLM_MODEL=${LLM_MODEL}
BRAVE_API_KEY=${BRAVE_API_KEY}
# Trust ClaimPaid RCM sessions (one login + one subscription for both apps)
RCM_JWT_SECRET=${JWT_SECRET}
RCM_DB_PATH=${APP_DIR}/server/rcm.db
EOF
chmod 600 "${AI_DIR}/server/.env"
chown "${APP_USER}:${APP_USER}" "${AI_DIR}/server/.env"

# ---------- seed demo data (fresh DB only) ----------
if [[ "${SEED_DEMO}" == "true" && ! -f "${APP_DIR}/server/rcm.db" ]]; then
  echo "==> Seeding RCM demo data"
  sudo -u "${APP_USER}" bash -lc "
    cd '${APP_DIR}/server' && npm run seed && node src/seed-authz.js
  "
fi
if [[ "${SEED_DEMO}" == "true" && ! -f "${AI_DIR}/server/askbase.db" ]]; then
  echo "==> Seeding AI demo data (Payer Policy Handbook KB)"
  echo "    (first boot downloads the embeddings model ~90MB — may take a few minutes)"
  sudo -u "${APP_USER}" bash -lc "
    set -e
    cd '${AI_DIR}/server'
    SEED_DEMO=true PORT=4001 node src/index.js > /tmp/claimpaid-ai-seed.log 2>&1 &
    SRV=\$!
    for i in \$(seq 1 60); do
      if curl -fsS --max-time 3 http://127.0.0.1:4001/api/health >/dev/null 2>&1; then break; fi
      sleep 10
    done
    curl -fsS --max-time 5 http://127.0.0.1:4001/api/health >/dev/null || { echo 'AI seed server did not start'; kill \$SRV 2>/dev/null || true; exit 1; }
    node seed-payer-kb.js
    kill \$SRV 2>/dev/null || true; wait 2>/dev/null || true
    echo '    AI demo seed complete'
  "
fi

# ---------- systemd services ----------
echo "==> Installing systemd services"
cat > /etc/systemd/system/claimpaid-rcm.service <<EOF
[Unit]
Description=ClaimPaid RCM (Node.js)
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}/server
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
# logs: journalctl -u claimpaid-rcm -f

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/claimpaid-ai.service <<EOF
[Unit]
Description=ClaimPaid AI (Node.js)
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${AI_DIR}/server
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
# first boot downloads the embeddings model (~90MB) — allow a minute
# logs: journalctl -u claimpaid-ai -f

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable claimpaid-rcm claimpaid-ai

# ---------- Ollama: private local LLM for ClaimPaid AI ----------
# The AI answers run on this server — no document or query ever leaves it.
if [[ "${LLM_PROVIDER}" == "ollama" ]]; then
  if ! command -v ollama > /dev/null 2>&1; then
    echo "==> Installing Ollama (private local LLM)"
    curl -fsSL https://ollama.com/install.sh | sh
  fi
  # Ensure the ollama service is running
  (systemctl enable --now ollama > /dev/null 2>&1 || service ollama start > /dev/null 2>&1 || true)
  # Wait for the API, then pull the model if missing (one-time ~2GB download)
  for i in $(seq 1 30); do
    curl -sf http://localhost:11434/api/tags > /dev/null 2>&1 && break
    sleep 2
  done
  if ! ollama list 2>/dev/null | grep -q "${OLLAMA_MODEL%%:*}"; then
    echo "==> Pulling Ollama model ${OLLAMA_MODEL} (one-time download)"
    ollama pull "${OLLAMA_MODEL}"
  fi
fi

# restart (not just start) so re-deploy pulls pick up the new code
systemctl restart claimpaid-rcm claimpaid-ai

# ---------- nginx ----------
echo "==> Configuring nginx"
cat > /etc/nginx/sites-available/claimpaid <<EOF
# ClaimPaid — RCM app serves / (landing) and /app ; AI dashboard at /ai/
server {
    listen 80;
    server_name ${DOMAIN} www.${DOMAIN};

    # certbot will add the 443 block on first run
    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
        # websocket support (future use)
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # ClaimPaid AI dashboard served under the same domain at /ai/
    # (AI service on :4001; trailing slash strips the /ai prefix)
    # Exact-match redirects: /ai/app without trailing slash would 301 to /app/
    # (domain root) and land on the RCM homepage instead of the AI app.
    location = /ai { return 301 /ai/; }
    location = /ai/app { return 301 /ai/app/; }
    location /ai/ {
        proxy_pass http://127.0.0.1:4001/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
        proxy_buffering off;  # required for SSE chat streaming
        proxy_cache off;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    client_max_body_size 25m;  # CSV/835 uploads
}
EOF
ln -sf /etc/nginx/sites-available/claimpaid /etc/nginx/sites-enabled/claimpaid
rm -f /etc/nginx/sites-enabled/default
rm -f /etc/nginx/sites-enabled/pulse-rcm  # legacy name
nginx -t
systemctl enable --now nginx
systemctl reload nginx

# ---------- SSL ----------
echo "==> Issuing Let's Encrypt certificate"
certbot --nginx -d "${DOMAIN}" -d "www.${DOMAIN}" --non-interactive --agree-tos \
  --register-unsafely-without-email --redirect || {
  echo "!! certbot failed — check DNS, then run:"
  echo "   certbot --nginx -d ${DOMAIN} -d www.${DOMAIN} --redirect"
}

# ---------- daily SQLite backups ----------
echo "==> Daily DB backups (7-day rotation)"
mkdir -p /var/backups/claimpaid
cat > /etc/cron.daily/claimpaid-backup <<EOF
#!/bin/sh
# online-safe SQLite backups, keeps 7 days
sqlite3 '${APP_DIR}/server/rcm.db' ".backup '/var/backups/claimpaid/rcm-\$(date +%F).db'" 2>/dev/null || \
  cp '${APP_DIR}/server/rcm.db' '/var/backups/claimpaid/rcm-\$(date +%F).db'
sqlite3 '${AI_DIR}/server/askbase.db' ".backup '/var/backups/claimpaid/ai-\$(date +%F).db'" 2>/dev/null || \
  cp '${AI_DIR}/server/askbase.db' '/var/backups/claimpaid/ai-\$(date +%F).db'
find /var/backups/claimpaid -name '*.db' -mtime +7 -delete
EOF
chmod +x /etc/cron.daily/claimpaid-backup
chown -R "${APP_USER}:${APP_USER}" /var/backups/claimpaid

# ---------- status ----------
sleep 3
echo ""
echo "================================================================"
RCM_OK=""; AI_OK=""
systemctl is-active --quiet claimpaid-rcm && RCM_OK="yes"
systemctl is-active --quiet claimpaid-ai && AI_OK="yes"
if [[ -n "${RCM_OK}" ]]; then
  echo "  ClaimPaid is LIVE:  https://${DOMAIN}/"
  echo "    App:  https://${DOMAIN}/app   (demo@pulsercm.com / demo1234)"
  echo "    AI:   https://${DOMAIN}/ai/app  (demo@askbase.com / demo1234)"
else
  echo "  !! RCM service failed — check: journalctl -u claimpaid-rcm -n 50"
fi
[[ -z "${AI_OK}" ]] && echo "  !! AI service failed — check: journalctl -u claimpaid-ai -n 50"
echo "  Logs:    journalctl -u claimpaid-rcm -f   |   journalctl -u claimpaid-ai -f"
echo "  Restart: systemctl restart claimpaid-rcm claimpaid-ai"
echo "  Update:  re-run this script (git pull + rebuild + restart)"
echo "  Backups: /var/backups/claimpaid (daily, 7-day rotation)"
echo "================================================================="
