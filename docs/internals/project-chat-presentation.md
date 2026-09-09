# Project chat presentation

The shared `@workjet/client-runtime/state/project-chats` selector prepares the
left sidebar for one selected native project. It derives a single group chat
and groups private chats by the native `worker_profile_id`. Chat titles,
profile names, models and orchestrator parent links never determine grouping.

The input is an already validated, authorized and complete projection snapshot.
Its structural row interfaces select existing native collection fields; they
are not a new IPC protocol. The native consumer remains responsible for
authentication, query policy, subscriptions, coherent snapshots and revocation.

The view scope includes instance, authenticated user, session generation and
project. An absent, incomplete or differently scoped snapshot produces no rows
and cannot establish that a default group needs creation. A complete snapshot
without a group lets the consumer use the existing idempotent ensure command;
the selector never dispatches commands or invents group IDs.

Active members can appear while their first chat is arriving. Removed members
remain visible when they have history. Authorized chats whose membership is no
longer available also remain grouped under their original profile ID, without
claiming active membership. Membership alone does not grant execution permission.

Ordering uses original creation time and IDs, preserving group positions across
profile renames and activity updates. Rows are retained by reference. Duplicate
chat/thread identities, multiple default groups and conflicting membership
references produce an explicit inconsistent state rather than selecting an
arbitrary identity.

Native `thread_id` is preserved as a native ID. It must not be passed to the
existing Code router as a Workjet thread ID without the explicit session mapping.
The selector owns no transcripts, durable cache, transport, credentials or
execution state.

## Integration status

The selector is implemented for web/mobile reuse and covered by focused tests.
It is not yet connected to the production sidebar. The host-side
NativeBusinessDataClient and the shared generated native Query/Watch/Command
contract are still being integrated with the architecture task. No new chat
subscriptions may use the warm Business OS guest as a fallback. The existing
project/computer guest controls remain until their native replacements have
functional parity and acceptance.

The next connection must expose native session state, complete snapshots,
revocation and explicit native-chat to Code-thread mapping before enabling
navigation and sending. UI acceptance, screenshots, VM control and worker
activity presentation remain separate outstanding work.
