# Native project supervisor worker dispatch

A native project supervisor hands a worker request to Workjet through the
existing authenticated Business OS MCP connection. CTOX owns the durable intent
queue and the native supervisor execution lease. Workjet owns its existing
WorkerDispatch, remote broker, registered environment connection and worker
lifecycle. The queue does not create another executor.

## Source service

NativeSupervisorWorkerDispatchLive runs one server-lifetime loop, parked until
server activation. It derives active project supervisors from the current
orchestration projection and their current reachable Business OS bindings.
Several projects on one native connection share one bounded poll.

The managed source uses business_os.workjet_worker_dispatch with contract
ctox.workjet.worker-dispatch.v1:

- register_source sends source_environment_id, source_supervisor_thread_id and
  project_id. The receipt binds an active registration, native owner, instance,
  authority epoch and revision. The supervisor is the actual native CodeThread
  UUID already bound to that project.
- poll sends source_environment_id and returns at most one pending intent.
- complete sends registration_id, revision, intent_id and the typed result.
  Its acknowledgement must match the exact registration, revision and intent.

The source never automatically supplies expected_revision. An ordinary retry
cannot replace a binding or reactivate a tombstone. Native policy and the current
owner-authenticated connection remain authoritative for each operation.

## Stable worker identity

The native intent UUID is the first worker and remote request UUID. Only the
internal dispatchNativeIntent entrypoint can introduce it; the public MCP
remoteRequestId remains a retry of an already saved request.

After polling, the source rereads the actual local supervisor, project and
binding. It rereads those facts again immediately before calling WorkerDispatch.
Task, title and optional computer/profile hints come from the intent; invocation
authority, parent, provider instance and capability grants come from the current
server projection.

WorkerDispatch retains its normal repository, current computer/profile,
capability and native admission checks. It creates no source checkout for a
remote worker. The target receives the saved request through the existing
registered connection, creates its owned branch/worktree and starts its first
normal provider turn.

## Reconciliation

A source restart or lost completion acknowledgement retries the same native
intent and saved remote request. A pending request is never terminal-completed.
If a target may already be executing but its acknowledgement is absent, later
settings errors also leave that original request pending. A recorded successful
start remains the reported result when current settings reject a retry; it does
not start another worker.

Terminal completion uses RemoteWorkerResult or one of the existing terminal
WorkerDispatch failure reasons. Native completion checks the exact parent,
worker ID, selected computer and typed model/capability data. It rejects changed
replays.

The worker remains in its source project's One-Shot Worker group while active.
Its single verified PR submission stops the target execution, publishes the PR
link at the source parent, archives the worker and retires its source authority.
The PR remains available for the parent to review and merge. Launch completion
above is distinct from this later submitted-PR receipt.

## Evidence

Domain, authenticated source-client and live reconciliation tests cover awaited
parent changes, exact source/revision/ACK checks, current connections, pending
and lost acknowledgements, and retained terminal receipts. WorkerDispatch tests
exercise trusted first use, source reconstruction and refused local placement.

Source tests do not establish installed A0. Installed acceptance must bind the
Workjet and native revisions, use the real gpu3 environment, retain the same
run/thread/request identities across an ordinary full Quit/Reopen, and record
the actual PR and terminal archived thread.
