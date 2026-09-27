# Running Workjet in the Background

On macOS, Workjet Desktop sets up a background service for a new local profile.
The service continues running after you quit Workjet, while you remain logged in.
Reopening Workjet reconnects to the service. Logging out ends the macOS user service.

Automatic migration of profiles created by older releases is not yet available.
If Workjet requests migration or repair, finish active work and stop the old runtime
before migrating the existing profile. Failed setup does not start a replacement
foreground server against the same data.

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
