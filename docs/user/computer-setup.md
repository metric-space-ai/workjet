# Set up computers

Open **Settings → Computers**. Choose **Use this computer** to use the local machine, or **Connect over SSH** to enter another computer's address, username, and port. Workjet requests a password when the SSH connection requires one. **Connect over Tailscale** accepts a tailnet IP or hostname and uses SSH over that connection; the remote computer must be online and accept SSH.

After connecting, Workjet checks the installed coding tools and adds the computer to the list. Select a computer there to use it for the next session. Its connection type comes from the actual connection. Editing its name does not change how it connects.

Existing connections can be added with **Add existing connection**. Backend installation and repair tools are under **Install or repair backend software**.

## Adding a project

The folder dialog shows progress while Workjet connects to the selected Business OS, registers the folder, and waits for the confirmed project. If confirmation fails, the dialog shows an error and allows another attempt.

Choosing a project in the sidebar opens that project's workspace. The project name, new-thread composer, and working directory follow the selection. Existing conversations and drafts in other projects remain saved. If a project has no working copy on the chosen computer, Workjet opens its project page so you can choose a computer.

## macOS sign-in

Workjet accesses saved credentials without opening a macOS Keychain password dialog. Already authorized credentials remain usable. If macOS denies access, the existing encrypted credentials are retained; Workjet cannot recover them by requesting your Keychain password. The app does not switch to plaintext storage or change Keychain permissions.
