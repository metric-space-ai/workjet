# Restore the Workjet composer bar — 2026-10-09

Owner: Michael. Source baseline: `519aaba16528e4534dd948ac3e3cd184c099083b`.
Branch: `codex/composer-bar-restore-20261009`. Merge remains the supervisor's responsibility.

## Cause

The October 7 rebuild (`17e4fe426`, formatting follow-up `13b5f6040`) replaced the visible Luma picker with `CompactComposerControlsMenu addIcon`. That menu combined Lumas, attachments, workspace controls and advanced settings under `+`. The native supervisor rendered its own horizontal textarea/type/CTOX/send form and required Meta/Ctrl+Enter.

The earlier saved-Luma behavior (`79940af65`, `842260c86`, `03908edfc`) still exists in the draft store and selection handlers. The restoration retains that state and its Manual-return snapshot; it changes the visible controls, not provider dispatch. The project overview is retained.

## Change

All web/Electron coding threads (including parents/workers) and the native project supervisor use `ComposerBar`: editor above, attachment-only `+`, Luma/Manual, manual route chips, gear, dictation and round send. Advanced controls and workspace options are under the gear. Narrow widths retain the same order, with horizontal overflow confined to the middle chips.

Plain Enter and Cmd+Enter send; Shift+Enter inserts a newline; IME composition does not submit. The native supervisor keeps its existing binding, receipts, history, cancellation and send semantics. Its Task/Chat choice is inside the bar. Worker-source setup attempts automatically once after opening and waiting for the environment/catalog; a failed attempt exposes an explicit retry chip.

Supervisor Luma/model configuration is owned by Main/Crew. The existing capability contract has no actual route/model or selectable Luma facts. The bar therefore labels the route truthfully as the project's instance model, with display-only tooltips. This branch never pretends a local harness or local model performs the native supervisor request. The current supervisor contract is text-only; its attachment affordance explains the missing native attachment capability.

Dictation reads the selected instance's speech settings, captures bounded 16 kHz mono PCM16 audio, and appends final transcribed text to the draft without sending. It uses the additive standalone `speech.dictation` transport; it never calls or mutates a Jour fixe meeting. Recording stops on scope change/unmount and after 60 seconds. Missing settings lead to Speech settings; permission/transport failures remain visible with a settings action.

## Coordination and dependencies

PR #284 (`codex/supervisor-owner-input`) was open/draft at `587b373cb26f10f56061f3a71befe179f84953f2` before implementation. Its same-task context logic is untouched. Recheck/rebase after it lands; both branches edit the supervisor form and require a layout-only conflict resolution.

Models owns native/shell dispatch for standalone dictation. Existing `project.jour_fixe.speech` is meeting-scoped and cannot safely be used for composer dictation. A concrete DTO handoff has been sent. Main owns actual supervisor execution-route facts and Luma selection; a direct boundary handoff has been sent.

## Verification record

Pending until executed; no acceptance claim is made from source changes alone.

- Focused checks: keyboard policy, shared bar ordering and Luma/Manual, gear, dictation correlation/backpressure/cancellation, native supervisor bar and worker auto-connect, existing draft persistence.
- Required CI: Check, Test, Mobile Native Static Analysis, Release Smoke on the final PR head.
- Release candidate: canonical `scripts/build-desktop-artifact.ts` from the PR head, isolated profile, never installed over Michael's live Workjet during this task.
- Running-app screenshots: normal thread, project supervisor and parent at 1400 px and 900 px; Luma, Manual, gear open, dictation running. Record file paths and exact source SHA here after capture.
- Browser stories: Enter/Shift+Enter/Cmd+Enter, draft persistence after navigation/reload, selector state, auto-connect/retry, missing speech configuration, microphone stop and late-result cancellation. Capture console/network findings.

Initial environment limitation: gpu3 and gpu4 SSH timed out; no remote checks ran. The Mac UI dependency-install gate returned exit 75 because an existing Greppy index job held the shared heavy lease. No gate was bypassed and no competing compiler was started.
