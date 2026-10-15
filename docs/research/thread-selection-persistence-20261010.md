# Immediate thread route persistence — 2026-10-10

Base: `a70c72db1fc3f8c9a1edd46a1cbd2a93ad4aa695` (origin/main). Separate follow-up; PR #373 is unchanged.

## Cause

At the base revision, `apps/web/src/components/ChatView.tsx:6802` handles Harness/Model choices, but line 6819 only writes `setComposerDraftModelSelection`. It does not update thread metadata. `persistThreadSettingsForNextTurn` (line 4406, metadata write at 4428) saves the selection in the send paths at 6045 and 6555. A blocked send therefore leaves the persisted route unchanged.

The existing metadata path is already independent of provider authentication: `packages/client-runtime/src/operations/commands.ts:244` dispatches `thread.meta.update`; `apps/server/src/orchestration/Layers/ProjectionPipeline.ts:802` persists the event's model selection. The existing per-thread command scheduler orders metadata updates and turns.

The composer also prioritizes its local draft and the previous session's provider. The sidebar and worker overview can display the previous session's harness alongside the saved next-turn model. The worker picker previously started computer continuation before saving its new model, allowing the target thread to inherit the old route.

## Change

Existing threads save a Harness/Model choice through the metadata command immediately, before applying a local profile or starting computer continuation. Saving requires the Workjet connection, but does not require an authenticated harness or a sent message. Failed writes show an error and retain the saved choice. Send and computer movement cannot overtake an outstanding save.

Composer, sidebar and worker overview use the persisted next-turn route; a matching previous session can supply its display name. Stale local draft choices cannot override it. New unsaved threads keep their draft behavior. A Luma chip is valid only when its saved harness/model and computer match.

Project/native-managed choices stay read-only. This change does not modify their contracts, reconnect paths, the installed app, authentication, or live userdata.

## Validation

Focused web tests cover a saved choice reconstructed without sending, stale drafts, write failure, pending writes, the overview's old-session mismatch, and read-only native controls. The server integration test reads the persisted projection after `thread.meta.update`, confirms no session or turn was started by the choice, and starts the first turn without an explicit route so the saved Grok route must be used.

Required checks run on the canonical gpu3 lane with two workers. Installed-app acceptance is not claimed by these tests.
