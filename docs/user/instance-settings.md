# Instance settings

In the desktop app, open **Settings → Instances** to add, select or remove a CTOX instance connection.
The page lists your instances and offers shortcuts to their settings.

Use the instance picker in the app header to choose the active instance, including
while Settings is open. The settings sidebar names the selected instance when
several instances are available. Models, Harnesses, Computers and Worker belong
to that selection.
Switching the instance updates this context in Code and Business OS.

With one selected instance, the sidebar stays compact and omits the extra context
heading. Select an instance before opening its settings.

In a browser, settings apply to the Workjet host you are connected to.

Device connections are available under **Connected devices** on the instance page.
Expand that section to connect a Workjet device or review its existing connections.

Each row has an **Enabled** switch. Turning it off stops Workjet connections, guests, synchronization and instance probes while keeping the pairing and local project data. The setting survives a restart. Turn it on to reconnect with the existing pairing. Select another instance before disabling the selected one; **Selected** describes the current selection, separately from the switch.

Use the trash icon to remove a connection from this Workjet. Confirm inline on the settings page. This does not delete the CTOX instance or its data, and projects, threads and worktrees stay on this computer. Their instance requests show **Instance removed**. Disabled instance requests show **Instance disabled**.

Managed instances are hidden locally and can be restored through **Add instance**. Paired instances use the existing unpairing path and can be paired again. The local instance has no trash icon; it can be disabled.

If Workjet detects that its local encryption key was lost, sign in to **ctox.dev** once from the recovery screen. Workjet preserves unreadable files, reconnects its local background service, resets the saved connection catalog, and restores enabled managed instances and their project list after sign-in. Disabled and locally removed instances stay disconnected. Project and conversation data remain in place.

Saved direct, SSH and relay connections may need to be added again. For an instance paired without a ctox.dev account, choose **Pair again** and supply fresh pairing details for the same instance. Its saved identity stays in place. Pairing again uses the same action for lost-key recovery and expired or broken connections.
