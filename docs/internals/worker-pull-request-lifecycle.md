# Native One-Shot Worker lifecycle

The execution computer's Workjet server owns this lifecycle. Model output and
renderer settings cannot attest a submitted PR or authorize archival.

A Supervisor or Persistent Worker commissions a leaf by its project team role.
The Luma supplies harness, model, computer and task; the legacy profile role
does not grant coordination rights. The dispatcher reserves a durable ordinal
per source parent and creates a fresh `workjet/worker/<thread-id>` branch and
isolated checkout. Its initial title is
`[WorkerN@<Parent title>]: <model>`. Parent environment, parent thread, worker
thread and project IDs remain in native metadata, including remote dispatch.

A newly started role-less project chat is prepared as a One-Shot Worker before
its first turn. Workjet uses the actual project supervisor and a pinned,
published Git base; it preserves an already recorded owned checkout on retry.
Standalone chats remain ordinary chats. Historical project chats with work in
a shared checkout require explicit migration; Workjet neither deletes nor
silently relocates their history or source.

The worker finishes its change and required checks before submitting exactly
one PR. It does not merge its own PR or wait for merge. Native tool-completion,
session and successful UI Git actions trigger bounded reconciliation immediately;
a periodic batch provides recovery after restart or a missed event.

Reconciliation resolves the repository through the native source-control
registry. Exactly one same-repository PR on the canonical branch, with the
current native Git HEAD, establishes the submission receipt. Open PRs are
terminal for worker execution, just like merged and closed PRs. Missing,
ambiguous, forked or unpublished results do not establish completion.

The first verified PR identity is retained in SQLite and projected
`workjetConfig.pullRequest`; it cannot be replaced by a second PR. The native
receipt fences new turns and unarchive requests, and the assigned branch and
checkout cannot be changed to evade that fence. The title becomes
`#<PRnumber>: <model>`.

Before archival, Workjet confirms that the provider session and thread terminals
have stopped. It publishes an idempotent clickable PR result at the local
parent, or through the already authorized remote source channel. The source
independently verifies the exact PR, branch and head before recording the result
and revoking the worker authority. A remote parent ID is never written into an
unrelated target-local thread. Only then does the native engine accept the
ordinary idempotent archive command.

Archived workers disappear from the active One-Shot Worker section; their
conversation, parent binding and PR remain available in archived history.
The project PR overview reads the repository independently of active threads.
Archival preserves the checkout and unpublished source. Verified merge cleanup
remains a separate operation.

Receipts survive restart and recover without another provider lookup or a
second confirmed process stop. A missing source route, failed acknowledgement
or unconfirmed process termination retains the worker for recovery. This is a
failure condition, never an invented successful result. A no-change package
without a PR and multiple PRs on one branch need an Owner decision.

Installed acceptance requires a real dispatched worker, its chosen computer and
model, a PR URL, automatic archive and a quit/reopen. Unit and real-stack tests
alone do not establish that acceptance.
