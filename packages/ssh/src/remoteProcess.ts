// A nohup child can still belong to an SSH session that is torn down on logout.
// A user service owns its process independently, including on Tailscale SSH.
export const REMOTE_PROCESS_START_SCRIPT = `start_remote_process() {
  if command -v systemd-run >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    WORKJET_SERVICE_UNIT="workjet-ssh-$STATE_KEY-$$.service"
    if ! systemd-run --user --quiet --collect --unit "$WORKJET_SERVICE_UNIT" --property=Type=exec -- \\
      /bin/sh -c 'log_file=$1; shift; exec "$@" >>"$log_file" 2>&1 </dev/null' sh "$LOG_FILE" env "PATH=$PATH" "$@"; then
      printf 'Could not start the Workjet backend as a user service.\\n' >&2
      return 1
    fi
    REMOTE_PID="$(systemctl --user show --property=MainPID --value "$WORKJET_SERVICE_UNIT")" || REMOTE_PID=""
    case "$REMOTE_PID" in
      ''|0|*[!0-9]*)
        systemctl --user stop "$WORKJET_SERVICE_UNIT" >/dev/null 2>&1 || true
        printf 'The Workjet user service exited before its process could be tracked. Check the remote backend log.\\n' >&2
        return 1
        ;;
    esac
  else
    nohup "$@" >>"$LOG_FILE" 2>&1 < /dev/null &
    REMOTE_PID="$!"
  fi
}
`;
