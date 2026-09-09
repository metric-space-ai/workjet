# Native BusinessData subscription consumer

This is the shared, ephemeral projection core for the Workjet host/client integration. It consumes the generated native BusinessData contract from CTOX commit 19a790b906de97c3e7d6c2a9bd65da78dcc2cd98 (fixture SHA-256 1d9a7f2531cc70d942a9c3763f0d47076a9c732ff2712f84bdcfcf94d429e249). It adds no transport, listener, credentials, business persistence, command retry or native authentication.

The public package entry is @workjet/client-runtime/state/business-data-subscription. Generated wire types and Effect schemas are exported by @workjet/contracts/ctoxBusinessData. Regenerate them through the canonical CTOX generator with --business-data --workjet-root; never edit either generated side.

## Native binding and lifecycle

BusinessDataSubscription.open accepts the real native ready state, the watch request and its subscribed acknowledgement. It validates their protocol, request ID, handle, generation and subscription binding. The host must obtain these messages from its authenticated native service; matching JSON objects alone are not authorization.

Fresh subscriptions start at sequence 1. Every event must advance by exactly one, including reset and command events. Another session or subscription is ignored. Malformed current input, a gap, duplicate position, invalid transition or budget breach clears data/cursor and becomes terminal error. A new watch is then required; this class never starts one automatically.

| Native sequence                               | Visible records                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| subscribed → snapshotStart → snapshotPage\*   | Hidden                                                                       |
| snapshotEnd                                   | Hidden; initial data is complete but not caught up                           |
| caughtUp                                      | Visible                                                                      |
| recovery=true upsert/remove before caughtUp   | Hidden; no live-change notification                                          |
| recovery=false upsert/remove after caughtUp   | Updated; emits a live-change result                                          |
| reset → new snapshot on the same subscription | Cleared until the new caughtUp                                               |
| revoked / error / close                       | Cleared; later events cannot revive the view                                 |
| disconnect                                    | Hidden immediately; only a previously live in-memory baseline can be resumed |

Resume requires a matching retained cursor, target, instance, user and complete query. The new native ready/acknowledged subscription may have a new generation but cannot reuse the exact previous session/subscription identity. A changed query or identity requires a fresh watch. The host still owns unwatch, cancellation, reauthentication and event routing; it must retire old consumers when changing context.

There is no persisted second copy of business truth. The retained in-memory baseline is private, bounded, and serialized so callers cannot mutate it through input objects or returned views. Pages allow at most 200 records; the retained serialized record array, including IDs and UTF-8 bytes, is limited by the shared 2 MiB snapshot budget. Large collections require a suitable bounded native query, not a silently truncated view.

## Domain and integration boundary

Each instance models exactly one query/collection. V1 provides no common source boundary across project chats, project workers and profile bindings. Do not present independent projections as an atomic multi-collection snapshot. Their reconciliation must remain explicit in the project-chat UI.

BusinessData documents remain unknown at this generic boundary. Existing domain validation and the selected instance/user/project checks still apply before connecting them to projectChats or rendering any chat. The consumer neither supplies missing domain fields nor invents native thread IDs.

Command outcomes are returned unchanged to the existing command owner, including unknown. They are not journaled, retried or converted into successful business operations.

## Evidence and remaining work

The focused tests cover partial snapshots, recovery/live separation, reset continuity, sequence failures, terminal revocation, identity/query/cursor isolation, acknowledgement matching, unsafe generations, oversized pages/UTF-8 records, command outcomes and mutation-resistant baselines. They operate on generated logical messages; they are not native IPC, target-authentication or UI acceptance.

Still required: operational native BusinessData service and framing/backpressure, host routing/session lifecycle integration, source-coherent native snapshots and changes, domain validation, actual group/private-chat sidebar and transcript wiring, cross-device recovery, and desktop/mobile UI verification. The existing Project/Computer bridge remains until native parity is proved. No new chat subscription is added through a warm Business OS guest.
