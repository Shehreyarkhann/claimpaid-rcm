# Deploy

## Option 1 — VPS (recommended, ~$4.50/mo, zero code changes)

1. Create a VPS (Hetzner CX22 or DO droplet), Ubuntu 24.04. Note the IP.
2. Buy a domain (~$10/yr) and point an A record at the VPS IP.
3. Push this repo to GitHub.
4. SSH in as root and run:

```bash
DOMAIN=yourdomain.com \
REPO_URL=https://github.com/<you>/pulse-rcm.git \
SMTP_PASS=re_your_resend_key \
SMTP_FROM=noreply@yourdomain.com \
bash <(curl -fsSL https://raw.githubusercontent.com/<you>/pulse-rcm/main/deploy/vps-setup.sh)
```

Live at `https://yourdomain.com/app`. See `vps-setup.sh` header for everything
it does (hardening, Node 22, nginx, Let's Encrypt, systemd, daily DB backups).

Full details: [`DEPLOY-RUNBOOK.md`](../DEPLOY-RUNBOOK.md).
