# CTOX Desktop App — the remaining work

Produced 2026-08-20 by a whole-document reconciliation audit of
[`docs/workjet-plan.md`](workjet-plan.md). Every one of that document's open
boxes was re-read against the code and its tests, ticked only against named
files and a covering test, and tagged in place with the bucket it belongs to.
This file is the handover: reading only this page should tell you what to build,
what to decide, and what cannot be done from this repository at all.

**Why a separate file rather than a section at the top of the plan.** The plan is
~3 900 lines and its own opening is the product contract, which a new reader
needs before anything else. The handover has the opposite shape: it must be
short, must survive being read alone, and must not grow every time an evidence
note grows. So the plan stays the evidence store — every line below cites the
section it came from — and this page stays the index. Keep them in step: when a
box in the plan changes bucket, move its row here in the same commit.

## Where the project stands

`280/353` boxes complete (79.3%), `73` open. Each open box is counted once,
under **the last thing that has to happen before it can be ticked** — so a box
that needs a decision _and_ a second machine counts as BLOCKED-ON-REALITY, and a
box with buildable work inside it still counts as blocked if something else gates
the tick.

| Bucket                 | Boxes | What it means                                                                 |
| ---------------------- | ----- | ----------------------------------------------------------------------------- |
| **DONE**               | 280   | Ticked against named files and a covering test. 12 were ticked by this audit. |
| **BLOCKED-ON-OWNER**   | 11    | A person must decide. No amount of engineering moves these.                   |
| **BLOCKED-ON-REALITY** | 40    | A second machine, another OS, real credentials, or a CTOX-repository change.  |
| **IMPLEMENTABLE**      | 22    | Nothing gates them but effort.                                                |

Two different units appear below and they do not match on purpose. There are
**11 owner-gated boxes but only 10 distinct decisions**, because one decision
(cutting the gateway-host release tag) gates three boxes. And there are **22
implementable-dominant boxes but 29 discrete buildable pieces of work**, because
seven of them live inside boxes whose tick is gated by something else — the
Code-mode E2E driver, the differential-runner fix, the descriptor ownership
check, the macOS keychain smoke, the target-side capability check, the peer
revoke/re-pin path, and the Workjet-owned web-stack CLI binary. Those seven are
worth building anyway; they just will not tick their box on their own. Boxes
spanning more than one bucket are marked `SPLIT` in the plan.

The single most valuable thing that can be built here is the **Code-mode
end-to-end driver**. It is its own release gate, and it is also the missing
third prerequisite of the mixed-harness cross-computer proof, which is the
largest unproven claim left in the plan.

---

## BLOCKED-ON-OWNER — ten decisions

Nothing below is an engineering question. Each one names the decision and what
follows from it.

### 1. Cut the first `provider-gateway-host-v*` release tag

Plan §6 (release artifacts; CTOX pinned dependency; §15 provenance).
**Decision:** tag a first provider-gateway-host release so
`.github/workflows/provider-gateway-host-release.yml` runs and emits a real pin.
**Consequence of not deciding:**
`apps/desktop/resources/provider-gateway/host-release.pin.json` stays
`"status": "unreleased"`, packaged builds refuse to start a pinned host by
design, and three further plan lines stay blocked behind it — the CTOX pinned
dependency, the removal of the portable duplicate from CTOX, and the provenance
half of the signing gate. The pipeline itself is landed and two of six target
triples are locally reproduced byte-identically; only the tag is missing.

### 2. Rename the repository to `metric-space-ai/ctox-desktop-app`

Plan §2. **Decision:** rename now, or keep `workjet` through first public
distribution. **Consequence:** the desktop updater feed is derived from the
repository (`resolveGitHubPublishConfig`,
`scripts/build-desktop-artifact.ts:2090-2113`), so renaming _after_ the first
public binary strands every installed updater. The rename also moves every
remote URL, CI reference and agent branch remote in one pass. The
product-identity half is already done — name, installers, icons and artifact
filenames all say `CTOX Desktop App`.

### 3. The home sink ships a raw bearer token off-box

