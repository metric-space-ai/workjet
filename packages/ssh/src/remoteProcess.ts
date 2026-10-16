// A nohup child can still belong to an SSH session that is torn down on logout.
// A user service owns its process independently, including on Tailscale SSH.
// The user manager itself only outlives the last login with lingering on
// (headless hosts, SteamOS with KillUserProcesses=yes, reboots): turn it on
// for this user where logind/polkit or passwordless sudo allow it, and leave
// a line in the backend log where neither does.
export const REMOTE_PROCESS_START_SCRIPT = `keep_user_manager_alive() {
  command -v loginctl >/dev/null 2>&1 || return 0
  workjet_user="$(id -un 2>/dev/null || true)"
  [ -n "$workjet_user" ] || return 0
  case "$(loginctl show-user "$workjet_user" --property=Linger --value 2>/dev/null || true)" in
    yes) return 0 ;;
  esac
  if loginctl enable-linger "$workjet_user" >/dev/null 2>&1; then return 0; fi
  if command -v sudo >/dev/null 2>&1 && sudo -n loginctl enable-linger "$workjet_user" >/dev/null 2>&1; then return 0; fi
  printf 'Workjet: lingering is off for %s; this backend stops when the last login of %s ends (sudo loginctl enable-linger %s keeps it running).\\n' "$workjet_user" "$workjet_user" "$workjet_user" >>"$LOG_FILE" 2>/dev/null || true
  return 0
}
start_remote_process() {
  if command -v systemd-run >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    keep_user_manager_alive
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
