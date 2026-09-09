# Add a computer to a Business OS

Select the Business OS you want to work in, then open **Settings → Computers**.

1. Choose **Add computer → SSH** or **Add computer → Tailscale** to connect a remote computer. Existing saved computers remain in the list.
2. On that computer's row, choose **Add to Business OS**. Workjet waits for the selected Business OS to confirm the assignment.
3. When the row shows **Available in the selected Business OS**, the computer is included in that instance's coding targets. It still needs a working connection and an available coding tool to run tasks.

A connected computer and a computer assigned to your Business OS are different states. Connecting alone does not assign a remote machine to every instance.

**Remove from Business OS** removes the assignment from the selected instance. **Disconnect** stops the connection while retaining the saved connection settings. These actions do not delete your project files.

If confirmation fails, the error stays visible. Use **Refresh assignments** to check whether a slow request completed before retrying. Workjet also refreshes the inventory when you return to the app. Switching Business OS discards the previous instance's inventory immediately.

This workflow requires a Workjet host and Business OS that support computer assignments. A host without that support displays an update message; it does not claim that assignment succeeded.