Plan §12 (redact provider traffic). **Decision:** is the home sink a trusted
destination that may receive unmasked provider credentials, or is this a leak to
close? `HomeRequestLogPayload::new`
(`native/provider-gateway/internal/logging/request_logger_home.rs:35-42`) builds
its `headers` map with `clone_headers` (`:55-61`), which applies no masking, so
a raw `Authorization: Bearer …` leaves the machine whenever the sink is bound.
**Consequence:** the behaviour is _pinned_ by a counter-test
(`request_logger_home_test.rs:48`) that asserts the unmasked value. Any fix
breaks that test, which is exactly why this is a decision: the counter-test is
the record of the current answer, and closing the leak means rewriting the
record deliberately, not deleting it quietly. This is the only open security
invariant that is a decision rather than work.

### 4. Execute the upstream re-parent reconnect

Plan §14. **Decision:** run the proven re-parent replay, or accept that the fork
is permanently unmergeable to upstream. **Consequence:** all 485 commit ids
change and every agent branch must be re-pointed in the same pass. The technique
is already proven on `scratch/ancestry-probe` (`98cd9ef0f`: tree-identical to
today's tip, ancestry established, a PR would list 485 commits instead of 3001).
Until this is decided, "rebase or merge upstream at the end of every completed
wave" is not merely undone but _impossible_ — there is no ancestry to merge onto.

### 5. Confirm dropping the "short, ordered patch stack" goal

Plan §14. **Decision:** accept the measurement (the stack is 485 commits, fully
interleaved, and reordering does not pay against 43 conflict hunks per cycle) and
delete the goal — or fund rebuilding it into ordered theme branches.
**Consequence:** while undecided, the plan carries a goal its own measurement
says is unachievable as written.

### 6. Contribute fixes upstream, or record that we will not

Plan §14. **Decision:** open upstream pull requests against `pingdotgg/t3code`,
or record "no" as the answer. **Consequence:** with no ancestry to upstream,
every contribution must be hand-extracted as a fresh patch rather than
cherry-picked, so the cost depends entirely on decision 4. "No" is a legitimate
answer and is better recorded than left permanently open.

### 7. `apps/web/src/orchestrationEventEffects.test.ts` — keep or drop

Plan §14. **Decision:** upstream deleted this file in `277322933` ("test: remove
redundant and stale tests (#6267)") and Workjet still edits it. Keep the Workjet
copy or drop it. **Consequence:** it is the one modify/delete conflict in the
measured upstream merge; leaving it undecided means re-resolving the same
conflict every cycle.

### 8. Does CTOX Desktop App need sudo credential handling at all?

Plan §10 (secret-storage parity). **Decision:** decide before anyone builds it.
None exists today and no CTOX flow in this tree asks for one — the only `sudo` in
the desktop tree is the unrelated `DesktopWslEnvironment.ts`. **Consequence:**
the parity-gate line keeps naming a capability nobody has justified, so that
gate can never go green honestly.

### 9. Merge the CTOX `codex/ctox-rc7-active-revocation` branch

Plan §18 item 12. **Decision:** merge the CTOX branch that carries the
active-revocation sweep and the latched `peer_revoked` status into CTOX main.
**Consequence:** the packaged revoke/unrevoke run that passed on 2026-08-18 did
so against a build from that unmerged branch. Until it lands on main, the
green result rests on a branch build, and any later CTOX release could silently
regress it. (The plan records the branch name and its two commits; if this is
tracked as a numbered CTOX pull request, use that number here.)

### 10. Keep or drop the provider-gateway differential gate

Plan §15. **Decision:** either vendor/pin the Go CLIProxyAPI upstream under
`runtime/cliproxyapi-upstream` and fix the `repo_dir` computation in the 26
`run_*_differential.sh` scripts (they were written for the deeper CTOX layout
and now resolve two levels above the Workjet repo root), or drop the differential
from the release list. **Consequence:** it is currently listed as a release gate
that has never run and cannot run — the smallest of these decisions, but it
keeps a release gate permanently red.

---

## BLOCKED-ON-REALITY — what this checkout physically cannot do

Grouped by prerequisite, because one prerequisite usually unblocks several boxes
at once.

### A second physical machine — 4 boxes

Plan §8. Needed for: the live two-machine mailbox replication run; the real
machine-A → machine-B thread handoff including a worker worktree branch; the
cross-computer half of the mixed-harness E2E; and queue item 14.
Every transport test in this repository drives a fake daemon `HttpClient` stub,
and the CTOX-side `two_daemons_replicate_only_the_mailbox_across_a_mesh_join`
test is two processes on one host — neither substitutes for two machines whose
daemons must be online at overlapping times. **One paired second machine closes
all four.**

### Real provider credentials — 3 boxes

Plan §8, §15. Needed for: the live provider round trip and one successful OAuth
login against a real client registration (which also gates the native settings
surface above it); one executed completion routed through the gateway; and the
real-account provider gate. The mixed-harness leg additionally needs
subscriptions for three _different_ harnesses (Codex, Claude Code, Grok),
because interoperation is the point of that gate — it is counted under the
second-machine group, since it needs both. Everything below the credential is
built and tested: routing is proven at the environment and argv layer against a
test gateway layer, which is exactly as far as code can go.

### An operator run of the packaged app against a real CTOX instance — 5 boxes

Plan §10, §18. Needed for: the light scheme and three/two/one-pane layout proofs
inside the packaged app; the paired packaged-app smoke against the
operator-selected real instance; confirmation that the ephemeral browser peer ID
is captured from a live handshake and never persisted; the full
healthy → revoke → unhealthy → unrevoke → healthy → remove/reimport sequence; and
the product-mode-shell proof in queue item 3. The driver exists
(`scripts/ctox-packaged-smoke.ts`) and macOS packaging is green.
**Build and pair once, then run all five in the same session** — and note the
sequence must be redone against the currently pinned shell `v0.1.0-rc.12`, not
RC6 or rc.7.

### A change in the separate `metric-space-ai/ctox` repository — 21 boxes

Plan §1, §5, §6, §7, §10, §11. The largest group, and none of it is Workjet
work:

- the `Delegate to Code` / `Open in Code` buttons, which live in the Business OS
  UI;
- the Business OS capability-availability surface plus an MCP control method;
- a CTOX dependency on the pinned gateway release, one gateway runtime per
  instance, and removal of the portable duplicate;
- removal of the duplicate CTOX Web Stack source, and the `ctox-pdf-parse`
  reconciliation (Workjet holds only one side of that diff);
- `ctox` daemon CLI verbs for local-daemon lifecycle, and remote `ctox` CLI verbs
  for SSH attach/install/rotate/revoke — without them the desktop has nothing to
  drive, which is what blocks three separate lifecycle boxes;
- the Rust `WebRTCPeerSessionValidator`, whose live behaviour the plan records as
  unexplained, and which is the blocker under the packaged revoke sequence;
- CTOX daemon device attestation, the only thing that closes the first-contact
  TOFU impersonation window in the remote-dispatch security invariant;
- all six Wave 8 boxes (delete the legacy wrapper, its workflow and download
  links, repoint the docs, the keep-list assertion, and the CTOX-side release
  smokes).

### Another operating system or signing credentials — 2 boxes

Plan §15, §10. A Linux host or container toolchain for `dist:desktop:linux`; a
Windows host with NSIS plus the `wsl-prebuild/pty.node` artifact for
`dist:desktop:win`; Apple signing credentials (`CSC_LINK`, `CSC_KEY_PASSWORD`,
`APPLE_TEAM_ID`, `MACOS_PROVISIONING_PROFILE`, an App Store Connect key) for
signing and notarization. The Linux leg of the platform-keychain smoke also needs
a Linux host, though its macOS leg is implementable here.

### A route on the Rust gateway host — 2 boxes

Plan §8. Per-account capacity, cooldown and rate-limit are hardcoded
`not-reported-by-host` (`ProviderGatewayService.ts:1123-1124`) because the host
holds that state in an in-process store and publishes no way to read it. Adding
the route is gateway-host work that also changes the pinned artifact.

### A live ctox.dev sign-in, or a built `ctox` binary — 3 boxes

Plan §15, §5. The CTOX-mode E2E story cannot be scripted against nothing — steps
1-3 and 8 all require a real ctox.dev account and instance. The
`web-stack-browser` real-installed-browser E2E and the Web Stack
search/browser/E2E release gate both need a built `ctox` binary, live network
and a patchright + Chromium runtime — though **item 21 below removes the
`ctox`-binary half of both**, which is why it is worth doing even though these
are listed as blocked. (The SSH-managed launch has also never been run end to
end against a real remote host; that box is counted under the CTOX-repository
group, because its other half needs remote `ctox` CLI verbs.)

---

## IMPLEMENTABLE — 29 items, ordered by value

Value here means: what it unblocks, then what it protects, then what it
finishes. Scope estimates are rough and name the files.

### Tier 1 — unblocks other work, or closes a security invariant

1. **Code-mode end-to-end driver.** §15. Boots the app against a disposable
   state directory and asserts delivery receipts, durable status, result return,
   cancellation and restart recovery. No runnable gate exists today: `apps/web`
   declares one vitest `unit` project and there is no Playwright/WebDriver
   harness. _This is also the missing third prerequisite of the mixed-harness
   E2E._ New harness under `apps/web` or `scripts/` plus a browser-driver
   dependency — **large**, and the only large greenfield item left.
2. **Web Stack SSRF, redirect cap, and the untested stdout budget.** §7 and §12
   — one piece of work that ticks two boxes, one of them a security invariant.
   Install `SsrfResolver` on the three unresolved `ureq` agents in
   `native/web-stack/src/scholarly_search.rs` (`:407`, `:968`, `:1696`), add an
   explicit redirect-hop cap (there is none in the crate at all today, so the cap
   is whatever `ureq` defaults to), and add the missing test for the TypeScript
   stdout byte budget. ~1 Rust file, 3 TS test additions, a full crate build —
   **medium**. Contains one small decision: `web_search.rs` already grants a
   self-hosted SearXNG base, so you must choose which configured hosts stay
   reachable.
3. **Secret-scanning gate over tracked files, plus a browser-storage canary.**
   §12 — closes the two unguarded sinks that keep the "no raw secrets" invariant
   unticked. A script over `git ls-files` reusing the canary table the support
   bundle already declares, run in CI, plus one renderer test asserting no secret
   shape reaches `localStorage`/IndexedDB. **Small**, and the cheapest security
   invariant on the list.
4. **`./node_modules/.bin/vp check --fix`.** §15. 144 tracked files unformatted
   (82 `native/web-stack`, 35 `native/provider-gateway`, 13
   `experiments/kundenpipeline-module`, 5 `native/pdf-parse`, 5 `apps/server`, 2
   `docs`, 2 `apps/web`), which is the whole of why the CI `Check` step is red.
   One command, zero behaviour change — **but land it as its own
   formatting-only commit**, never mixed with a behavioural change.
5. **Clear the 57 pre-existing `t3` server typecheck errors.** §15. The mobile
   half of this gate is now green (0 errors, verified in this audit), so the
   server package is the only thing keeping `vp run -r typecheck` red.
   **Medium**, and it is pure debt.
6. **Peer revoke / re-pin path.** §8 and §12 — one piece of work, two boxes. Key
   rotation is currently a refusal with no way back, and there is no `revokePeer`
   or `forgetPeer`, which is what leaves "revocable environment credentials"
   unticked. ~1 migration, 1 RPC, 1 UI confirmation plus tests — **medium**.
7. **Target-side capability check on the remote delegation path.** §12. Add a
   parent-superset check beside the existing target ROLE check
   (`WorkjetDelegationExecutor.ts:857`). Defence in depth rather than a live
   escalation — ~1 file plus a test, **small**.

### Tier 2 — finishes a wave

8. **Live harness availability.** §8. Replace the hand-toggled static boolean
   with `workjet.harness.inspect|install|update|remove` RPCs beside the existing
   Greppy pair (`packages/contracts/src/rpc.ts:330-345`), a server service that
   probes each harness executable, and make `WorkerDispatch.ts` consult the
   result — today the server never reads availability at all. ~4 server files, 1
   contract, 2 web files plus tests — **the largest single Wave 5 item**.
9. **Settle `workjet_dispatch_worker`.** §8 — one decision closes three boxes
   (bounded dispatch/cancel/retry/timeout/result, durable worker status, and
   completion-as-an-event). Option A: route it through the delegation machinery
   it currently bypasses. Option B, cheaper: retire it in favour of
   `workjet_delegate_task`, which already has all five semantics. **Make the
   choice once**, then implement.
10. **Durable per-delegation state event log.** §8. An append-only table written
    in the same transaction as `transitionDelegationState`, so status stops being
    a mutable row column. 1 migration, 1 store file plus tests — **medium**.
11. **Inbound thread-activity traces on the cross-environment path.** §8 — one
    piece of work, two boxes. `WorkjetMailboxTransport.ts` appends no thread
    activity at all, so a remotely delivered delegation first appears on the
    target timeline as `workjet.delegation.started`. ~2 files plus tests —
    **small**.
12. **Per-operation mailbox ACLs and a worker-initiated path.** §8. Replace the
    single `requireOrchestratorSource` gate (`WorkjetMailboxRpc.ts:169-181`) with
    per-operation scopes, and let a WORKER thread reply to or update its own
    delegation — today it cannot use the mailbox RPCs at all. The RPC
    authorization table, one server file, five MCP tool guards plus tests —
    **medium**.
13. **Populate artifact references, and add diff/Greppy reference kinds.** §8.
    The executor writes an empty `artifacts` literal on every result
    (`WorkjetDelegationExecutor.ts:914`); there is no diff or Greppy reference
    type at all, and nothing resolves a reference on the receiving side. ~3 files
    plus tests — **medium**.
14. **Handoff head commit and acknowledgement envelope.** §8. Read the real head
    commit and push where a remote is configured (`headCommit` is an optionalKey
    nothing writes), and add an acknowledgement kind to
    `WorkjetMailboxEnvelopeKind` so machine A learns machine B continued the
    work. ~4 files plus tests — **medium**.
15. **Progress-board policy and verification state.** §8. Neither exists as a
    field on `WorkjetConfigurationValue`. Add both with a schemaVersion 3 decode
    step in the same style as the ticked v1→v2 migration, plus their settings
    editors. ~3 files plus tests — **medium**.
16. **Fresh-install / upgrade / rollback harness.** §15. Install a packaged build
    into a clean prefix, point it at the existing `scripts/mock-update-server.ts`,
    apply an update, force a rollback, assert the settings store survives. All
    the pieces exist; the harness that composes them does not. One script plus a
    test — **medium**.

### Tier 3 — visible gaps, small work

17. **Dead-letter state in the UI.** §8. The data is already there and unread —
    the executor's counters are annotated "for later UI exposure" and the audit
    stream reaches a client-runtime atom (`server.ts:1044-1046`) no component
    renders. A dead-lettered plain _message_ surfaces nowhere today. **Small**,
    and it could share a panel with item 18.
18. **Mount the cross-mode notification panel.** §1. Model and rendering are done
    and tested; nothing outside `apps/web/src/crossMode/` references them. The
    precondition — that the cross-mode link RPCs land — has since been met.
    ~2 files plus a mounting test — **small**.
19. **Wire the gateway host artifact resolver into startup and packaging.** §6.
    `resolveProviderGatewayHostExecutable` has no production call site, and
    `scripts/build-desktop-artifact.ts` contains no `provider-gateway` reference
    at all, so nothing ships or resolves the host in a packaged build. One call
    site plus an extra-resource entry — **small**, and independent of the tag
    decision.
20. **Three cheap upstream conflict mitigations.** §14. A trailing `workjet*`
    barrel import in `ChatView.tsx`, `ChatComposer.tsx`, `SidebarChrome.tsx` and
    `packages/contracts/src/settings.ts`; a marked Workjet section at the end of
    `apps/desktop/src/ipc/channels.ts`; extraction of the Workjet turn-option
    threading out of `CodexSessionRuntime.ts`. That is 5 of the measured 43
    conflict hunks and they recur every cycle. 6 files, no behaviour change —
    **small**. Worth doing whichever way decision 4 goes.
21. **A Workjet-owned `workjet-web-stack` CLI entry point.** §15 and §5 — one
    piece of work, two boxes. The crate already declares the `[[bin]]`; retarget
    `scripts/test_web_search_e2e.sh` and `scripts/test_web_unlock_e2e.sh` at it
    and the CTOX-binary dependency disappears, leaving only network and browser
    runtime. 2 shell scripts plus a bin entry point — **small**.
22. **About panel on Windows and Linux, plus a release-feed identity test.** §9.
    Add Help → About outside the `platform === "darwin"` branch
    (`DesktopApplicationMenu.ts:146`), and a test that a released CTOX build's
    publish feed points at the CTOX repository. 2 files plus 2 tests — **small**.
    Becomes load-bearing the moment decision 2 is taken.
23. **Platform-keychain runtime smoke.** §10. A script exercising
    `ElectronSafeStorage.ts` and `linuxSecretStorage.ts` against the real OS
    keychain — encrypt, restart, decrypt, and assert the Linux backend guard
    fails closed. **Small on macOS**; the Linux leg needs a Linux host.
24. **Keyboard and zoom targeting of the active CTOX guest.** §10. Make `zoomMain`
    (`DesktopWindow.ts:858-866`) and the View-menu accelerators ask
    `CtoxGuestManager` whether a guest is active, and either target it or suppress
    the accelerator deliberately. 2 files plus a test — **small**.
25. **Local-daemon descriptor ownership check.** §10. The descriptor is trusted
    from the state root with no owner/uid/permission verification. One file plus
    a test — **small**, and worth doing on its own because it is a trust boundary
    (the rest of that box needs `ctox` CLI verbs).
26. **Six user-visible `T3 Code` strings.** §9. `SplashScreen.tsx:4-5`,
    `RightPanelTabs.tsx:88`, `SshPasswordPromptDialog.tsx:164`,
    `RelayClientInstallDialog.tsx:72-73`,
    `MobileClientsUserProfilePage.tsx:97`, `ChatView.tsx:6575`. Leave the
    migration dialog's "previous T3 Code profile" copy and the ~70
    non-user-visible occurrences alone. 6 one-line edits — **small**.
27. **In-cycle cursor following in the mailbox transport.** §8. `next_cursor` is
    decoded (`WorkjetMailboxTransport.ts:595`) and then dropped, so a backlog
    drains one 50-envelope page per 10-second cycle. A small loop change in
    `pull` — **small**.
28. ~~**Three Rust logging-policy tests.**~~ **DONE 2026-08-20, commit
    6c03e99c7.** §12, independent of decision 3. All three are now guards:
    `request_logging_policy_test.rs` pins that the host never selects
    `RequestLoggingPolicy::full` (it scans `server.rs` and names the offending
    line, and pins the positive half so deleting the setup does not pass) and
    that `sdk_config.request_log` defaults to `false`;
    `logging_helpers_test.rs` pins that `commercial_mode` suppresses upstream
    capture. Mutation-verified: one call site flipped to `full_scoped` fails
    the guard with "selects full request logging at line(s) [2047]"; reverted.
29. ~~**Assert the provider/model picker stays enabled on orchestrator and
    worker threads.**~~ **DONE 2026-08-20, commit f530f207b.** §8. The seam is
    `deriveLockedProvider` (`ChatView.logic.ts:387`); the guard in
    `ChatView.logic.test.ts` runs standard, orchestrator and worker threads
    through it across every situation that legitimately changes the answer and
    requires all three to agree, plus a second assertion pinning the input
    shape so a future role cannot make the picker role-aware unnoticed.
    Mutation-verified: returning null for worker threads fails both, naming the
    divergent role.

### Also implementable, but decide first

- **Cost budget.** §8. `maxCostMicros` is enforcement machinery over an input
  that is always zero, because no per-turn cost figure exists anywhere. Either
  derive one from the token deltas the executor already charges times a per-model
  price table (which does not exist yet), or delete `maxCostMicros`. **Small in
  either direction** — the work is choosing.
- **Transactional thread-visible mailbox events.** §8. Keeping the
  `appendActivity` outside the store transaction is a documented, defensible
  choice — a refused append must not turn an executed delegation into a reported
  failure. The plan line promises a transaction the design deliberately does not
  want, so this may be a wording fix rather than a code change.

---

## Corrections made by this audit

Claims that were found to be _wrong_ rather than merely stale. Each is marked
`KORREKTUR` in place in the plan rather than deleted.

1. **"Swift Workjet configuration migration — nothing exists."** Flatly false,
   and already contradicted by the release-gate measurement on the same page.
   The RPCs (`workjet.legacyImport.inspect|decide`), all four server modules with
   66 tests, and the settings offer surface (`WorkjetSettings.tsx:1180,1226`) are
   all present. The box is now ticked; the honest residue is that there is no
   Workjet-side _export_ command, because the legacy document is produced by the
   Swift application, which is not in this repository.
2. **"Deep-link parsing has no user confirmation and no OS-level intake."** Both
   halves false. `DesktopDeepLinkRouter.ts` registers `open-url` and
   `second-instance` and reads Windows/Linux cold-start links out of
   `process.argv`; `DeepLinkConfirmationDialog.tsx` is mounted at
   `routes/__root.tsx:142` and is the only path from a link to a navigation. The
   macOS pre-`ready` ordering hazard is handled and statically asserted. Ticked.
3. **"SSH launch is unreachable from the UI."** Superseded by commit `8752fc9ae`
   and stated wrongly in three places: the Wave 6/7 gap table, the renderer
   sub-item note, and the Wave 8 verification line.
   `canActivateCtoxInstance` (`CtoxModeShell.tsx:167-177`) launches a reachable
   `ssh_managed` row, and the surviving `CTOX_SSH_LAUNCH_PENDING_HINT` constant
   now reads "This SSH host is not reachable right now." — an offline hint, not a
   missing-feature hint.
4. **"Support-bundle redaction and crash-report metadata — nothing exists at
   all"** (Wave 6/7 gap table row 1). It had already shipped when the table was
   written.
5. **The M3 provider-routing boxes were stale.** Routing landed on 2026-08-19/20
   and four boxes were never moved. All four drivers call
   `resolveGatewayRoutedEnvironment` at session start, composer model selection
   resolves to a gateway route, and eleven tests cover it. Ticked, with the honest
   limits kept visible: routing is a per-instance opt-in, Cursor is refused
   `driver-unsupported`, and no completion has yet been executed through a
   running host.
6. **Three release-gate failures were fixed after the gate was measured, and the
   plan still recorded them as red.** Re-run independently for this audit:
   `@t3tools/mobile` typecheck → exit 0, zero errors (was 8);
   `node scripts/release-smoke.ts` → exit 0, "Release smoke checks passed." (was
   an abort); `cargo fmt --check` and
   `cargo clippy -p workjet-provider-gateway --all-targets -- -D warnings` → both
   exit 0 (were 16 hunks and 1 error).
7. **The `apps/server` Workjet suite figure.** §8 claimed 32 files / 489 tests
   and §15 claimed 20 / 384. Neither reproduces: the measurement today is **21
   files, 395 tests, all green, 24 s**. The growth over 20/384 is the cross-mode
   slice, which lands inside the same path.

Two corrections already recorded in the plan before this audit — the
`pools`/`routes` "dead schema" verdict and the fire-and-forget "remains future
work" clause — were re-checked and still hold as written.

---

## Traps worth knowing before you start

- **`vp` is not on `PATH`.** Use `./node_modules/.bin/vp`, and for scripts that
  shell out to it (`scripts/release-smoke.ts`) run with
  `PATH="$PWD/node_modules/.bin:$PATH"`.
- **Run the full test suite unloaded.** `vp run -r test` fails under CPU
  competition — `scripts/lib/cli-external-packages.test.ts` hits its 60 s
  timeout and aborts the web/mobile/desktop tasks with it.
- **Rust gates need an out-of-tree target dir.** Use
  `CARGO_TARGET_DIR=/Volumes/tmp/workjet/cargo-target-*`; the system disk is
  chronically tight.
- **A slice that changes a shared contract must run the packages it does not
  own.** Mobile is the one nothing in this workflow touches, and it is exactly
  where the `workjetConfig` regression landed.
- **`docs/workjet-plan.md` is not prettier-clean** and was deliberately left that
  way by this audit: `vp check --fix` reindents every list-continuation line in a
  ~3 900-line document and would bury the audit diff. Fix it with item 4 above,
  on its own.
