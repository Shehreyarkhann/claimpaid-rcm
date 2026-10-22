# ClaimPaid — Deployment Runbook

Prepared 2026-10-20. Read this before pushing to a host. Facts verified against
Render's current free-tier docs and two 2026 platform comparisons.

## The honest picture

**The README's 3-step Render deploy has a data-loss trap.** The app runs on
SQLite — a file on the server's disk. On Render's free tier the filesystem is
ephemeral: everything written locally is lost on every spin-down and redeploy.
Free web services spin down after 15 minutes with no traffic. So the README
path gives you a live link whose entire database (demo org, claims, users)
evaporates roughly every 15 idle minutes. Fine for a screenshot, useless as a
demo link on a resume or in a recruiter email.

**Free Postgres on Render self-destructs.** One free Postgres per workspace,
1 GB, no backups — and it expires 30 days after creation, with a 14-day grace
period before Render deletes it and all its data. It is a 44-day experiment,
not a home for your demo.

**Email breaks on Render free.** Free web services cannot send outbound mail on
ports 25, 465, or 587. The app's MFA codes and password-reset links go out over
SMTP (Resend, port 587) — they will silently fail from a free Render instance.
The free-friendly fix is Resend's HTTPS API (port 443), which is a small change
in the email module.

## Recommended path: cheap VPS (~$4.50/mo, zero code changes) ✅ CHOSEN

On a real VPS none of the Render-free problems exist: the disk is persistent
(SQLite works as-is) and outbound SMTP is open (MFA/reset emails work as-is).
**No code changes needed.** Cheapest real option, full control.

**You need (one-time, ~30 min):**
1. **VPS** — Hetzner CX22 (~$4.50/mo) or DigitalOcean $6 droplet. Ubuntu 24.04.
   Create it, note the IP.
2. **Domain** — ~$10/yr (Cloudflare / Porkbun / Namecheap), e.g. `claimpaid.io`.
3. **DNS** — A record `@` (or a subdomain) → your VPS IP. Verify:
   `dig +short yourdomain.com` must print the VPS IP.
4. **Repos on GitHub** — push this repo AND the ClaimPaid AI repo (`.env` is already gitignored in both).
5. **Resend API key** (optional but recommended) — for MFA/password-reset emails.
   Without it, codes print to the server log instead of sending.

**Then, SSH in as root and run one script:**

```bash
DOMAIN=yourdomain.com \
REPO_URL=https://github.com/<you>/pulse-rcm.git \
SMTP_PASS=re_your_resend_key \
SMTP_FROM=noreply@yourdomain.com \
bash <(curl -fsSL https://raw.githubusercontent.com/<you>/pulse-rcm/main/deploy/vps-setup.sh)
```

Or copy `deploy/vps-setup.sh` to the server and run it there with the env vars.
The script is idempotent — re-running it pulls, rebuilds, and restarts safely.

**What the script does:** hardens SSH + firewall (22/80/443) + fail2ban ·
installs Node 22, nginx, certbot · creates a dedicated `pulse` user · clones
the repo to `/opt/pulse-rcm` · builds the client + installs server deps ·
writes `server/.env` (random `JWT_SECRET`) · seeds the demo org on first run ·
installs a systemd service (auto-restart, starts on boot) · nginx reverse proxy
+ free Let's Encrypt SSL · daily SQLite backup with 7-day rotation.

**After:** live at `https://yourdomain.com/app` — demo login
`demo@pulsercm.com` / `demo1234`.

**Day-to-day:**
- Logs: `journalctl -u pulse-rcm -f`
- Restart: `systemctl restart pulse-rcm`
- Update the app: re-run the setup script (or `git pull` in `/opt/pulse-rcm`
  as the `pulse` user, rebuild client, `systemctl restart pulse-rcm`)
- Backups: `/var/backups/pulse-rcm/` (daily, 7-day rotation)

## Alternative: Render free + Neon (free, but needs code changes)

If you'd rather not manage a server:
1. **Code changes** (main agent does these on your word):
   - Swap the DB driver from SQLite to `pg`, reading `DATABASE_URL` from env.
     Keep SQLite as the local-dev default so nothing changes on your machine.
   - Switch the email module from SMTP to Resend's HTTPS API
     (`RESEND_API_KEY` env). This also removes the port-587 problem everywhere.
2. **Database** — Neon free project (serverless Postgres, persistent storage —
   no 30-day deletion; scales to zero, wakes on query; 1 GB storage, 100
   compute-hours per project: plenty for a demo link). Copy the connection string.
3. **GitHub** — push the repo (`.env` is already gitignored; secrets stay out).
4. **Render** — New Web Service → connect repo. Build: client build + server
   install. Start: server entry. Env vars: `DATABASE_URL`, `JWT_SECRET`,
   `RESEND_API_KEY`, `EMAIL_PROVIDER=resend`, `NODE_ENV=production`.
5. **Verify** — hit the public URL, sign up a test org, confirm data survives a
   redeploy (it will — it's in Neon now). First visit after idle takes ~1 min
   to wake; acceptable for a demo link.

## When free/cheap stops being enough

Real floor for always-on + persistent + backups is roughly $15–20/mo
(Render Starter web service ~$7 + a paid Postgres or Neon Launch, or a bigger
VPS). Upgrade only when a real prospect needs the demo reliably up — not before.

## Standing rules for any public demo

- Synthetic demo data only. Never put real patient names or PHI on the public
  instance (no BAA, no compliance claim — the honesty lock holds on the demo too).
- Keep the demo login (`demo@pulsercm.com` / `demo1234`) — it tells the story
  in 30 seconds.

## Sources (checked 2026-10-20)

- Render free-tier limits incl. 30-day Postgres expiry, 15-min spin-down,
  ephemeral filesystem, blocked SMTP ports:
  https://justinmckelvey.com/blog/is-render-free
- Render plan-change review (verbatim "Deploy for Free" doc quotes):
  https://jwatte.com/blog/render-com-platform-review/
- 4-platform price comparison, free-tier catches:
  https://dev.to/octave_nkurunziza_afb0512/heroku-vs-render-vs-railway-vs-hubfly-4-prices-for-one-app-postgres-7-20month-2hbn
- Neon free plan (100 compute-hours/project, scales to zero, 1 GB storage):
  https://theword360.com/2026/10/17/best-free-cloud-database-hosting-postgresql-mongodb-2026/
