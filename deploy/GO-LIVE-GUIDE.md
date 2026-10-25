# ClaimPaid — Go-Live Guide (start to finish)

Everything you need to take ClaimPaid from this machine to `https://claimpaid.io`,
in order. Nothing is skipped, nothing is assumed.

---

## 0. What you're deploying

```
https://claimpaid.io/            → landing page (marketing site)
https://claimpaid.io/app/        → ClaimPaid RCM app (React + Node + SQLite, :4000)
https://claimpaid.io/ai/app/     → ClaimPaid AI dashboard (React + Node + SQLite, :4001)
https://claimpaid.io/api/...     → RCM backend API (auth, claims, appeals, billing…)
```

One VPS runs everything. nginx routes traffic. Let's Encrypt gives you free HTTPS.
SQLite databases live on the VPS disk (persistent — this is why we use a VPS,
not Render free). Daily backups keep 7 days.

**Pricing:** $199/mo RCM Starter · $199→$499/mo RCM Pro + AI · Custom Enterprise.
Payments via Stripe Checkout (Stripe hosts the card form — card numbers never
touch our server).

---

## 1. File map — where everything lives

| What | Where |
|---|---|
| RCM repo (app + API + landing + deploy script) | `~/workspace/portfolio/rcm-dashboard/` |
| RCM backend | `~/workspace/portfolio/rcm-dashboard/server/` |
| RCM frontend | `~/workspace/portfolio/rcm-dashboard/client/` |
| Landing page (source of truth) | `~/workspace/claimpilot/landing/index.html` |
| Landing page (deployed copy) | `~/workspace/portfolio/rcm-dashboard/landing/` |
| AI repo (app + API) | `~/workspace/portfolio/askbase/` |
| AI backend | `~/workspace/portfolio/askbase/server/` |
| AI frontend | `~/workspace/portfolio/askbase/client/` |
| **Deploy script (the important one)** | `~/workspace/portfolio/rcm-dashboard/deploy/vps-setup.sh` |
| This guide | `~/workspace/portfolio/rcm-dashboard/deploy/GO-LIVE-GUIDE.md` |
| Stripe product setup | `~/workspace/portfolio/rcm-dashboard/server/scripts/setup-stripe.js` |
| Billing API | `~/workspace/portfolio/rcm-dashboard/server/src/routes/billing.js` |
| Billing UI | `~/workspace/portfolio/rcm-dashboard/client/src/pages/Billing.jsx` |
| Env template | `~/workspace/portfolio/rcm-dashboard/server/.env.example` |

**Rule:** edit the landing page in `~/workspace/claimpilot/landing/`, then copy it
into `~/workspace/portfolio/rcm-dashboard/landing/` before deploying:
```
cp ~/workspace/claimpilot/landing/index.html ~/workspace/portfolio/rcm-dashboard/landing/
```

All three folders are git repos, committed and clean. They are NOT on GitHub yet —
that's Phase 3.

---

## 2. Phase 1 — Stripe (test mode first)

Do this on your computer/phone now. Takes ~10 minutes.

1. Go to **https://stripe.com** → sign up (or log in).
2. Make sure you're in **Test mode** (toggle in the top-right of the dashboard —
   it says "Test mode" when on).
3. **Developers → API keys** → copy your **Secret key** (`sk_test_...`).
   Keep it private — it can move money.
4. **Send that `sk_test_` key to me** (paste it in chat — I'll use it once to
   create your products, then it's stored only in your server `.env`, never in
   git or memory).
