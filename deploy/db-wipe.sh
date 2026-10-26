#!/bin/bash
# db-wipe.sh — clean-slate reset of the production database.
# Usage:
#   bash db-wipe.sh            -> DRY RUN report (nothing changes)
#   bash db-wipe.sh --confirm  -> executes the wipe
# Deletes ALL organizations and ALL users except the super-admin login.
# The app is stopped during the run and restarted after.
set -u
cd /opt/claimpaid-rcm
echo "Stopping claimpaid-rcm..."
if [ "$(id -u)" = "0" ]; then SUDO=""; else SUDO="sudo"; fi
$SUDO systemctl stop claimpaid-rcm
cp server/rcm.db "server/rcm.db.bak.$(date +%s)" && echo "Backup saved: server/rcm.db.bak.*"
DB_PATH=/opt/claimpaid-rcm/server/rcm.db node deploy/wipe-prod.cjs "$@"
echo "Starting claimpaid-rcm..."
$SUDO systemctl start claimpaid-rcm
sleep 3
systemctl is-active claimpaid-rcm || true
echo "DONE. Tell Bot: wipe done (screenshot this output)"
