# Dev and Ops integration

Implementation of the approved 2026-09-09 Workjet Dev/Ops concept. This is an
integration ledger, not a declaration that the migration is complete.

## Ownership

- Workjet owns its threads, provider sessions, Collective mailboxes and UI.
- CTOX owns its native execution, durable Crew identity/memory, policy and
  reviewed learning. An external harness uses the same Crew through scoped
  platform operations; it does not create a second identity store.
- Instance, project, execution computer and harness are separate identities.
  A thread keeps its original binding when the global selection changes.
- General development remains usable without an attached Business OS app.
- The existing persisted mode values `code` and `ctox` remain wire-compatible;
  their user-facing names are Dev and Ops.

## Required outcomes

| Outcome                                    | Implementation                                                                                                                      | Required acceptance evidence                                                                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared instance/project/Crew/run contracts | Existing active scope and CTOX session fence identified; external Crew/run contract pending                                         | Binding survives disconnect/restart; stale instance cannot claim or redirect work                                                                                |
| Shared application frame                   | In progress: common header, Dev/Ops labels, surface header portals, Ops instance sidebar removed, connection management in Settings | Real desktop/web interaction, resizing, keyboard navigation, settings, switching and reload; independent UI review                                               |
| Native CTOX harness                        | Pending                                                                                                                             | One Dev submission creates one real task in the selected instance; same task appears in Ops; transport retry cannot duplicate it; closing Dev does not cancel it |
| Cross-harness Crew context                 | Pending                                                                                                                             | Native CTOX and Codex/Claude use the same member and authorized memory; resume/compaction restoration and reviewed learning writeback                            |
| Remaining harnesses and configuration      | Pending                                                                                                                             | Adapter capability matrix, persona migration, shared provider catalog and versioned MCP skill package                                                            |
| Complete desktop/web user journeys         | Pending                                                                                                                             | Project → app → automation → result; Ops users need no harness setup; free development continues to work                                                         |

## Existing foundations to preserve

`activeWorkjetScope.ts` already provides a shared selection with monotonic
revisions. `workjetSessionBinding.ts` registers a CTOX project session and keeps
its fence epoch. Collective already coordinates external harnesses through
managed prompts, MCP and durable mailboxes. The new Crew integration must
extend these mechanisms rather than introduce competing routing or memory.

The inspected CTOX turn path builds its dynamic snapshot per outer turn and
only injects changed developer instructions. Persona/session setup, runtime
snapshot refresh, harness compaction and post-attempt learning are distinct
lifecycles. A shared context contract must account for all four.

## Header implementation

`WorkjetHeaderFrame` remains outside the Dev/Ops surface switch. It contains
the single active-instance selector, mode switch, context slot and Settings.
`WorkjetHeaderContent` portals existing surface controls into the slot while
retaining their original React state and event ownership. Outside the shared
frame a surface renders its original header, preserving standalone consumers.

Ops does not mount the instance sidebar. Existing connection setup, login,
removal and refresh actions remain reachable in Business OS settings under
“Instanzverbindungen verwalten”. Dev and Settings retain their own navigation.
The native guest bounds follow the remaining content rectangle below the
shared header.

Below 1100 CSS pixels, the frame moves the surface context slot to a 44px
second row. Instance/mode navigation remains in the native titlebar, including
the macOS traffic-light inset. The sidebar uses the complete frame-header
height, while the surface toolbar uses its own context-row height. The native
guest host's existing ResizeObserver reports the resulting content rectangle.
Standalone headers retain their original geometry. Real narrow-window, zoom,
native guest and keyboard acceptance remains required; parsing CSS is not a
layout pass. Browser Ops transport is still pending and is not enabled merely
by adding this shared geometry.

On 2026-09-09, CI run 34338491522 passed Check, Test, Release Smoke and Mobile
Native Static Analysis for head fd9546eb66b0615f285e3192150f72796bcc770a.
The desktop artifact run 34338491659 also passed. It packaged PR merge commit
6160a63244efd7d261ee79ec534937e7deb06893; it is not proof of later CSS changes
or of the full Dev/Ops UI story. Artifact id 10099681125 was available, but
no preview was installed or launched by this task. The previously reported
scope-guard/type errors and the closed-session observer race have been fixed
on this head. Native driver registration, shared Crew and end-to-end UI
acceptance remain incomplete.

## Verification and resource status

Initial source base: Workjet `e2d1acd6d` (origin/main fetched 2026-09-09).
CTOX main was fetched read-only; no canonical working copy was reset or edited.

- Focused header ownership tests added; existing layout and label tests updated.
- Changed TSX/CSS files passed the formatter's syntax parsing.
- `git diff --check` passed before the initial draft.
- Typecheck, test execution, browser/Electron stories and independent review
  are outstanding. The host admission status reported less than 20 GiB free
  on `/Volumes/tmp` and more than 8 GiB swap, preventing heavy verification.
- Existing dependencies may be reused for formatting only. The canonical
  checkout's lockfile differs from this worktree, so it is not a verified
  dependency installation for builds or acceptance tests.

No release/deployment or merge is implied by this draft. Each pending outcome
must be implemented and proved before the overall goal is complete.

## Shared CTOX MCP transport

`workjet/ctox/CtoxMcpTransport.ts` now owns the authenticated, bounded JSON-RPC
transport previously embedded in Decision Hub. Decision Hub retains its typed
inputs/results and its required-tool probe. Other Business OS adapters can
probe their own required tools without falsely requiring Decision Hub support.
Managed `/mcp/<instance-id>` endpoints are preserved instead of appending a
second `/mcp`. Calls are never automatically retried.

The typed Business OS capability uses this transport and the existing connection
registry. Crew context is still pending. The existing cross-mode client also
has an outbound transport; its authority checks and typed rejection semantics
must survive consolidation. No raw RPC entry point is exposed to a
harness by this change.

