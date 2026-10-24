# Backup encryption — ClaimPaid

## What this is
Daily SQLite backups (RCM + AI databases) are encrypted with
[age](https://age-encryption.org) (X25519) the moment they're written.
Each backup is **decrypt-verified before its plaintext is deleted**, so a
failed encryption never silently destroys the only copy. 7-day rotation,
kept as `*.db.age` files in `/var/backups/claimpaid/`.

Wired in `deploy/vps-setup.sh` (idempotent — safe to re-run). The cron job
is `/etc/cron.daily/claimpaid-backup`.

## The key
- Location (droplet only): `/root/.claimpaid-backup.agekey` — mode `0600`, root-only.
- Generated once by `vps-setup.sh` via `age-keygen`. It is **never** in git,
  never in the repo, never printed to logs.
- If this key is lost, existing `.age` backups are **unrecoverable**. Back it
  up somewhere safe (password manager) — the file is small text.

## Restore from an encrypted backup (emergency, from the droplet console as root)

```sh
# 1. Decrypt the backup you want (pick the date from /var/backups/claimpaid/)
age --decrypt -i /root/.claimpaid-backup.agekey \
  -o /tmp/rcm-restored.db \
  /var/backups/claimpaid/rcm-2026-10-24.db.age

# 2. Sanity-check it opens
sqlite3 /tmp/rcm-restored.db "SELECT count(*) FROM claims;" 2>/dev/null || echo "check manually"

# 3. Stop the app, swap it in, fix ownership, restart
systemctl stop claimpaid-rcm
cp /opt/claimpaid-rcm/server/rcm.db /opt/claimpaid-rcm/server/rcm.db.before-restore
cp /tmp/rcm-restored.db /opt/claimpaid-rcm/server/rcm.db
chown claimpaid:claimpaid /opt/claimpaid-rcm/server/rcm.db
systemctl start claimpaid-rcm
```

Same pattern for the AI database (`ai-YYYY-MM-DD.db.age` →
`/opt/claimpaid-ai/server/askbase.db`, service `claimpaid-ai`).

## Honest threat model
- **What this protects:** backup files — especially any copy that ever leaves
  this disk (downloaded, copied, leaked). Without the key, `.age` files are
  useless.
- **What this does NOT protect:** full-disk-image theft. The key lives on the
  same disk, so anyone who obtains a complete disk image gets the key too.
  DigitalOcean does **not** encrypt droplet local disks at rest
  ([shared responsibility model](https://www.digitalocean.com/security/shared-responsibility-model-droplets):
  "The virtual disks for Droplets stored on the hypervisor's local storage
  are not encrypted at rest").
- **The real fix for live data at rest:** attach a DigitalOcean Block Storage
  volume (LUKS-encrypted at rest by DO, ~$0.10/GB/mo), mount it at
  `/mnt/claimpaid-data`, and move the databases + backup dir onto it:

```sh
# one-time, as root, with the app stopped
systemctl stop claimpaid-rcm claimpaid-ai
mkdir -p /mnt/claimpaid-data
# (attach + format + mount the volume first, then:)
mv /opt/claimpaid-rcm/server/rcm.db /mnt/claimpaid-data/rcm.db
mv /opt/claimpaid-ai/server/askbase.db /mnt/claimpaid-data/askbase.db
ln -s /mnt/claimpaid-data/rcm.db /opt/claimpaid-rcm/server/rcm.db
ln -s /mnt/claimpaid-data/askbase.db /opt/claimpaid-ai/server/askbase.db
chown -h claimpaid:claimpaid /opt/claimpaid-rcm/server/rcm.db /opt/claimpaid-ai/server/askbase.db
chown claimpaid:claimpaid /mnt/claimpaid-data/*.db
systemctl start claimpaid-rcm claimpaid-ai
```

  The backup cron follows symlinks, so no script changes are needed. The
  droplet must never boot without the volume attached — if it does, the
  symlinks dangle and the apps fail closed (loudly, in the logs).
