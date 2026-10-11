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

For a remote request carrying the autonomous-worktree policy reference, the
receiver now allocates a checkout with private Git metadata. It saves an immutable
server-derived intent and a destination reservation in SQLite, prepares a sibling
staging directory, and seeds only the requested commit and its reachable history.
It copies no source refs, configuration, object alternates or hardlinks. Git
preparation ignores inherited Git redirections, global/system configuration,
templates, hooks and filesystem monitors.

The receiver persists the staging directory and private Git metadata identities
before native exclusive publication. On retry it verifies those original
identities at either the staging or destination path, together with the unchanged
HEAD, worker branch and clean checkout. A lost publication acknowledgement creates
no second checkout. Foreign, replaced or missing directories are rejected and
retained. Rejected-start rollback receives the same original custody; accepted
create/turn receipts still reconcile without a second worker. Requests without
the policy retain the existing linked-worktree path.

Local delegation uses the same private-repository allocator. The source-server
broker derives the repository from the saved project, checks the current remote,
requires a clean tracked/untracked checkout and resolves the parent's exact commit.
Ignored dependency and cache files are not copied. It chooses the destination through
server worktree storage and hashes the saved project/team policy, parent, signed task
digest, model selection, capabilities and runtime modes into the immutable allocation
intent. This digest detects substitutions; it does not grant native execution authority.
A missing allocator or unavailable original rollback capture fails before thread
creation. Policy-free local workers retain the existing linked-worktree path.

This allocation and custody receipt is a prerequisite, not a sandbox witness,
an enrolled native Parent or an enabled provider policy. Every autonomous-worktree
provider mode remains unsupported; whole execution containment, native authority
and installed GPU acceptance are still required.

## Private worker model IPC

The target source setup requests a private model socket when a remote request
carries an execution-policy reference. Policy-free requests keep their existing
TCP loopback transport. On Linux, the extra endpoint uses the same request handler,
pinned model, API key and fresh source admission as loopback. It is not a second
account route or a native execution permit.

The socket is private to the service UID and is reached through the original
directory descriptor under /proc. A namespace launcher can mount only this
endpoint without exposing the host network. Original directory/socket identities
are captured from the filesystem. Rename or replacement of the directory does
not redirect the listener or make shutdown recursively remove replacement data.
Revocation aborts requests and closes both endpoints.

No provider is switched to this endpoint yet: the namespace-side bridge, complete
CLI/file/MCP enforcement and native team admission remain required before an
autonomous-worktree mode can be supported. Non-Linux hosts reject private IPC
explicitly. This transport component is not installed G2 acceptance.


## Model bridge inside the worker network namespace

The native helper's `--worker-model-bridge` command binds a loopback endpoint
inside an already created Linux network namespace, forwards bytes to the
captured Unix model socket, and supervises one CLI child. It rejects the original
service network namespace and a changed, non-private or foreign socket before
starting the CLI. HTTP headers and streaming bytes pass through without protocol
translation or account selection. At most two connections and bounded relay
buffers are retained. The bridge closes with its child and preserves its exit code.

Private native profiles use the namespace loopback address; profiles without
private IPC retain the host endpoint. The namespace launcher must mount the
captured socket at the fixed private path and pass the captured parent network
identity. The bridge is not that launcher, an Owner/team permit or a filesystem/
MCP boundary. Drivers still reject autonomous-worktree; no support or installed
G2 acceptance is claimed from this component alone.
