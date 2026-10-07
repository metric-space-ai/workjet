# Native worker pull-request lifecycle

The execution computer's Workjet server owns this lifecycle. The renderer and
model may show a PR link, but neither can attest a merge or closure.

The worker dispatcher creates a distinct thread and isolated
`workjet/worker/<thread-id>` branch. A server-lifetime reconciler scans active
project workers in bounded batches after runtime activation. It resolves the
repository through the existing native source-control registry and asks for all
PR states on that branch. Exactly one same-repository PR with the current native
Git HEAD is eligible. Missing, ambiguous, forked, foreign or unpublished heads
remain active.

The first observed PR identity is retained in the native SQLite store and in
the worker's projected `workjetConfig.pullRequest`. Replacement settings retain
that identity; a second PR cannot replace it. This projection is display metadata,
not completion authority.

A provider-confirmed merged or closed state is terminal for the run. The
serialized command engine reads the private native receipt before accepting
another turn or unarchiving the thread. It denies both once the PR is terminal.
The reconciler stops the actual provider session and thread terminals, records
that native result, then submits the ordinary idempotent `thread.archive`
command. The engine checks the exact thread, checkout, branch and projected PR
before accepting that archive. A forged renderer config has no native receipt.

The archive retains conversation history and the checkout. In particular a
closed PR, dirty worktree or unpublished source is never deleted as an incidental
archive step. Existing verified merge-cleanup receipts continue to authorize
their existing delete/cleanup/archive path independently.

Receipts survive server restart. Reconciliation is scoped to the server runtime,
parks before startup activation, uses one cycle mutex and bounded native calls,
and stops with that runtime. A failed provider lookup or unconfirmed process
termination retains the active worker for retry.

This slice supplies native PR binding, terminal execution fencing and archive.
Registry-based remote source placement/admission and fresh leaf launch on GPU3
remain separate connections. Architecture's guest enrollment is local operator
provisioning; it does not create a worktree or grant remote launch. A fresh leaf
needs no session-handoff checkpoint. Product acceptance still requires a real
GPU3 run with run ID, PR URL and archived thread, after Add computer acceptance.
