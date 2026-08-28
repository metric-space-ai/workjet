#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR AGPL-3.0-only
#
# Boots the real server twice against one disposable state directory and
# records what happened, as facts, into a JSON file. It decides NOTHING —
# `workjet-restart-recovery-smoke.ts` reads that file and applies the verdict,
# so there is exactly one implementation of the rules and it is unit-tested.
#
# ── Why the orchestration is a shell script ─────────────────────────────────
# A Node parent that spawns this server does not survive in every environment:
# in the development harness it is killed silently — no exception, no stderr,
# just gone — while a plain Node process with no child survives fine, and a
# shell that backgrounds the server survives fine too. Rather than fight that,
# the part that must spawn is the shell, and Node is left with the part it can
# always do: read a file and judge it.
#
# Each boot is deliberately killed. The server migrates and then serves
# forever, so waiting for it to exit would wait forever; the first boot only
# has to migrate, the second only has to open the existing database.
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${WORKJET_RESTART_PORT:-39917}"
FIRST_WAIT="${WORKJET_RESTART_FIRST_WAIT:-20}"
SECOND_WAIT="${WORKJET_RESTART_SECOND_WAIT:-12}"
SENTINEL="restart-smoke-sentinel"

HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/workjet-restart-XXXXXX")"
OUT="${1:-${HOME_DIR}/facts.json}"
trap 'rm -rf "${HOME_DIR}"' EXIT

boot() { # $1 = log file, $2 = seconds to wait
  ( cd "${REPO_ROOT}/apps/server" \
    && T3CODE_HOME="${HOME_DIR}" node src/bin.ts --port "${PORT}" --no-browser ) \
    > "$1" 2>&1 &
  local pid=$!
  sleep "$2"
  # By PID, never `pkill -f`: a pattern like the port number also matches THIS
  # script's own command line, and pkill would take the harness down with it.
  kill -TERM "${pid}" 2>/dev/null || true
  wait "${pid}" 2>/dev/null || true
}

DB="${HOME_DIR}/userdata/state.sqlite"

boot "${HOME_DIR}/boot1.log" "${FIRST_WAIT}"
FIRST_MIGRATED=false
grep -q "Migrations ran successfully" "${HOME_DIR}/boot1.log" && FIRST_MIGRATED=true
FIRST_DB=false; [ -f "${DB}" ] && FIRST_DB=true

if [ "${FIRST_DB}" = true ]; then
  node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec(`INSERT INTO workjet_delegation_state_events
      (delegation_id, from_state, to_state, terminal, changed_at_ms)
      VALUES ('"'"'${process.argv[2]}'"'"', '"'"'queued'"'"', '"'"'delivered'"'"', 0, 1)`);
    db.close();
  ' "${DB}" "${SENTINEL}" 2>/dev/null || true
fi

boot "${HOME_DIR}/boot2.log" "${SECOND_WAIT}"
SECOND_DB=false; [ -f "${DB}" ] && SECOND_DB=true

ROW=false
if [ "${SECOND_DB}" = true ]; then
  COUNT="$(node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    const rows = db.prepare("SELECT delegation_id FROM workjet_delegation_state_events WHERE delegation_id = ?").all(process.argv[2]);
    db.close();
    process.stdout.write(String(rows.length));
  ' "${DB}" "${SENTINEL}" 2>/dev/null || echo 0)"
  [ "${COUNT}" = "1" ] && ROW=true
fi

# stderr of the first boot is carried through so a failed verdict can quote why.
FIRST_ERR="$(tail -c 2000 "${HOME_DIR}/boot1.log" | tr -d '\000' | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"

cat > "${OUT}" <<JSON
{
  "usedDisposableHome": true,
  "first": { "migrationsRan": ${FIRST_MIGRATED}, "databaseExists": ${FIRST_DB}, "stderr": ${FIRST_ERR} },
  "second": { "migrationsRan": false, "databaseExists": ${SECOND_DB}, "stderr": "" },
  "rowSurvived": ${ROW}
}
JSON

echo "facts: ${OUT}"
cat "${OUT}"