5. I run the setup (you don't need to):
   ```
   cd ~/workspace/portfolio/rcm-dashboard/server
   STRIPE_SECRET_KEY=sk_test_... npm run setup-stripe
   ```
   This creates two products in your Stripe account:
   - **ClaimPaid RCM Starter** — $199/month recurring
   - **ClaimPaid RCM Pro + AI** — $499/month recurring
   …and prints two price IDs (`price_...`) that go into the server `.env` as
   `STRIPE_PRICE_STARTER` and `STRIPE_PRICE_PRO`.
6. I then run a full **test checkout** with Stripe's test card
   `4242 4242 4242 4242` (any future date, any CVC) to prove the whole loop
   works: checkout → webhook → org marked `active` → portal opens.
7. **Later, when you're ready for real money:** in the Stripe dashboard flip
   **Test mode OFF**, copy the **live** secret key (`sk_live_...`), send it to
   me, I re-run setup (creates live products), and you add the live webhook
   (Phase 8). Nothing else changes.

---

## 3. Phase 2 — Domain: claimpaid.io

1. Go to **Cloudflare** (cloudflare.com), **Porkbun** (porkbun.com), or
   **Namecheap** — any registrar. (Porkbun is cheapest, ~$10–12/yr for `.io`…
   actually `.io` runs ~$30–40/yr. Budget ~$35/yr.)
2. Search **claimpaid.io** → buy it.
3. Leave the nameservers/defaults alone for now — DNS records come in Phase 5.

---

## 4. Phase 3 — Push both repos to GitHub

The deploy script pulls code from GitHub, so both repos need to be there.

1. Go to **https://github.com/new** → create **`claimpaid-rcm`** (private is fine).
   Don't add a README (the repo already has one).
2. On this machine, run:
   ```
   cd ~/workspace/portfolio/rcm-dashboard
   git remote add origin https://github.com/YOUR_USERNAME/claimpaid-rcm.git
   git branch -M main
   git push -u origin main
   ```
   (GitHub will ask you to log in — use a personal access token, not a password:
   GitHub → Settings → Developer settings → Personal access tokens → generate
   with `repo` scope.)
3. Repeat for the AI repo:
   ```
   cd ~/workspace/portfolio/askbase
   git remote add origin https://github.com/YOUR_USERNAME/claimpaid-ai.git
   git branch -M main
   git push -u origin main
   ```
4. Verify: both repos show your latest commits on github.com.

> Your `.env` files are gitignored — secrets never leave your machines.

---

## 5. Phase 4 — Create the VPS

**Recommended: DigitalOcean, Basic $24/mo** (2 vCPU / 4 GB RAM) in the NYC region.
Why: Hetzner raised prices 2–3x in 2026 and their cheap CX line is EU-only and
frequently out of stock; in the US you'd pay ~$38/mo for 4 GB. DO's $24 plan is
the sweet spot — 4 GB RAM comfortably fits both Node apps plus the AI embeddings
model, NYC is minutes from you latency-wise, and the deploy script runs unchanged
(any Ubuntu 24.04 root server works).

Cheaper alternative if you don't mind EU latency (~100ms, fine for a dashboard):
**Hetzner CX23** (2 vCPU / 4 GB, ~€5.49/mo) in Falkenstein/Nuremberg — *only if it
shows as available*; Hetzner marks it out of stock often.

Avoid: anything with 2 GB RAM or less (the AI embeddings model will OOM).

1. Go to **https://cloud.digitalocean.com** → sign up.
2. **Create → Droplets:**
   - Region: **New York**
   - Image: **Ubuntu 24.04**
   - Size: **Basic, $24/mo** (2 vCPU / 4 GB RAM / 80 GB)
   - Networking: **IPv4** (required — the DNS A record and Let's Encrypt need it;
     IPv6-only would lock out IPv4-only visitors. DO includes one IPv4 free.)
   - SSH key: add your public key (`~/.ssh/id_ed25519.pub` on this machine —
     ask me and I'll print it), or use password auth
   - Hostname: `claimpaid-prod`
3. Note the **IP address** (e.g. `1.2.3.4`).
4. SSH in once to confirm: `ssh root@1.2.3.4`

---

## 6. Phase 5 — DNS

1. In your registrar's DNS panel (or Cloudflare DNS if you moved nameservers),
   add an **A record**:
   - Host/Name: `@`
   - Value: your VPS IP
   - TTL: default
2. Verify from this machine:
   ```
   dig +short claimpaid.io
   ```
   It must print your VPS IP. DNS can take 5–30 minutes. The deploy script
   checks this itself and warns you if it's wrong.

---

## 7. Phase 6 — Resend (transactional email)

Without this, password resets and MFA codes only print to the server log.

1. Go to **https://resend.com** → sign up.
2. **API Keys → Create API Key** → copy it (starts with `re_`).
3. For production, add your domain: **Domains → Add Domain** → `claimpaid.io` →
   add the DNS records Resend shows you → wait for verification.
   (For a quick test you can use `onboarding@resend.dev`, but it only sends
   to your own account email.)
4. You'll pass this to the deploy script as `SMTP_PASS`, and use
   `SMTP_FROM=noreply@claimpaid.io` once the domain is verified.

---

## 8. Phase 7 — Run the deploy

SSH into the VPS as root and run **one command**. The script is idempotent —
safe to re-run any time to update.

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_USERNAME/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup.sh
chmod +x vps-setup.sh
DOMAIN=claimpaid.io \
REPO_URL=https://github.com/YOUR_USERNAME/claimpaid-rcm.git \
AI_REPO_URL=https://github.com/YOUR_USERNAME/claimpaid-ai.git \
SMTP_PASS='re_YOUR_RESEND_KEY' \
SMTP_FROM='noreply@claimpaid.io' \
STRIPE_SECRET_KEY='sk_test_...' \
STRIPE_PRICE_STARTER='price_...' \
STRIPE_PRICE_PRO='price_...' \
STRIPE_WEBHOOK_SECRET='whsec_...' \
./vps-setup.sh
```

What it does (~10–15 min, mostly unattended):
- firewall (22/80/443) + fail2ban, Node 22, nginx, certbot
- clones both repos to `/opt/claimpaid-rcm` and `/opt/claimpaid-ai`
- builds both frontends, installs backend deps
- writes both `server/.env` files (random JWT secrets)
- NO demo seeding since deploy #52 (market launch): fresh DBs start empty;
  the first signup creates the first org. Demo accounts were removed.
  (first AI boot downloads the embeddings model, ~90MB — allow a few minutes)
- installs systemd services `claimpaid-rcm` + `claimpaid-ai` (auto-restart, boot)
- nginx: `/` → RCM, `/ai/` → AI, then Let's Encrypt HTTPS
- daily SQLite backups to `/var/backups/claimpaid` (7-day rotation)

> **First deploy:** you won't have the Stripe vars yet (webhook comes in Phase 8).
> Run it without them — billing shows "not enabled yet" gracefully. Re-run the
> script with the Stripe vars added once you have them.

---

## 9. Phase 8 — Stripe webhook (after first deploy)

The webhook tells your server when someone pays. Needs the live domain.

1. Stripe dashboard → **Developers → Webhooks → Add endpoint**
2. URL: `https://claimpaid.io/api/billing/webhook`
3. Select events:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Copy the **Signing secret** (`whsec_...`).
5. Send it to me (or re-run the deploy script yourself with
   `STRIPE_WEBHOOK_SECRET='whsec_...'` added — the script preserves your
   existing `.env` secrets and only fills in what's missing).

---

## 10. Phase 9 — Verify everything

Open these and check:

| URL | Expect |
|---|---|
| `https://claimpaid.io/` | Landing page, new logo, all sections |
| `https://claimpaid.io/app/` | Login screen renders; signup works |
| `https://claimpaid.io/app/` → Settings → Billing & Plan | Plan cards, "not enabled" notice gone once Stripe is wired |
| `https://claimpaid.io/ai/app/` | AI login (RCM account) → Payer Policy Handbook answers with citations |
| Stripe test checkout | Click "Choose Starter" → Stripe test page → pay with `4242…` → redirected back → plan shows **active** |
| `https://claimpaid.io/api/health` | `{"status":"ok"}` |

Useful commands on the VPS:
```bash
journalctl -u claimpaid-rcm -f     # RCM logs (follow)
journalctl -u claimpaid-ai -f      # AI logs (follow)
systemctl restart claimpaid-rcm claimpaid-ai   # restart both
ls /var/backups/claimpaid/         # backups
```

---

## 11. Phase 10 — Go live with real money

1. Stripe dashboard → **Test mode OFF**.
2. Copy the **live** secret key (`sk_live_...`) → send to me.
3. I run `npm run setup-stripe` again (creates the **live** $199/$499 products).
4. Add the **live** webhook (same URL, same 3 events) → send me the live
   `whsec_...`.
5. Re-run the deploy script with the live keys.
6. Do one real $199 checkout yourself, then refund it in the Stripe dashboard
   (proves the live loop, costs you nothing but the Stripe fee).

---

## 12. Ongoing operations

- **Update the site:** push to GitHub, then re-run `vps-setup.sh` on the VPS
  (it does `git pull` + rebuild + restart — same command as Phase 7).
- **Landing page edits:** edit `~/workspace/claimpilot/landing/index.html`,
  copy to `~/workspace/portfolio/rcm-dashboard/landing/`, commit, push,
  re-run deploy.
- **Backups:** automatic daily, `/var/backups/claimpaid/`, 7-day rotation.
- **If the AI answers stop citing / break:** it's the extractive demo mode —
  add a Groq key for generative answers: in Stripe terms it's optional, set
  `LLM_PROVIDER=groq` + `LLM_API_KEY=gsk_...` in `/opt/claimpaid-ai/server/.env`
  and `systemctl restart claimpaid-ai`. (Groq has a free tier.)
- **Costs:** VPS ~$24/mo · domain ~$35/yr · Resend free tier ·
  Stripe 2.9% + 30¢ per transaction. Total fixed: **~$27/mo**.

---

## Quick reference — your action checklist

- [ ] Phase 1: Stripe account → send me `sk_test_` key
- [ ] Phase 2: Buy claimpaid.io
- [ ] Phase 3: Create 2 GitHub repos → push both
- [ ] Phase 4: Create VPS (DO Basic $24/mo NYC, IPv4) → note IP
- [ ] Phase 5: DNS A record `@` → VPS IP → verify with `dig`
- [ ] Phase 6: Resend API key (+ verify domain)
- [ ] Phase 7: Run deploy script on VPS
- [ ] Phase 8: Stripe webhook → send me `whsec_...`
- [ ] Phase 9: Verify all URLs
- [ ] Phase 10: Live Stripe keys → one real test purchase → refund
