#!/bin/bash
# Expand the Let's Encrypt cert to cover www.claimpaid.io (one-time, idempotent).
# Run on the droplet console (as root):
#   curl -sSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/www-cert.sh | bash
set -u
if ! getent hosts www.claimpaid.io | grep -q '147.182.218.81'; then
  echo "!! www.claimpaid.io does not resolve to 147.182.218.81 yet."
  echo "   Add the DNS A record in Cloudflare first:"
  echo "     Type A, Name www, IPv4 147.182.218.81, Proxy OFF (DNS-only)"
  echo "   Wait a minute for DNS to propagate, then re-run this script."
  exit 1
fi
certbot --nginx -d claimpaid.io -d www.claimpaid.io --expand \
  --non-interactive --agree-tos --register-unsafely-without-email --redirect
# nginx needs www in server_name or certbot cannot install the cert for it
NGINX_SITE=/etc/nginx/sites-available/claimpaid
if ! grep -q 'www\.claimpaid\.io' "$NGINX_SITE"; then
  sed -i 's/server_name claimpaid\.io;/server_name claimpaid.io www.claimpaid.io;/' "$NGINX_SITE"
  echo "added www.claimpaid.io to nginx server_name"
fi
certbot install --cert-name claimpaid.io --non-interactive || true
nginx -t && systemctl reload nginx
echo ""
echo "--- certificate domains now: ---"
certbot certificates 2>/dev/null | grep -i "domains:"
echo "--- www check: ---"
curl -s -o /dev/null -w 'https://www.claimpaid.io -> %{http_code}\n' https://www.claimpaid.io
