# Set up computers

Open **Settings → Computers → Add computer**. In this one dialog, choose **Local**, **SSH**, or **Tailscale**. Local uses this machine. SSH takes an IP or hostname, optional name, username, and port. Workjet asks for a password if SSH requires one. Tailscale takes a tailnet IP or hostname and uses SSH; both computers must be on your tailnet and the remote computer must accept SSH.

After connecting, Workjet checks the installed coding tools and adds the computer to the list. Select a computer there to use it for the next session. Its connection type comes from the actual connection. Editing its name does not change how it connects.

The computer list checks coding tools on each connected machine and shows its installed versions or missing tools. While a check runs, the list shows progress. A disconnected computer is marked as disconnected and its previous tool results are hidden; reconnect it to check again.

Previously saved connections appear in the same computer list automatically. Connect and disconnect from the computer’s row. Expand **Coding tools** to inspect availability; use Edit to change the name or enabled tools. Editing a computer keeps its connection fixed. Remove its Business OS assignment before removing the computer.

For an already running Workjet host, use **Already running Workjet? → Use a pairing link** in the same add dialog. Installation and repair tools remain under **Advanced setup and repair**.

## Adding a project

The folder dialog shows progress while Workjet connects to the selected Business OS, registers the folder, and waits for the confirmed project. If confirmation fails, the dialog shows an error and allows another attempt.

Choosing a project in the sidebar opens that project's workspace. The project name, new-thread composer, and working directory follow the selection. Existing conversations and drafts in other projects remain saved. If a project has no working copy on the chosen computer, Workjet opens its project page so you can choose a computer.

## macOS sign-in

Workjet accesses saved credentials without opening a macOS Keychain password dialog. Already authorized credentials remain usable. If macOS denies access, the existing encrypted credentials are retained; Workjet cannot recover them by requesting your Keychain password. The app does not switch to plaintext storage or change Keychain permissions.
