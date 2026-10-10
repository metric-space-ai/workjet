# Restore the Workjet composer bar — 2026-10-09

Owner: Michael. Source baseline: `519aaba16528e4534dd948ac3e3cd184c099083b`.
Branch: `codex/composer-bar-restore-20261009`. PR: https://github.com/metric-space-ai/workjet/pull/292. Merge remains the supervisor's responsibility.

## Cause

The October 7 rebuild (`17e4fe426`, formatting follow-up `13b5f6040`) replaced the visible Luma picker with `CompactComposerControlsMenu addIcon`. That menu combined Lumas, attachments, workspace controls and advanced settings under `+`. The native supervisor rendered its own horizontal textarea/type/CTOX/send form and required Meta/Ctrl+Enter.

The earlier saved-Luma behavior (`79940af65`, `842260c86`, `03908edfc`) still exists in the draft store and selection handlers. The restoration retains that state and its Manual-return snapshot; it changes the visible controls, not provider dispatch. The project overview is retained.

## Change

All web/Electron coding threads (including parents/workers) and the native project supervisor use `ComposerBar`: editor above, attachment-only `+`, Luma/Manual, manual route chips, gear, dictation and round send. Advanced controls and workspace options are under the gear. Narrow widths retain the same order, with horizontal overflow confined to the middle chips.

Plain Enter and Cmd+Enter send; Shift+Enter inserts a newline; IME composition does not submit. The native supervisor keeps its existing binding, receipts, history, cancellation and send semantics. Its Task/Chat choice is inside the bar. Worker-source setup attempts automatically once after opening and waiting for the environment/catalog; a failed attempt exposes an explicit retry chip.

Supervisor Luma/model configuration is owned by Main/Crew. Main's merged #310 adds the project configuration field and selector; #311 adds native provider/profile controls. This branch is rebased onto main 81b260212 and retains those changes. The supervisor execution capability still does not report its actual active route/model, so the bar keeps display-only instance route chips and directs configuration to project settings. Configured profile values are not presented as proof of the executing route. The current supervisor contract is text-only; its attachment affordance explains the missing native attachment capability.

Dictation reads the selected instance's speech settings, captures bounded 16 kHz mono PCM16 audio, and appends final transcribed text to the draft without sending. It uses the additive standalone `speech.dictation` transport; it never calls or mutates a Jour fixe meeting. Recording stops on scope change/unmount and after 60 seconds. Missing settings lead to Speech settings; permission/transport failures remain visible with a settings action.

## Coordination and dependencies

PR #284 (`codex/supervisor-owner-input`) was open/draft at `587b373cb26f10f56061f3a71befe179f84953f2` before implementation and merged as `e15cb09d98773e0f07a3a137e4efb46e4ef092ab` during this task. This branch was rebased onto that merge. The overlapping form conflict was resolved by moving its Task/Chat picker into the bar, retaining its `inputting` disabled guard and its exact input-versus-send callbacks. Its same-task context logic is untouched.

Models owns native/shell dispatch for standalone dictation. Existing `project.jour_fixe.speech` is meeting-scoped and cannot safely be used for composer dictation. A concrete DTO handoff has been sent. Main owns actual supervisor execution-route facts and Luma selection; a direct boundary handoff has been sent.

## Verification record

App acceptance remains pending; no acceptance claim is made from source changes alone. The standalone native dictation dispatcher is an external dependency owned by Models; microphone capture tests do not prove live transcription.

After rebasing onto main `42848e309`, the clean PR head `341e29bfd` passed all 234 focused tests in twelve files, formatting and lint with two workers. Broader type checking caught the inherited missing authorization scope for `workjet.providerGateway.accountModels`, introduced on main. This branch adds its read scope and includes it in the authorization regression. The prior corrected run passed 177 tests, web/contracts type checking, `vp check`, desktop build and secret scan; release smoke stopped at a lane PATH error (`vp` absent), corrected in the final runner. Receipts: `workjet-composer-bar-restore-20261009T215222Z.receipt.json` and `workjet-composer-bar-restore-20261009T223118Z.receipt.json` under `/Volumes/tmp/dev-artifacts/build-lane/workjet-composer-bar-restore/`. These are temporary check receipts, not app acceptance.

The corrected `568b3c2a3` revision passed 255 focused tests, all seventeen package type checks, formatting, lint and action-pin checks. The remaining suite run (`workjet-composer-bar-restore-20261009T232632Z`, exit 0) passed the client/contracts/shared/adapter/script packages, the web unit suite, the native worker dispatch regression, 24 Rust tests, the secret scan, desktop build and release smoke. The broad server run had two resource-monitor discovery failures because the lane routes Cargo outputs outside the resolver’s default paths; the affected E2E file passed with the real lane-built binary supplied through `WORKJET_RESOURCE_MONITOR_PATH`. No assertions were weakened.

Canonical candidate preparation also exposed a release-helper defect: the server tarball retained the host-local `client` symlink. The helper now dereferences assets during archiving; an extraction regression removes the source target before verifying the unpacked client. The canonical Linux archive passed twice, including clean head `055576f44` (`workjet-linux-ssh-a2a80181aff0-20261009T231450Z`, SHA-256 `9d2fd27c72daef0c72beda9215cba655afb700085dbf910c14ed4836f170c425`). The macOS desktop build passed on `568b3c2a3`; app code did not change in the subsequent archive-test commits. A preliminary unpackaged Electron check exited with a module-resolution error from the external build-output directory and was closed; it is not app acceptance.

