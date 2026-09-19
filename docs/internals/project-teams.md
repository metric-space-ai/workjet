# Project teams

Project team ownership extends the existing thread configuration. It does not
replace the provider runtime, mailbox, event store, or worker dispatch service.

A new project and its supervisor thread are emitted by one project-create
command and persisted in the existing engine transaction. Replaying those
events preserves the supervisor ID. The supervisor starts without a provider
turn; its selected model comes from the project preference or the existing
application default. Selection is not evidence of actual execution.

Optional v2 `workjetConfig.team` stores role, project/thread identity, goal,
parent, and specialist domain or worker package. Historical/manual threads
retain their existing behavior. Serialized command invariants reject duplicate
supervisors, foreign-project parents, workers with children, and silent loss
of team ownership. Specialists use the existing orchestrator execution role;
team workers use the existing worker role and isolated worktree dispatch.

The web/desktop thread view exposes the team, parent, selected model, goal,
and specialist creation. Mobile exposes the same persisted membership. Worker
results continue through the existing mailbox/delegation machinery.

## Implementation checkpoint

This branch is not ready for production. Focused verification and real client
stories are pending. Remaining required work includes safe existing-project
adoption, all lifecycle mutation guards, authenticated environment binding,
restart-proof completion/parent continuation acceptance, merged-PR evidence
and archive integration, durable review learning and selection, and full mobile
team-management controls. The review schema alone is not a persisted learning
service. No deployment or end-to-end acceptance is claimed.

The cleanup service now uses non-force Git removal. This protects dirty work
and unmerged commits; it does not prove that a PR was merged and does not yet
replace deletion with the requested archive lifecycle.
