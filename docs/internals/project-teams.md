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
An activity alone does not resume the parent. Team WorkerDispatch still needs
integration with this durable path and queued parent continuation.

Git/provider contracts retain the provider's PR head evidence. Non-force worktree
removal protects dirty work and unmerged commits, but it is not merge proof.
Destructive completion requires both verified repository/head/merged-PR evidence
and serialization against new worker execution. Until that common lifecycle fence
exists, an inactive snapshot is insufficient and automatic cleanup stays pending.
Archive must follow successful cleanup rather than hide a failed cleanup.

## Implementation checkpoint

This branch is not production-ready. Initial focused tests passed (15 tests across
contracts, team invariants, learning calculation and capability context). Later
lifecycle changes, engine receipts and mailbox retries await the shared admitted
run. Real desktop/web/mobile acceptance has not run.

Remaining work includes restart-safe dispatch and parent continuation, rework,
cleanup/archive integration, and durable review/selection wiring. The review
contract and pure selection calculation are not a persisted learning service.
No deployment or end-to-end acceptance is claimed.