The UI dependencies live in `/Volumes/tmp/dev-artifacts/workjet/composer-bar-restore/pnpm-virtual-store`; workspace `node_modules` contain links. An offline install reused all 978 UI packages. Electron and pinned Node 24.13.1 are prepared under the shared Mac gate; the archive checksum and runtime identity passed the canonical verifier. No live Workjet installation or database was modified.

- Focused checks: keyboard policy, shared bar ordering and Luma/Manual, gear, dictation correlation/backpressure/cancellation, native supervisor bar and worker auto-connect, existing draft persistence.
- Required CI: Check, Test, Mobile Native Static Analysis, Release Smoke on the final PR head.
- Release candidate: canonical `scripts/build-desktop-artifact.ts` from the PR head, isolated profile, never installed over Michael's live Workjet during this task.
- Running-app screenshots: normal thread, project supervisor and parent at 1400 px and 900 px; Luma, Manual, gear open, dictation running. Record file paths and exact source SHA here after capture.
- Browser stories: Enter/Shift+Enter/Cmd+Enter, draft persistence after navigation/reload, selector state, auto-connect/retry, missing speech configuration, microphone stop and late-result cancellation. Capture console/network findings.

Initial environment limitations were gpu3/gpu4 SSH timeouts and an occupied Mac gate. gpu3 became reachable and now runs the checks. A stale earlier gpu1 run was canceled while still queued, using its captured systemd unit/PID. No gate was bypassed and no competing compiler was started.

## Candidate and acceptance status — 2026-10-10

The supervisor merged PR #292 as `dda7af8c646953bdbf6c98fdfd3a9fcb0e5a2f16` at 00:31:35 UTC. This task did not merge it. Follow-up PR https://github.com/metric-space-ai/workjet/pull/317 corrects the microphone's missing-backend navigation: use the active router for browser history and Electron hash history, rather than assigning a desktop-only hash URL. Its focused navigation regression checks the route and verifies that no microphone starts. Main's #310/#311 configuration changes are retained.

Canonical macOS ARM64 candidate `0.0.71-rc.composer.1` was packaged successfully from #292 head `cceb5c71dcd8105ea32d0073154628e24387c067`:
`/Volumes/OneTB/dev-artifacts/workjet/composer-bar-rc/rc/Workjet-0.0.71-rc.composer.1-arm64.zip`.
The canonical Linux companion archive receipt is `workjet-linux-ssh-a2a80181aff0-20261009T234227Z.receipt.json`, SHA-256 `19c716ebcc55be56625d0251139de008d0e82d702a65b9c8f89f6bf7c17cb6b0`. The candidate contains the verified bundled shell and portable server archives; it was unsigned and was never installed over Michael's app. This candidate predates #317 and is not represented as a build of the follow-up head.

The isolated desktop profile reached the app, but initial bootstrap and reopening raised the native alert: “Could not encrypt credential for the saved local Desktop session.” The alert blocked the renderer automation endpoint. No composer acceptance passed. Main received the exact error and reproduction profile; the root cause has not been established. Screenshot:
`/Users/michaelwelsch/.codex/task-evidence/composer-bar-restore-20261009/screenshots/isolated-session-encryption-error.png`.

| Requested evidence                              | Status                                            |
| ----------------------------------------------- | ------------------------------------------------- |
| Normal / supervisor / parent at 1400 and 900 px | Pending running-app access                        |
| Luma / Manual / gear open                       | Pending running-app access                        |
| Dictation running and final draft text          | Pending native/shell delivery of CTOX #553        |
| Real supervisor answer and persistence          | Not claimed from isolated-profile or unit results |

CTOX https://github.com/metric-space-ai/ctox/pull/553 implements the matching standalone request/response contract. Its shell validates `commandId`, `streamId`, `sequence`, `pcmBase64` and `afterSequence`; configured speech remains native-owned. It is a delivery dependency, not proof of installed transcription.

The isolated app processes were closed. The isolated Node service was stopped through its own packaged `service stop --base-dir` command. `service uninstall` returned launchctl exit 3 after the stop; its exact owned, unloaded LaunchAgent was then backed up under the evidence directory and removed. No live Workjet process or service was signaled. The source clone and both PRs are durable; the candidate/profile remain disposable reproduction artifacts. Successful check receipts and the screenshot are copied under `~/.codex/task-evidence/composer-bar-restore-20261009/`.

GitHub Actions run `38005803722` finished successfully on #292 head `cceb5c71dcd8105ea32d0073154628e24387c067`: Check, Test, Mobile Native Static Analysis and Release Smoke are green. #317 has separate final-source checks; it is not covered by that earlier run. An obsolete queued rebase check was explicitly canceled using its captured owned runner/process group after #292 merged; no build had begun and no resource from another task was stopped.

Main's open PR https://github.com/metric-space-ai/workjet/pull/316 supplies configured supervisor route facts from CTOX #550 inside the existing bar; its contract explicitly distinguishes configured values from verified execution. It overlaps #317 only at the display-only supervisor tooltip. No #284 submit/input or Main routing logic was changed here; preserve Main's scoped route consumer when composing these changes.
