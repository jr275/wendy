#!/usr/bin/env bash
# Starts whatever of Wendy is not running on this Mac: the agent (3458), the read API (3457), the worker and the web (3010).
# Safe to run any time (it never starts a second copy) and after a restart of the computer. Logs go to ~/Wendy/logs.
# Nothing here changes the database: the worker refuses to start if a migration is pending (run `npm run migrate` after a backup).
set -uo pipefail
cd "$(dirname "$0")/.."
LOGS="$HOME/Wendy/logs"
mkdir -p "$LOGS"
up() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
start() { # name, port-or-pattern, command...
  local name="$1" probe="$2"; shift 2
  if [ "$probe" != "-" ] && up "$probe"; then echo "ok    $name already running"; return; fi
  if [ "$probe" = "-" ] && pgrep -f "$1 $2 $3" >/dev/null 2>&1; then echo "ok    $name already running"; return; fi
  nohup "$@" >"$LOGS/$name.log" 2>&1 &
  disown 2>/dev/null || true
  echo "start $name (log: $LOGS/$name.log)"
}
start agent 3458 env GEMINI_FAST_MODEL="${GEMINI_FAST_MODEL:-}" npm run agent
start inspector 3457 npx tsx inspector/server.ts
if pgrep -f "src/runtime/workerCli.ts" >/dev/null 2>&1; then echo "ok    worker already running"; else nohup npm run worker >"$LOGS/worker.log" 2>&1 & disown 2>/dev/null || true; echo "start worker (log: $LOGS/worker.log)"; fi
( cd web && start web 3010 npx next dev -H 127.0.0.1 -p 3010 ) 
sleep 12
for p in 3458:agent 3457:inspector 3010:web; do up "${p%%:*}" && echo "up    ${p##*:}" || echo "DOWN  ${p##*:} (see $LOGS/${p##*:}.log)"; done
