import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/**
 * A managed remote backend that runs an older bundled server than the app
 * carries is replaced, but only while it is idle: no thread session is
 * starting or running a turn and no worker run is open. A busy backend keeps
 * running; the update is re-checked every few minutes while the connection
 * stands. Running work is never interrupted.
 */
export const REMOTE_UPDATE_RECHECK_INTERVAL = Duration.minutes(3);

/** Seconds the old backend gets to exit after SIGTERM before the update fails. */
const REMOTE_UPDATE_STOP_WAIT_TENTHS = 300;

export type RemoteUpdateCheck = "idle" | "busy" | "current" | "gone";
export type RemoteUpdateStop = "stopped" | "busy" | "current" | "gone";

/**
 * `sh -s -- <state-key> check|stop`. `check` only reads; `stop` re-checks the
 * activity right before it terminates the backend this client started (PID
 * from its own state directory, never the default runtime of another
 * install) and keeps the port file so the restart binds the same remote port
 * and the existing local forward stays valid.
 *
 * Activity comes from the new server package (`__activity`), which reads the
 * backend's state store read-only; any failure to answer counts as busy.
 */
export const REMOTE_UPDATE_SCRIPT = `set -eu
STATE_KEY="$1"
MODE="$2"
STATE_DIR="$HOME/.workjet/ssh-launch/$STATE_KEY"
DEFAULT_SERVER_HOME="$HOME/.workjet"
PID_FILE="$STATE_DIR/pid"
MANAGED_FILE="$STATE_DIR/managed"
RUNNER_FILE="$STATE_DIR/run-workjet.sh"
EXPECTED_SCRIPT=@@WORKJET_EXPECTED_SCRIPT@@
REMOTE_MANAGED="$(cat "$MANAGED_FILE" 2>/dev/null || true)"
REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ "$REMOTE_MANAGED" != "managed" ] || [ -z "$REMOTE_PID" ] || ! kill -0 "$REMOTE_PID" 2>/dev/null; then
  printf '{"update":"gone"}\\n'
  exit 0
fi
RUNNING_ARGS="$(ps -o args= -p "$REMOTE_PID" 2>/dev/null || true)"
case "$RUNNING_ARGS" in
  '') printf '{"update":"gone"}\\n'; exit 0 ;;
  *"$EXPECTED_SCRIPT"*) printf '{"update":"current"}\\n'; exit 0 ;;
  *workjet*) ;;
  *) printf '{"update":"gone"}\\n'; exit 0 ;;
esac
ACTIVITY="$("$RUNNER_FILE" __activity --base-dir "$DEFAULT_SERVER_HOME" 2>/dev/null || true)"
case "$ACTIVITY" in
  *'"idle":true'*) ;;
  *) printf '{"update":"busy"}\\n'; exit 0 ;;
esac
if [ "$MODE" != "stop" ]; then
  printf '{"update":"idle"}\\n'
  exit 0
fi
# An exited child that its parent has not reaped yet counts as stopped.
alive() {
  kill -0 "$1" 2>/dev/null || return 1
  case "$(ps -o stat= -p "$1" 2>/dev/null || true)" in Z*) return 1 ;; esac
  return 0
}
kill "$REMOTE_PID" 2>/dev/null || true
WAIT_COUNT=0
while alive "$REMOTE_PID" && [ "$WAIT_COUNT" -lt ${REMOTE_UPDATE_STOP_WAIT_TENTHS} ]; do
  WAIT_COUNT=$((WAIT_COUNT + 1))
  sleep 0.1
done
if alive "$REMOTE_PID"; then
  printf 'The previous Workjet backend did not stop.\\n' >&2
  exit 1
fi
rm -f "$PID_FILE" "$MANAGED_FILE"
printf '{"update":"stopped"}\\n'
`;

const shellSingleQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

export function buildRemoteUpdateScript(expectedNodeScriptPath: string): string {
  return REMOTE_UPDATE_SCRIPT.replaceAll(
    "@@WORKJET_EXPECTED_SCRIPT@@",
    shellSingleQuote(expectedNodeScriptPath),
  );
}

const UPDATE_STATES = new Set(["idle", "busy", "current", "gone", "stopped"]);

/** The last `{"update":"…"}` line; null when the host printed none. */
export function parseRemoteUpdateOutput(stdout: string): string | null {
  const matches = [...stdout.matchAll(/\{"update":"([a-z]+)"\}/gu)];
  const state = matches.at(-1)?.[1];
  return state !== undefined && UPDATE_STATES.has(state) ? state : null;
}

export type RemoteUpdatePhase = "updating" | "updated" | "update-failed";

export interface RemoteServerUpdateOperations<E, R> {
  readonly check: Effect.Effect<RemoteUpdateCheck, E, R>;
  readonly stop: Effect.Effect<RemoteUpdateStop, E, R>;
  /** Starts the new backend and restores the connection. */
  readonly restart: Effect.Effect<void, E, R>;
  readonly report: (phase: RemoteUpdatePhase) => Effect.Effect<void>;
  readonly recheckInterval?: Duration.Input;
}

export type RemoteServerUpdateOutcome = "updated" | "current" | "gone";

/**
 * Waits for an idle backend, then stops, restarts and reconnects it. Reports
 * `updating` only once the stop is about to happen, `updated` after the
 * restart and `update-failed` on any failure (which ends the attempt; the
 * next ensure of the environment starts a new one).
 */
export const runRemoteServerUpdate = Effect.fn("ssh.remoteServerUpdate")(function* <E, R>(
  operations: RemoteServerUpdateOperations<E, R>,
): Effect.fn.Return<RemoteServerUpdateOutcome, E, R> {
  const interval = operations.recheckInterval ?? REMOTE_UPDATE_RECHECK_INTERVAL;
  while (true) {
    const checked = yield* operations.check.pipe(
      Effect.tapError(() => operations.report("update-failed")),
    );
    if (checked === "current" || checked === "gone") return checked;
    if (checked === "busy") {
      yield* Effect.logInfo("ssh.remoteServer.update.deferred");
      yield* Effect.sleep(interval);
      continue;
    }
    yield* operations.report("updating");
    const outcome = yield* Effect.gen(function* () {
      const stopped = yield* operations.stop;
      if (stopped !== "stopped") return stopped;
      yield* operations.restart;
      return "updated" as const;
    }).pipe(Effect.tapError(() => operations.report("update-failed")));
    if (outcome === "busy") {
      // A turn started between the check and the stop: nothing was stopped.
      yield* operations.report("updated");
      yield* Effect.sleep(interval);
      continue;
    }
    yield* operations.report("updated");
    return outcome;
  }
});
