# Running Workjet in the Background

Automatic background setup for macOS Desktop is planned for an upcoming release.
Its full Quit/reopen behavior has not yet been validated. The intended behavior is
that a new local profile gets a background service, work continues after Quit while
you remain logged in, and reopening Workjet reconnects to that service. Logging out
ends the macOS user service. Do not rely on this upcoming Desktop behavior yet.

The upcoming macOS setup will ask before migrating a profile from an older release.
Finish active work and stop all older Workjet apps and command-line runtimes using
that profile before confirming. Setup will back up the database before installing
the service. Cancel leaves the profile unchanged; a failed or uncertain setup stops
without starting a replacement foreground server. Incomplete or changed migration
data needs explicit repair. This migration flow still needs installed-app validation.

The upcoming Desktop connection recovery will also ask before replacing an expired
or unreadable saved session. Close other Workjet installations using the same profile
before confirming. Recovery revokes the identified session, preserves the old encrypted
files, and reconnects. Cancel or an unconfirmed revocation leaves recovery information
in place. Unknown or conflicting identities require explicit repair. This flow still
needs validation in the signed app.

On a Linux host, Workjet can run as a background service for your user. It starts when the machine
boots and keeps running after you log out.

## Manage the Service

Install it with the latest Workjet release:

```sh
workjet service install
```

Check whether it is installed:

```sh
workjet service status
```

Update or repair it:

```sh
workjet service update
```

Stop it and remove it from startup:

```sh
workjet service uninstall
```

Updating restarts Workjet briefly. Let active agent work and terminal commands finish first.
If a remote update is already in progress, wait for it to finish before retrying a local update.

The systemd unit runs a small stable launcher. Exact Workjet versions are installed separately, so
a failed remote candidate can return to the previous version without rewriting the unit. The
launcher snapshots the database before a remote candidate starts, so database updates roll back
with the server version. An older launcher may require one local `service update` before this is
available.

## Using It with Workjet Connect

Workjet Connect may offer to install the service during setup so the host stays reachable after you log
out. This is only an onboarding shortcut: the service and Workjet Connect are managed separately.

Signing out of Workjet Connect does not remove the service. Use `workjet service uninstall` when you no longer
want Workjet to start in the background.

Background services require Linux with systemd or a macOS login session. Profile-specific Desktop attachment currently supports macOS.
