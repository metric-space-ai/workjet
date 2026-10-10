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
Changed, removed or newly added policy references reject a retry of an older
remote request. Reconciliation of an already recorded native result starts no
new worker. The source reports invalid references as `execution-policy-invalid`;
the existing native completion contract uses `capability-escalation`.
The request digest includes the reference; an older
receiver stripping the field cannot claim the same source request identity.
No policy is accepted from the worker-dispatch MCP input. These checks preserve
the policy at the provider boundary; they do not verify native current policy
or supply a sandbox permit.

The source copies the same reference into
`RemoteWorkerNativeBinding.executionPolicy`. Native issue, claim, revalidation
and renewal receive that immutable reference. The client rejects a missing,
added, foreign-project or changed reference before resolving account grants
or contacting native, and rejects a native receipt that omits or substitutes
it. The persisted intent and receipt retain the reference across recovery;
revocation still uses the original binding after an account grant is removed.
An older native that rejects the new optional binding cannot admit this mode.
The native producer must additionally verify current Owner policy/revision and
actual enrolled team provenance at every usage. Echoing the reference alone
does not supply that authority, a sandbox witness or a supported policy mode.

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

## Isolated Git metadata custody

An executor confined to its workspace cannot use a linked worktree's shared
Git administration directory outside that workspace. The native helper now
supports publication and rejected-start quarantine of a prepared checkout
whose own `.git` directory is inside it. Publication requires the captured
directory and Git metadata identities, stays beside the prepared checkout,
and never replaces an existing destination, including an empty directory.
Symlink ancestors, replaced identities, `commondir`, and object alternates
are rejected. The caller must persist the capture before publication and
verify that same capture on recovery; a path alone does not prove custody.

The default linked-worktree capture and automatic removal are unchanged:
they never adopt a standalone/manual repository. Isolated captures require
an explicit kind and cannot use automatic recursive removal. On a rejected
start, the rollback API can receive the original persisted custody; it
quarantines checkout and private Git metadata together, records recovery
locations, retains late writes, and never deletes a ref from the source
project. A failed native response reports candidate recovery paths only.

This is a prerequisite for isolated allocation and its durable receipt, not
a sandbox witness or an enabled provider policy. Remote allocation still uses
the existing linked-worktree path until that integration is complete. Every
autonomous-worktree provider mode remains unsupported.
