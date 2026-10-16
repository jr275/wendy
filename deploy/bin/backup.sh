#!/usr/bin/env bash
# Run on the SERVER (cron). Nightly custom-format dump into deploy/backups, mode 600, keeping the last 14. Prints sizes only, never contents.
# A backup that lives only on the same server is not a backup against losing the server: copy deploy/backups elsewhere too (see README).
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mkdir -p backups
F="backups/wendy-$(date +%Y%m%d-%H%M%S).dump"
docker compose exec -T db pg_dump -U wendy -d wendy -Fc > "$F"
chmod 600 "$F"
[ -s "$F" ] || { echo "empty backup, removing" >&2; rm -f "$F"; exit 1; }
find backups -name 'wendy-*.dump' -mtime +14 -delete
echo "backup ok: $F ($(du -h "$F" | cut -f1))"
