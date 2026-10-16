#!/usr/bin/env bash
# Run on YOUR MAC. Writes a private, restorable copy of the Wendy database (custom format, no owners) for the migration.
# The file holds personal data (e-mail index, memories, conversations): keep it mode 600, move it only over scp/ssh, delete it afterwards.
set -euo pipefail
umask 077
OUT="${1:-$HOME/wendy-transfer-$(date +%Y%m%d-%H%M%S).dump}"
pg_dump --no-owner --no-privileges -Fc "${DATABASE_URL:-postgres:///wendy}" -f "$OUT"
chmod 600 "$OUT"
echo "Dump written: $OUT ($(du -h "$OUT" | cut -f1)), mode $(stat -f '%Sp' "$OUT" 2>/dev/null || stat -c '%A' "$OUT")"
