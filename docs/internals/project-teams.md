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
owns retries. Focused executor tests cover the continuation and retry boundary.
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
history event. A review request commits its state, `reviews` edge and signed
message together. Local delivery also commits an inbox row; an executor cycle
replays its thread activity after a failed dispatch or restart with a stable
command identity. An unprocessed local review signal is retained past message
TTL until that activity is marked processed. Remote signals use the outbox. A
dead remote review signal gets one more delivery budget while its original
envelope is unexpired and the delegation still awaits review. Its id, stored
payload, signed routing envelope and expiry remain unchanged. The transport
seals the payload when sending; retaining the id deduplicates a lost
acknowledgement and does not extend the request's lifetime. An atomic counter
prevents a second budget after restart. Transient lookup or redrive failures
leave the row for retry. An expired or twice-dead letter stays queryable and is
logged. When review is still pending, the executor appends one error activity
to the source thread
with a stable command identity; a failed activity append retries after restart.
The source must notify the reviewer again or resolve the delegation. A dedicated
freshly sealed resend action remains to be implemented.
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
commands. The executor scans source-owned `changes-requested` rows with a stored
result and no `revises` child. It dispatches a stable parent continuation after
a crash or transient refusal. If that accepted turn ends without a child, it
checks the exact persisted turn row and dispatches one further continuation
under a distinct command identity; a later parent turn becoming latest is not
used as completion proof. Replaying the first accepted receipt cannot start
another turn. A projected retry message
stops further automatic turns. The child enqueue's atomic graph edge removes
the row from the recovery set, and the store refuses a second `revises` child
for the same rejected delegation. The parent still must create a revised task
with its chosen prompt and scope, or explicitly cancel the rejected task. If
both continuations end without either action, the original stays visibly
`changes-requested`; automatic child generation is not implied.
Source-owned review decisions now persist their round and bounded reasons on
the transactional `reviews` edge. The learning service still does not record
first/final scores or drive model selection from these verdicts.

On `thread.deleted`, worker worktree removal requires a clean checkout on the
recorded worker branch and a direct provider query showing that a merged PR's
head equals local HEAD. This still works after a merged PR's remote branch is
deleted. At server start and every 15 minutes, a serialized retry checks at most
64 deleted worker checkouts from the projection and advances its cursor between
cycles. If a prior attempt removed the worktree but failed to delete its branch,
the retry checks the branch commit against a merged PR and deletes that ref only
with Git's expected-old-commit check. A branch with new unique commits stays.
Missing or mismatched merge evidence retains source. Provider session stop is
retried before removal. A durable receipt records the matching merged PR URL
and commit before checkout or branch removal and records completion afterward.
Restart reconciliation finishes an interrupted completion only when the exact
receipt and Git ref state agree. Missing, unreadable or changed Git evidence
keeps the receipt pending and retains any remaining source. Deleted threads
reject new turn commands. The engine now fences provider turn starts against
thread deletion and forced project deletion through send acknowledgement, after
asynchronous session startup. A project worker cannot be archived before its
deletion fences new turns and a completed receipt matches its recorded checkout
and branch. The deletion reactor archives after successful cleanup with a stable
command identity; startup reconciliation retries the archival step after an
interruption. A deleted, archived worker cannot be unarchived.
The archived shell snapshot includes these deleted worker records while
excluding other deleted threads. Mobile Archive displays them as completed,
read-only rows without unarchive or delete gestures. The underlying deleted
thread detail is not yet available as a read-only conversation view.

## Implementation checkpoint

This branch is not production-ready. Receipt reconciliation, atomic review
signals and edges, result-to-rework, bounded rework reminders, guarded cleanup,
and one bounded remote review-signal redrive have focused local tests. The
previous `fcf32e3bf` CI head passed Check, Test, Release Smoke and Mobile Native
Static Analysis; the new head still requires exact-head CI. Android preview
APK and real desktop/web/mobile acceptance remain pending.

Remaining work includes full acceptance of atomic dispatch and parent continuation,
recovery of checkouts retained after unreadable receipts, explicit handling when
both parent rework continuations end without a linked child,
a dedicated fresh remote review-signal resend action, and durable review/selection
wiring. The review
contract and pure selection calculation are not a persisted learning service.
No deployment or end-to-end acceptance is claimed.
