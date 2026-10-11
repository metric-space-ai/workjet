# Desktop instance key recovery

The main process treats an unreadable CTOX secret registry as a recovery case even
when the local session and connection catalog remain readable. It persists a
recovery generation before renaming `ctox/secrets.json` to
`secrets.json.recovery-<generation>.bak`. Public pairing IDs stay in
`ctox/instances.json`; a matching backup preserves the prior bindings. Recovery
never removes either backup or user history.

For a CTOX-only failure, the account partition and Clerk tokens remain in place.
The existing account refresh (including device-key recovery) verifies the session.
A ready discovery automatically invokes the same managed reconnect path as login:
resolve the instance partition, then exchange a new launch token/config. There is
no login window or confirmation. The new local device proof keys are persisted by
the registry with the current safeStorage key when the guest enrolls them. Managed
launch configs remain transient in the main process, as before.

Refresh IPC and cold project control both trigger recovery. Only enabled,
available `managed:*` instances from authenticated discovery are admitted. A
persisted claim permits one reconnect per generation, across concurrent calls and
restarts. Each instance has a 30-second deadline; the worker pool permits two
starts per second and at most two exchanges in flight. Failure of one instance
does not stop the others. A restart records interrupted attempts as failed and
never reissues them. Normal launches of a failed repair are blocked before any
network request, so periodic refresh cannot turn it into a retry storm.

A signed-out or failed discovery does not claim the repair generation. The marker
remains `pendingLogin: true`, and a later authenticated refresh can run the repair.
An authentication success clears pendingLogin independently of individual repair
failures. Accountless pairings remain visible with `status: "pairing_expired"` and
require explicit pairing; they are not automatically granted new credentials.
Their original IDs can be retained by the existing replacement pairing path.

## IPC contract for the UI owners

`CTOX_REFRESH_CHANNEL` continues to return `CtoxDiscoveryResult`. Its optional
`keyRecovery` field retains `pendingLogin` and `connectionCatalogReset`, and adds:

```ts
{
  generation?: string;
  repairingInstanceIds?: readonly string[];
  repairedInstanceIds?: readonly string[];
  instanceIssues?: readonly {
    instanceId: string;
    reason: "repair_failed" | "login_required" | "pairing_required";
  }[];
}
```

The fields are optional for compatibility with older backends. `pendingLogin`
identifies the recovery/login state, including when managed discovery is signed
out and remembered managed descriptors appear offline. `instanceIssues` names the
specific instances and the fixed reason. A failed launch is still returned through
the existing launch/project-control failure contract; inspect this recovery state
for the repair-specific reason. Successful IDs have no issue. Disabled/removed
instances are excluded from automatic reconnect, preserving the user's choice.
No renderer component changes are part of this backend PR.

Each admitted instance emits `ctox.keyRecovery.instance` with generation and
instance ID, and start/result log entries. Logs never contain credentials, packed
launch URLs, encrypted payloads, or exception text.

Verification uses fake-safeStorage key changes, disposable directories, mocked
account/session transport and WebContents. It does not start Electron, a Workjet
server, or the installed application, and never touches the OS keychain.
