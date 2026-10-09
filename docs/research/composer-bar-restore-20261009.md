# Restore the Workjet composer bar — 2026-10-09

Owner: Michael. Source baseline: `519aaba16528e4534dd948ac3e3cd184c099083b`.
Branch: `codex/composer-bar-restore-20261009`. PR: https://github.com/metric-space-ai/workjet/pull/292. Merge remains the supervisor's responsibility.

## Cause

The October 7 rebuild (`17e4fe426`, formatting follow-up `13b5f6040`) replaced the visible Luma picker with `CompactComposerControlsMenu addIcon`. That menu combined Lumas, attachments, workspace controls and advanced settings under `+`. The native supervisor rendered its own horizontal textarea/type/CTOX/send form and required Meta/Ctrl+Enter.

The earlier saved-Luma behavior (`79940af65`, `842260c86`, `03908edfc`) still exists in the draft store and selection handlers. The restoration retains that state and its Manual-return snapshot; it changes the visible controls, not provider dispatch. The project overview is retained.

## Change

All web/Electron coding threads (including parents/workers) and the native project supervisor use `ComposerBar`: editor above, attachment-only `+`, Luma/Manual, manual route chips, gear, dictation and round send. Advanced controls and workspace options are under the gear. Narrow widths retain the same order, with horizontal overflow confined to the middle chips.

Plain Enter and Cmd+Enter send; Shift+Enter inserts a newline; IME composition does not submit. The native supervisor keeps its existing binding, receipts, history, cancellation and send semantics. Its Task/Chat choice is inside the bar. Worker-source setup attempts automatically once after opening and waiting for the environment/catalog; a failed attempt exposes an explicit retry chip.

Supervisor Luma/model configuration is owned by Main/Crew. The existing capability contract has no actual route/model or selectable Luma facts. The bar therefore labels the route truthfully as the project's instance model, with display-only tooltips. This branch never pretends a local harness or local model performs the native supervisor request. The current supervisor contract is text-only; its attachment affordance explains the missing native attachment capability.

Dictation reads the selected instance's speech settings, captures bounded 16 kHz mono PCM16 audio, and appends final transcribed text to the draft without sending. It uses the additive standalone `speech.dictation` transport; it never calls or mutates a Jour fixe meeting. Recording stops on scope change/unmount and after 60 seconds. Missing settings lead to Speech settings; permission/transport failures remain visible with a settings action.

## Coordination and dependencies

PR #284 (`codex/supervisor-owner-input`) was open/draft at `587b373cb26f10f56061f3a71befe179f84953f2` before implementation and merged as `e15cb09d98773e0f07a3a137e4efb46e4ef092ab` during this task. This branch was rebased onto that merge. The overlapping form conflict was resolved by moving its Task/Chat picker into the bar, retaining its `inputting` disabled guard and its exact input-versus-send callbacks. Its same-task context logic is untouched.

Models owns native/shell dispatch for standalone dictation. Existing `project.jour_fixe.speech` is meeting-scoped and cannot safely be used for composer dictation. A concrete DTO handoff has been sent. Main owns actual supervisor execution-route facts and Luma selection; a direct boundary handoff has been sent.

## Verification record

App acceptance remains pending; no acceptance claim is made from source changes alone.

Formatting passed for the 21 changed files. Scoped lint passes; four existing unused-variable warnings in `ChatView.tsx` remain. The first gpu3 check on `e3c8e190d5bda906151b0655ab0193cea7feeec5` passed 176/177 tests in eleven files. The late-open cancellation assertion was corrected to wait for its cancellation receipt rather than assuming one microtask drains the transport. The corrected run is queued. Its first-run receipt is `/Volumes/tmp/dev-artifacts/build-lane/workjet-composer-bar-restore/workjet-composer-bar-restore-20261009T214917Z.receipt.json`; this temporary receipt is not final acceptance.

The UI dependencies live in `/Volumes/tmp/dev-artifacts/workjet/composer-bar-restore/pnpm-virtual-store`; workspace `node_modules` contain links. An offline install reused all 978 UI packages. Electron and the pinned Node runtime are being prepared under the shared Mac gate. No live Workjet installation or database was modified.

- Focused checks: keyboard policy, shared bar ordering and Luma/Manual, gear, dictation correlation/backpressure/cancellation, native supervisor bar and worker auto-connect, existing draft persistence.
- Required CI: Check, Test, Mobile Native Static Analysis, Release Smoke on the final PR head.
- Release candidate: canonical `scripts/build-desktop-artifact.ts` from the PR head, isolated profile, never installed over Michael's live Workjet during this task.
- Running-app screenshots: normal thread, project supervisor and parent at 1400 px and 900 px; Luma, Manual, gear open, dictation running. Record file paths and exact source SHA here after capture.
- Browser stories: Enter/Shift+Enter/Cmd+Enter, draft persistence after navigation/reload, selector state, auto-connect/retry, missing speech configuration, microphone stop and late-result cancellation. Capture console/network findings.

Initial environment limitations were gpu3/gpu4 SSH timeouts and an occupied Mac gate. gpu3 became reachable and now runs the checks. A stale earlier gpu1 run was canceled while still queued, using its captured systemd unit/PID. No gate was bypassed and no competing compiler was started.
