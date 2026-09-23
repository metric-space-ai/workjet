# Project teams

Project team ownership extends the existing thread configuration. The provider
runtime, mailbox and event store remain the execution and persistence owners.

## Authoritative path

Clients send existing project/thread commands through the shared client runtime.
OrchestrationEngine serializes them and binds the server environment identity.
The decider calls projectTeamInvariants before emitting events; that module owns
team role, parent, uniqueness and archive/delete authorization. The projector
rebuilds the persisted state; it does not authorize commands. UI visibility and
disabled controls are presentation only.

A project.create command emits project.created and its supervisor thread.created
in one engine transaction. Command receipts prevent duplicate application.
Replay retains the supervisor identity. Creation selects the project's model
preference or application default but does not start a provider turn.

Optional v2 workjetConfig.team stores role, project/thread identity, goal,
parent, specialist domain or worker package. Manual threads retain their previous
behavior. Existing projects can explicitly create their supervisor through the
same thread.create invariant boundary; concurrent clients cannot create two.

Supervisor and specialist map to the existing orchestrator execution role.
WorkerDispatch prepares isolated worker worktrees and submits engine commands;
it is not an alternate authority for project membership. Team workers must name
a local, active specialist. Role/parent/package reassignment is rejected. A
parent cannot be archived with active children or deleted with retained children.
The supervisor remains available until explicit project deletion; unarchive
revalidates the parent.

ThreadCapabilityContext derives provider instructions from persisted ownership.
Desktop/web ProjectTeamPanel and mobile ThreadDetailScreen consume that same
configuration. The panel submits ordinary thread commands for goals and specialist
creation; it does not maintain a separate team catalog.

## Execution and cleanup boundary

WorkjetDelegationExecutor owns existing durable delegation execution and result
delivery. Local results are marked returned only after the parent activity append
succeeds; failed appends and marker writes can retry with the same command identity.
For local project-team parents, return now requests a continuation with a stable
command/message identity before acknowledging the result. Engine-serialized busy
admission defers without a rejected receipt; the existing pending-result scan
owns retries. This new continuation and its regression tests await verification.
Team WorkerDispatch writes the complete task to the snapshot store and prepares
a signed local delegation. Its internal thread.create option commits the worker
event, queued delegation and outbox in the same engine SQL transaction and receipt.
The initial delegation explicitly scopes the isolated checkout root (`.`); a
narrower file selection is not yet part of the dispatch contract.
The executor recovers local delivery and owns the sole first-turn start. Local
recovery filters address ownership before limiting results and pages by delegation
identity, so foreign or permanently invalid queues do not hide later local work.
A failed creation acknowledgement is replayed once with the same command identity.
Legacy non-team dispatch retains its existing behavior. If the creation acknowledgement
fails twice, team dispatch reads the transaction's command receipt. An accepted
receipt returns the original worker, a rejected receipt permits cleanup of that
worker's checkout and branch, and a missing or unreadable receipt retains the
checkout because ownership is still uncertain. Startup reconciliation of a
retained ambiguous checkout remains to be implemented.
Review, revise and follow-up state transitions now commit their graph edge in
the same mailbox transaction. A failed edge insert rolls back the state and its
history event. The review-request message is still enqueued separately; recovery
if that enqueue fails remains open.
An orchestrator can now submit a linked delegation after a `changes-requested`
review. The delivery service derives a `revises` edge and depth, restricts the
new task to the same worker and bounds its depth, review rounds, and expiry
by the parent. The mailbox store rechecks parent state and ownership in the
enqueue transaction. The existing executor starts the linked turn with a stable
command identity after restart. A `needs-input` or completed parent may similarly
be followed up.
Successful worker turns with a positive review-round budget now persist their
result while entering `review-requested`. The stored result is returned to the
parent with the same durable retry marker as a terminal result, and the parent
continuation can decide `changes-requested` or approve. A completed turn whose
worker requested review early is also reconciled. The reviewer must be the
delegation source and cannot approve before the turn result is stored. A rejected
result can then create the linked rework task on the same worker; the executor
starts it after restart and its result can be reviewed and approved. A budget
with zero review rounds still completes directly.
The review decision and creation of the linked delegation are separate
commands; recovery of an interrupted handoff between them remains open. The
rejected original remains in `changes-requested` while its replacement runs.
Review reasons and round verdicts are not yet persisted as learning evidence.

Git/provider contracts retain the provider's PR head evidence. Non-force worktree
removal protects dirty work and unmerged commits, but it is not merge proof.
Destructive completion requires both verified repository/head/merged-PR evidence
and serialization against new worker execution. Until that common lifecycle fence
exists, an inactive snapshot is insufficient and automatic cleanup stays pending.
Archive must follow successful cleanup rather than hide a failed cleanup.

## Implementation checkpoint

This branch is not production-ready. Exact-head CI on 74f37cd9e passed Check,
Test, Release Smoke and Mobile Native Static Analysis. Receipt reconciliation,
atomic review edges, and result-to-rework have targeted local tests; exact-head
CI and real desktop/web/mobile acceptance for these additions remain pending.

Remaining work includes full acceptance of atomic dispatch and parent continuation,
recovery of checkouts retained after unreadable receipts, review-to-rework handoff recovery,
cleanup/archive integration, and durable review/selection wiring. The review
contract and pure selection calculation are not a persisted learning service.
No deployment or end-to-end acceptance is claimed.
