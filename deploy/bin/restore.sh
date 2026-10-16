#!/usr/bin/env bash
# Run on the SERVER, in deploy/, BEFORE starting the apps: loads the dump made by dump-local.sh into the empty database.
# Refuses to touch a database that already has tables unless FORCE=1.
set -euo pipefail
DUMP="${1:?usage: bin/restore.sh /path/to/wendy-transfer.dump}"
[ -f "$DUMP" ] || { echo "dump not found: $DUMP" >&2; exit 1; }
docker compose up -d db
for _ in $(seq 1 30); do docker compose exec -T db pg_isready -U wendy -d wendy >/dev/null 2>&1 && break; sleep 2; done
TABLES="$(docker compose exec -T db psql -U wendy -d wendy -Atc "select count(*) from information_schema.tables where table_schema = 'public'")"
if [ "${TABLES}" != "0" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "The database already has ${TABLES} tables. Nothing was changed. Back it up (bin/backup.sh) and run with FORCE=1 only if you mean to replace it." >&2
  exit 1
fi
docker compose exec -T db pg_restore -U wendy -d wendy --no-owner --no-privileges --clean --if-exists < "$DUMP"
echo "Restored. Tables now: $(docker compose exec -T db psql -U wendy -d wendy -Atc "select count(*) from information_schema.tables where table_schema = 'public'")"
