# Connect a Tailscale computer

In Computer hinzufügen, choose Tailscale to see computers reported by Tailscale on this device. Online computers have a Use computer action that fills their Tailscale address. Enter the remote computer's SSH username, then choose Connect computer. Online status alone does not establish SSH access or installed worker tools.

Offline computers are omitted from the suggestions. Refresh checks the current list again. If discovery is unavailable, start Tailscale and sign in on this device, then refresh. You can also enter a Tailscale address manually.

Tailscale suggestions are available in the desktop app. On macOS, when the Tailscale app is stopped but a separate Tailscale service is running, discovery uses that running service. It does not change your Tailscale account or connection settings. Suggestions never use saved SSH aliases or known-host entries. The SSH tab continues to offer those entries.
