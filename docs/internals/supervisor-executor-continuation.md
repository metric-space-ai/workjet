# Native Supervisor and claimed Crew executor continuation

Status: proposed contract. No installed mutation capability or successful executor
continuation is claimed. Main owns the Workjet consumer; Crew owns native admission,
claim generations and control handlers. The Composer owner keeps the existing
send/input behavior from #284.

## Existing operations and gap

`project.supervisor.route.capabilities.v1` and
`project.supervisor.route.read.v1` are read-only. Their native commands are
`ctox.workjet.project.supervisor.route.capabilities.v1` and
`ctox.workjet.project.supervisor.route.read.v1`. The display receipt distinguishes
configured route facts from actual execution; its current `actual` producer is null.

`project.configure` can save a `supervisorLumaId`. This is configuration, not an
executor-switch receipt, history-import receipt or permission to replace a running
claim. The native execution lease rejects a changed requested route within the same
lease. Workjet's `runClaimedCrewTurn` binds the provider conversation to the admitted
attempt, harness and executor. An arbitrary local selection must not rewrite those
identities.

Crew verified the current supported native configuration path: `project.upsert`
uses `supervisor_luma_id` with omission to retain the selection, null to use the
instance default, or an exact stored Luma ID to select it. A later
`project.supervisor.turn.submit` creates a new native attempt in the same bound
thread. These operations configure a future attempt; they do not replace an
already claimed executor, move its resume identity, or issue a continuation CAS
receipt. The original admitted controller remains immutable. Keep configuration
and actual execution facts separate in the UI. This clarification is based on
Crew's native contract review, not installed executor-switch acceptance.

Ordinary thread continuation (#322) and connected-environment transcript transfer
(#324) do not establish native Supervisor or claimed Crew support.

## Proposed additive native contract

Proposed contract ID: `ctox.workjet.executor-continuation.v1`. The operation names
below require agreement with Crew and canonical fixture generation before becoming
executable. They are not current capabilities.

| Project-control action | Native command | Purpose |
| --- | --- | --- |
| `thread.executor.continuation.capabilities.v1` | `ctox.workjet.thread.executor.continuation.capabilities.v1` | Read supported transitions and a current native CAS snapshot |
| `thread.executor.continuation.request.v1` | `ctox.workjet.thread.executor.continuation.request.v1` | Record an Owner-selected future executor change |
| `thread.executor.continuation.read.v1` | `ctox.workjet.thread.executor.continuation.read.v1` | Reconcile the same durable request after disconnect/reopen |

The mutation request contains only:

- `commandId`: stable operation identity; retries reuse the same intent.
- `projectId`, `threadId`: the existing native project and conversation.
- `expectedRouteDigest`: SHA-256 of the current snapshot, issued by the native
  capabilities/read operation. It includes the selected Luma, configuration revision,
  registered-computer binding and account/catalog revision. The UI cannot issue it.
- `expectedAttemptId`: current native attempt identity, or null if none exists.
- `targetLumaId`: an existing Luma from the selected instance's configuration.
- `boundary`: `next_turn`; no implicit interruption of an executing tool.

No caller harness, model, computer, resume identity, transcript replacement,
credential, grant or approval is accepted. Native policy resolves the target Luma's
real harness, registered computer and live account model. Unknown or unavailable
bindings fail visibly. No default model or alternate computer is substituted.

## Receipt and state machine

A correlated public receipt identifies the operation, project, unchanged thread,
previous attempt/generation, target Luma and the requested route digest. Its state is
`pending`, `applied`, `rejected` or `unsupported`. A pending receipt also identifies
why the safe boundary has not been reached. Unsupported is not success.

Only an `applied` receipt contains the new native generation and the new attempt
identity. The authoritative executor claim and credentials remain private. The
receipt separates requested configuration from verified actual execution facts.
It cannot assert history import, compaction or first-turn success before the
registered target reports those steps through native verification.

The native owner rechecks project authority, the expected snapshot/attempt and
current target eligibility at the safe boundary. It fences the old executor,
creates a new immutable generation, imports the retained canonical conversation
through the Harness adapter, compacts it, and starts the new attempt. The thread ID,
goal, schedules, commissioned workers and original full history remain unchanged.
Existing approval grants are not copied into the new claim. Each durable stage is
recoverable; no cross-database atomicity is implied.

Repeated identical operations return their retained state. Changed payload under
the same `commandId` is an idempotency conflict. A stale snapshot/attempt is a
conflict requiring a fresh read, never automatic retargeting. Scope changes discard
late UI responses without erasing an already committed native request.

## Workjet consumer and acceptance

Negotiate the separate capability through the existing authorized project-control
WebRTC path. Old hosts retain today's behavior. A host without this capability
keeps route chips display-only and offers the existing project Luma settings.
Do not alter #284 input/send guards or treat configuration save as continuation.

Crew must generate the canonical native/browser wire fixture and land the handler;
Main then mirrors that exact fixture in Workjet's typed transport, validates receipt
scope/CAS identities and exposes the operation to Composer. No mutation is sent
before installed capability negotiation succeeds.

Acceptance requires a real Supervisor and a real claimed Crew conversation: change
executor at a safe boundary, observe a genuinely new native generation, retain
history/goal and commissioned work, receive the first real model answer, then
ordinary Quit/reopen with the same new attempt. Also test stale CAS, replay,
revoked target and denied Owner on an isolated tenant. Source tests or a configured
route alone do not establish installed acceptance.
