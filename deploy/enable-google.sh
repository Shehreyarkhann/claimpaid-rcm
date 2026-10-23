#!/bin/bash
# Enable Google sign-in: sets GOOGLE_CLIENT_ID in the droplet .env and restarts the RCM service.
# Run on the droplet console (as root). Safe to run before or after deploy #32
# (deploy preserves existing .env values):
#   curl -sSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/enable-google.sh | bash
set -u
ENV_FILE=/opt/claimpaid-rcm/server/.env
CLIENT_ID="602383511210-vbvon8jmutlor6a90ufo54br93g3la50.apps.googleusercontent.com"
if grep -q '^GOOGLE_CLIENT_ID=' "$ENV_FILE" 2>/dev/null; then
  sed -i "s|^GOOGLE_CLIENT_ID=.*|GOOGLE_CLIENT_ID=${CLIENT_ID}|" "$ENV_FILE"
  echo "updated GOOGLE_CLIENT_ID in $ENV_FILE"
else
  echo "GOOGLE_CLIENT_ID=${CLIENT_ID}" >> "$ENV_FILE"
  echo "added GOOGLE_CLIENT_ID to $ENV_FILE"
fi
systemctl restart claimpaid-rcm
sleep 4
echo "--- /api/config now serves: ---"
curl -s http://127.0.0.1:4000/api/config
echo ""
