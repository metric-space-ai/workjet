# Set up computers

Open **Settings → Computers → Add computer**. In this one dialog, choose **Local**, **SSH**, or **Tailscale**. Local uses this machine. SSH takes an IP or hostname, optional name, username, and port. Workjet asks for a password if SSH requires one. Tailscale takes a tailnet IP or hostname and uses SSH; both computers must be on your tailnet and the remote computer must accept SSH.

After connecting, Workjet checks the installed coding tools and adds the computer to the list. Select a computer there to use it for the next session. Its connection type comes from the actual connection. Editing its name does not change how it connects.

The computer list checks coding tools on each connected machine and shows its installed versions or missing tools. While a check runs, the list shows progress. A disconnected computer is marked as disconnected and its previous tool results are hidden; reconnect it to check again.

If SSH setup cannot reach a computer, Workjet makes up to four attempts, with pauses of 3, 15, and 60 seconds. After that, the connection error stays visible. Check the address or jump route and choose **Connect** to try again. Returning to the app does not restart setup. A network reconnection starts a new attempt.

When Tailscale SSH requires approval, open the approval link shown in the error and approve access, then reconnect. A saved SSH alias uses its configured jump route.

Previously saved connections appear in the same table automatically. The status dot reflects the connection; coding tool chips show a check only after that computer reports availability. Hover over a tool for its version or the reason it is missing. Use **Use** to select a computer and the row’s **⋯** menu for Edit, Connection, Business OS assignment, or Remove. Editing keeps its connection fixed. A computer with a confirmed Business OS assignment must be unassigned before removal. If the Business OS is unavailable, you can still remove a local saved connection; this does not unassign or revoke the remote computer.

Registered build, storage, and GPU capabilities appear as chips. Select them to open the capabilities drawer; saved GPU details appear when supplied by the Business OS. A storage-only NAS has its own row and cannot be selected as a coding computer. More than five computers adds a capability filter. This machine appears first, followed by connected and disconnected computers.

Closing the Desktop window leaves a managed SSH computer running so its active work can continue. Reopen Workjet to reconnect. **Disconnect** stops the SSH server managed by this Desktop profile; it does not stop a server owned by another Workjet profile on the same computer.

For an already running Workjet host, use **Already running Workjet? → Use a pairing link** in the same add dialog. Installation and repair tools remain under **Advanced setup and repair**.

## Adding a project

The folder dialog shows progress while Workjet connects to the selected Business OS, registers the folder, and waits for the confirmed project. If confirmation fails, the dialog shows an error and allows another attempt.

Choosing a project in the sidebar opens that project's workspace. The project name, new-thread composer, and working directory follow the selection. Existing conversations and drafts in other projects remain saved. If a project has no working copy on the chosen computer, Workjet opens its project page so you can choose a computer.

## macOS sign-in

Workjet accesses saved credentials without opening a macOS Keychain password dialog. Already authorized credentials remain usable. If macOS denies access, the existing encrypted credentials are retained; Workjet cannot recover them by requesting your Keychain password. The app does not switch to plaintext storage or change Keychain permissions.
