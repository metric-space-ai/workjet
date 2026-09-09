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

This is transport consolidation, not the completed CTOX capability. The
connection registry, immutable thread/instance binding, typed app tools, menu
activation and Crew context still need integration. The existing cross-mode
client also has an outbound transport; its authority checks and typed rejection
semantics must survive consolidation. No raw RPC entry point is exposed to a
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