Transport tests cover managed routing, peer/tool discovery, bounded responses,
no write retry, tool denials and Decision Hub compatibility. Local execution
was rejected by the shared resource gate before the runner started.

## Durable connection identity

Migration 59 pins every existing connection id to its stored CTOX instance.
New registrations claim that binding before writing credentials; simultaneous
claims for different instances cannot both succeed. Disconnect removes the
credential and visible connection while retaining its identity binding, so
reconnecting cannot redirect existing thread references to a different instance.
Credential rotation for the same instance remains supported.

Target resolution checks the durable binding and accepts an expected instance
from a run. Managed endpoint paths are checked against the instance both during
provisioning and when resolving stored credentials. This pins configured
routing; it is not cryptographic attestation of a self-hosted daemon. Native
authority verification and the external run contract remain required.

Focused tests cover migration, credential preservation on rejection, reconnect,
registry reconstruction, explicit target mismatch and competing registrations.

## Business OS capability for external harnesses

The shared catalog exposes `ctox-business-os` alongside the existing tools.
Its typed `ctox_business_os` operation supports app/skill discovery, source
reading/writing, validation and smoke/E2E checks, delegated app work, command/run
status and deep links. Endpoint, token and actor overrides are not input fields.
The existing connection RPC/store is reused; connection readiness checks the
CTOX MCP surface while tool discovery checks each requested operation.

The composer binds the connection and instance together. New selections follow
the header instance; existing bindings remain visible when the global selection
changes. The command decider retains the original binding even when tools are
disabled and rejects retargeting. The provider start/recovery path validates
reachability and instance identity, compiles the shared app instructions and
issues the binding inside the server-side MCP credential scope. Each call
rechecks its grant and resolves the pinned target without passing the CTOX token
to the external harness. The production MCP layer explicitly receives the same
connection registry as the provider and connection-management RPC surfaces.

This source integration is not yet runtime-verified. Native harness dispatch,
Crew/memory/learning, adapter lifecycle conformance and desktop/web acceptance
remain open. Added tests drive the registered MCP tool through a fake daemon.

## Native request persistence and recovery

Workjet requires a retry key for native create/modify/general-task delegation. Migration 60
records that intent before the first
remote write, scoped to its Workjet thread, connection and CTOX instance. The
claim allocates a separate server-owned native retry key once; identical client
keys in different threads cannot merge their native tasks. Replays reuse the
key from the winning persisted claim, including after service reconstruction.
The actual MCP handler uses this store and records returned command/task ids. A
lost response leaves an explicitly unresolved request, not an invented failure
or completion. `get_delegation` recovers the original typed request and known
references without contacting CTOX; live execution status still comes from the
native command/run tools. This is also the persistence boundary for the planned
native harness adapter, whose menu/session/event integration remains pending.

`delegate_task` accepts a module, title, objective and optional record. The
server fixes the remote action to `ctox.delegate_task`, verifies the native
`execute_action` retry contract and uses the same durable request ledger as app
delegation. Model arguments cannot select another action, target or actor.
Receipt validation checks the native command kind before attaching its ids;
an app-command receipt cannot be substituted for a general task. This is the
shared dispatch prerequisite, not an independent CTOX runtime or a completed
provider adapter.

The command reactor now forwards the persisted command/event identity as
`ProviderSendTurnInput.requestId`. This identity survives provider-service
session recovery; it is optional for existing direct callers and does not
claim that external vendor harnesses support idempotent execution.
`CtoxNativeTaskClient` centralizes native dispatch and is used by the registered
MCP tool. Its `submitTurn` path derives the local retry key from the persisted
intent identity, then uses the existing request ledger's separate native key.
After an accepted response is lost, reconstructing the client and submitting
the same turn recovers the original task; changed intent is rejected and a
distinct command remains distinct even when its text is identical. The client
owns no daemon, cancellation or background polling. Provider menu/session/event
wiring is still required to expose it as the native CTOX harness.

Added verification covers the real reactor's forwarded command id, provider
session recovery retaining that id, and a database-backed client reconstruction
with a fake native peer that accepts a request before losing its response.
Existing registered-tool tests exercise the shared dispatch path. These tests
remain subject to CI; syntax/formatting alone is not behavioral verification.

`get_delegation_status` observes the native command belonging to a stored
request key. It reads the real `BusinessOsMcpRecordResponse` shape and validates
its collection, command id, task id and any module identity before exposing a
normalized status. The remote queue's task_status takes precedence over a
compatibility command status. Blocked/dependency/retry waits stay waiting;
unknown future states never imply completion. An unresolved local request with
no command receipt returns `unresolved` without contacting or resubmitting to
CTOX. Remote progress is not written into the local identity ledger. The native
adapter can use the same client method for observation without creating a
second status source. Tests exercise this through the registered MCP tool and
reject mismatched or incomplete identifiers.

Workjet negotiates the selected native tool's retry-key schema before dispatch.
CTOX PR #84 supplies the corresponding actor/workspace-scoped atomic claim.
Local claims cannot change intent or instance, and stored native task references
cannot be replaced by later conflicting responses. Until CTOX exposes a durable
authenticated-principal identity, retries also retain a digest of the exact
endpoint and credential: rotating a token may change the remote actor and must
not silently select a different idempotency scope. Tokens are never persisted in
the request store or returned by the recovery tool.

Focused tests cover service reconstruction, pre-send intent, lost responses,
concurrent conflicting claims, credential/instance changes, task-reference
immutability and thread isolation. These new tests are not yet executed locally;
tmp capacity and swap still prevent admission. The prior Workjet CI reached
type checking and found two synchronous-schema calls in test generators; those
and the equivalent new paths now use typed Effect encoding.
