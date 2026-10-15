#!/bin/sh
# Workjet Linux launcher.
#
# The electron-builder afterPack hook (linux-launcher-after-pack.cjs) moves the
# Electron binary to "<executable>-bin" and installs this script under the
# original executable name, so the .desktop entry, /usr/bin/workjet and the
# AppImage AppRun all start here.
#
# Chromium sets up its zygote and sandbox before any app JavaScript runs, so a
# switch appended from the Electron main process cannot rescue a start where no
# sandbox can be built: the browser process dies with SIGTRAP before the first
# renderer. That happens when the kernel offers no user namespaces (Android
# kernels under Termux proot-distro: /proc/self/uid_map is missing) AND the
# setuid chrome-sandbox helper cannot gain root (it is not setuid-root, or the
# process is ptrace-traced, as under PRoot, where the kernel ignores the setuid
# bit). Only in exactly that case does Workjet start without the sandbox.
# Everywhere else the arguments pass through unchanged and the sandbox stays on.
#
# Deliberately no `unshare -Ur` probe: on Ubuntu 24.04+ that fails for an
# unconfined shell although Electron itself gets user namespaces through its
# AppArmor profile, so the probe would switch the sandbox off on normal systems.
set -u

# Test seams: the launcher test replaces these three lines with a fake root.
PROC_ROOT=/proc
DEV_ROOT=/dev
SANDBOX_ROOT_UID=0

self=$(readlink -f -- "$0" 2>/dev/null) || self=$0
here=$(dirname -- "$self")
electron="$here/$(basename -- "$self")-bin"
sandbox_helper="$here/chrome-sandbox"

user_namespaces_available() {
  # Kernel without CONFIG_USER_NS: neither file exists.
  [ -e "$PROC_ROOT/self/ns/user" ] || return 1
  [ -e "$PROC_ROOT/self/uid_map" ] || return 1
  # Debian's knob and the generic namespace limit can switch them off.
  for knob in "$PROC_ROOT/sys/kernel/unprivileged_userns_clone" "$PROC_ROOT/sys/user/max_user_namespaces"; do
    if [ -r "$knob" ] && [ "$(cat "$knob" 2>/dev/null)" = 0 ]; then
      return 1
    fi
  done
  return 0
}

setuid_helper_usable() {
  [ -n "$(find "$sandbox_helper" -prune -user "$SANDBOX_ROOT_UID" -perm -4755 2>/dev/null)" ] || return 1
  # A ptrace-traced process (PRoot traces every process it runs) never gains
  # the privileges of a setuid binary it executes.
  tracer=$(sed -n 's/^TracerPid:[[:space:]]*//p' "$PROC_ROOT/self/status" 2>/dev/null)
  [ "${tracer:-0}" = 0 ]
}

gpu_render_node_usable() {
  # Open read-write instead of `test -r/-w`: dash answers those from the
  # (PRoot-faked) effective uid 0 instead of asking the kernel.
  for node in "$DEV_ROOT"/dri/renderD*; do
    if (: <>"$node") 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

if user_namespaces_available || setuid_helper_usable; then
  exec "$electron" "$@"
fi

# Without any render node the GPU process cannot initialise hardware
# acceleration anyway (drmGetDevices2: Permission denied under PRoot).
fallback="--no-sandbox --no-zygote"
if ! gpu_render_node_usable; then
  set -- --disable-gpu "$@"
  fallback="$fallback --disable-gpu"
fi
set -- --no-sandbox --no-zygote "$@"
# Name only the added switches: the remaining arguments can carry deep links.
echo "workjet: Chromium sandbox unavailable (no user namespaces, setuid helper unusable); starting with $fallback" >&2
exec "$electron" "$@"
