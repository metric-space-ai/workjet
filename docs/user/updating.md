# Keeping Workjet in Sync

The Workjet web or desktop app and the server it connects to work best when they use the same
version. If they do not match, Workjet shows a warning with the right update option for that server.

## Where to Find the Update

You may see the warning in either of these places:

- above the message box in the current conversation
- **Settings** → **Connections**, beside the affected connection

Dismissing the conversation warning only hides that reminder for those two versions. It does not
update the server, and the version difference remains visible in Connections.

## Before You Update

Let active agent work and terminal commands finish first. Updating restarts the server, so the
connection will disappear briefly and work that is still running may be interrupted.

The update does not remove saved threads, settings, or project files.

## Choose the Action You See

| Action                     | What to do                                                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Available for the Workjet Linux background service. Select the button and leave Workjet open while it prepares, tests, restarts, and reconnects.                            |
| **Update the desktop app** | Open the Workjet desktop app on the machine that runs the server and install the app update there. Reopen it if needed.                                                     |
| **Copy update command**    | Copy the command, open a terminal on the server machine, stop the current Workjet server, and relaunch it with the copied command and any startup options you normally use. |

The available action depends on how that server was started. Workjet does not update connected
servers silently in the background.

An older background-service launcher may ask you to run the exact
`workjet service update` command using the matching Workjet CLI distribution on the server machine. That local update installs the
rollback support needed for later remote updates, including versions that change the database.

After selecting **Update**, the notice becomes a live status line: **Downloading…** while the new
version is fetched and verified, then **Restarting…** while the server restarts into it. The same
status appears in the conversation and in Connections, so navigating between them does not lose the
update. A failure remains visible with its error and an option to retry.

Use the Workjet distribution matching the client version, then relaunch its `workjet` CLI
with the startup options you normally use. Only use a copied package-manager command when
your distribution explicitly supports that package source.

If the server instead runs as the Workjet background service, update the service on the host and
pin the same version:

```sh
workjet service update
```

`service update` installs the version of the CLI that invoked it. Install the matching Workjet
distribution first; running a different CLI version does not resolve the version mismatch.

See [Running Workjet in the Background](./background-service.md) for install, status, and removal
commands.

## After the Update

Keep the web or desktop app open while the server restarts. The update completes only after the
service launcher reports that exact update committed and the replacement server is ready to accept
commands. A rollback is reported immediately instead of waiting for a generic reconnect timeout.

If a step fails:

1. Retry the offered action once.
2. Make sure you updated the machine named in the warning, not only the device you are using.
3. For a command-line server, install the distribution matching the client version shown in
   the warning, then relaunch its `workjet` executable.

For remote connection setup and access troubleshooting, see [Remote Access](./remote-access.md).
