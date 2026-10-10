# Autonomous worktree provider admission

The optional `WorkjetThreadConfig` v2 field is:

```ts
executionPolicy: {
  mode: "autonomous-worktree",
  projectId: ProjectId,
  revision: number, // revision of the Owner's project policy
}
```

Absence preserves existing behavior. This is a policy reference, not a permit,
a path grant, an approval bypass or a source of computer/account identity.
The Owner project setting and its propagation are owned by Main.

The dispatcher copies this reference from the server's saved parent into local
worker configuration and the immutable `RemoteWorkerRequest.executionPolicy`.
It accepts a reference only for that parent's project and saved team membership.
The remote receiver preserves it in the target worker configuration, and rejects
a foreign project or missing team role before storing a request or touching Git.
Changed, removed or newly added policy references cannot reconcile an older
remote request. The existing request digest includes the reference; an older
receiver stripping the field cannot claim the same source request identity.
No policy is accepted from the worker-dispatch MCP input. These checks preserve
the policy at the provider boundary; they do not verify native current policy
or supply a sandbox permit.

The common provider boundary currently **rejects this mode for every harness**.
No supported autonomous-worktree policy mode is advertised. In particular,
`full-access`, Codex's `workspace-write`, Claude's `acceptEdits`, and a
`supportsSandboxMode` flag do not demonstrate the required boundary.

The check runs before MCP credentials and a new provider session, before
recovery/adoption, and before routing turns from a saved binding. A damaged or
future config retaining an execution policy is also rejected instead of being
decoded into unrestricted legacy defaults. Interrupt and stop remain available.

A supporting consumer must verify the current Owner project revision, active
server-side team membership, registered executor host, and actual canonical
Git worktree at every admission and recovery. Its enforcement must cover file
tools and command descendants (including symlinks and absolute paths), isolate
host secrets and inherited credentials, and hold outside-scope requests for
explicit escalation. The three team roles do not change. Source/native
authority, a model proxy capability and a sandbox witness are distinct facts.

Claude SDK 0.3.170 exposes mandatory Bash sandboxing with
`enabled: true`, `failIfUnavailable: true` and
`allowUnsandboxedCommands: false`. That API alone does not prove the remaining
properties. The pinned declarations were inspected; no support is inferred
from the newer upstream CLI documentation.
The [official sandbox documentation](https://code.claude.com/docs/en/sandboxing)
also distinguishes command isolation from permissions and the default read
access to credential directories.

Installed G2 acceptance remains open. This change prevents a premature project
setting from silently turning into host-wide access; it does not claim that an
autonomous worker has been accepted.
