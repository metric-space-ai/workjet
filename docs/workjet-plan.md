# Workjet master plan

Status date: 2026-08-15

Canonical repository: `metric-space-ai/workjet`

Upstream repository: `pingdotgg/t3code`

This document is the executable plan for turning the T3 Code fork into
Workjet: one desktop application with a Code mode and a CTOX mode, native
Workjet orchestration, shared skills and tools, and a shared Rust codebase for
provider access and the Web Stack.

## 1. Product contract

Workjet is one desktop application with two distinct modes.

### Code mode

- Retains T3 projects, environments, threads, turns, terminals, previews, Git,
  and remote-worker management.
- Supports Codex, Claude Code, Grok, and the existing T3 provider-driver model.
- Adds native `standard`, `orchestrator`, and `worker` thread roles.
- Treats sub-agents as ordinary local or remote T3 threads with an explicit
  parent reference.
- Keeps direct provider/model selection available for every thread.
- Adds per-thread Greppy, Web Stack, web-search, and future skill/tool toggles.

### CTOX mode

- Shows the CTOX instances available to the operator in the left sidebar.
- Supports ctox.dev managed instances plus the existing local, SSH, invite, and
  manual-pairing connection paths.
- Shows the selected instance's complete CTOX Business OS, including its chat,
  inside the main application surface.
- Leaves Business OS records, commands, files, policy, and orchestration under
  the authority of the selected CTOX instance.
- Keeps the CTOX Sync Engine WebRTC data plane unchanged. Workjet must not add
  an HTTP data bridge or fallback.

### Shared, not merged

The two modes share source packages and desktop infrastructure. They do not
share runtime state.

- Every closed CTOX instance runs its own CLI-proxy Rust runtime and owns its
  own provider credentials, pools, cooldowns, and routing state.
- Workjet/T3 runs a different CLI-proxy runtime for all harnesses connected to
  that T3 runtime.
- A CTOX instance is not a T3 harness.
- CLI-proxy Rust and Web Stack have one canonical maintained source base used
  by both products.
- Workjet/T3 uses exactly one Greppy store per server environment at
  `<ServerConfig.stateDir>/greppy`. All local threads and harnesses share it;
  thread, provider-session, harness, and provider-instance IDs must never be
  components of that path. Each remote T3 server naturally owns its own local
  store, while CTOX instance state remains separate.
- T3 and CTOX keep separate event/state machines and persistence.

## 2. Repository and source policy

- [x] Fork T3 Code into the `metric-space-ai` organization.
- [x] Rename the repository and desktop product to `workjet` / Workjet.
- [x] Keep `origin` on `metric-space-ai/workjet` and `upstream` on
      `pingdotgg/t3code`.
- [x] Work on an isolated `codex/` feature branch.
- [x] Ignore dependency, cache, build, runtime, database, and agent-worktree
      directories, including `.dev`, `.dep`, `.deps`, `.cache`, `.vite-plus`,
      `node_modules`, build output, and local runtime state.
- [ ] Add a tracked dependency manifest with versions and checksums for CTOX
      shell/release inputs; downloaded content stays under ignored `.deps/`.
- [x] Add a source provenance and license inventory for T3, CTOX Desktop,
      CLIProxyAPI, Greppy, and the Web Stack in
      `docs/workjet-source-provenance.md`.
- [ ] Keep upstream-compatible T3 changes in narrow commits. Do not perform a
      repository-wide internal rename from `t3code` to `workjet` unless required
      for a public product identifier.

Only source, tests, migrations, required configuration, lockfiles, provenance,
and documentation belong in Git.

## 3. Target runtime topology

```text
Workjet Desktop
├── Workjet application shell
│   ├── Code mode renderer
│   └── CTOX mode instance switcher + Business OS guest
├── Workjet/T3 server
│   ├── T3 thread and workspace authority
│   ├── Workjet orchestration coordinator
│   ├── per-session T3 MCP server
│   └── one Workjet provider-gateway runtime for all T3 harnesses
└── shared source packages
    ├── provider-gateway (Rust CLIProxyAPI port)
    ├── web-stack (Rust)
    └── capability registry + host adapters

Closed CTOX instance A                 Closed CTOX instance B
├── CTOX daemon                        ├── CTOX daemon
├── Business OS authority              ├── Business OS authority
├── its own provider-gateway runtime   ├── its own provider-gateway runtime
└── shared Web Stack package           └── shared Web Stack package
```

The Workjet Desktop may connect to multiple CTOX instances, but it does not
become their provider proxy or database authority.

## 4. Wave 1 — native Workjet thread domain

Goal: add backward-compatible orchestration metadata before changing the UI or
launching workers.

- [x] Add `packages/contracts/src/workjet.ts` with Effect Schema contracts.
- [x] Define role values exactly as `standard | orchestrator | worker`.
- [x] Define a parent reference containing `environmentId` and `threadId`.
- [x] Define a versioned thread configuration with managed instructions and
      enabled capability IDs.
- [x] Start with `greppy` and `web-search` capability IDs.
- [x] Require a parent for workers and forbid a parent for standard and
      orchestrator threads.
- [x] Decode historical threads to the canonical standard configuration.
- [x] Add a dedicated command/event pair for replacing configuration.
- [x] Update decider, server projector, projection pipeline, snapshot query,
      and client reducer.
- [x] Add migration `041` with one typed JSON column in `projection_threads`.
- [x] Add focused contract, decider, projector, migration, snapshot, and reducer
      tests.

Acceptance:

```sh
./node_modules/.bin/vp test run \
  packages/contracts/src/workjet.test.ts \
  apps/server/src/orchestration/decider.workjet.test.ts \
  apps/server/src/orchestration/projector.workjet.test.ts \
  apps/server/src/orchestration/Layers/ProjectionPipeline.workjet.test.ts \
  apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.workjet.test.ts \
  apps/server/src/persistence/Migrations/041_ProjectionThreadsWorkjetConfig.test.ts \
  packages/client-runtime/src/state/threadReducer.workjet.test.ts
./node_modules/.bin/vp run --filter @t3tools/contracts typecheck
./node_modules/.bin/vp run --filter t3 typecheck
./node_modules/.bin/vp run --filter @t3tools/client-runtime typecheck
```

## 5. Wave 2 — capability registry, skills, and tools

Goal: define a capability once and expose it through the correct adapter in
both modes.

### Registry contract

- [x] Add a versioned capability manifest with stable ID, version, metadata,
      prompt contribution, permission requirements, secret requirements, input
      schema, output schema, and supported adapters.
- [x] Separate availability from activation. A capability may be installed but
      disabled for a specific thread or CTOX instance.
- [x] Make activation explicit and auditable.
- [x] Reject unknown or incompatible capability versions with typed errors.
- [x] Keep secrets as references; never put secret values in manifests, thread
      events, browser storage, logs, or instance registries.
- [x] Provide one host-neutral built-in registry with exact-version resolution,
      adapter filtering, and deterministic managed prompt compilation.

### Host adapters

- [x] Project each thread's current Workjet configuration into provider session
      start/restart and recovery, resolve T3 MCP and prompt adapters separately,
      and keep active capability grants distinct from preview authorization.
- [x] Persist the effective Workjet configuration in provider runtime bindings,
      preserve it across runtime-payload updates and active-session adoption,
      and fall back safely for absent or malformed historical payloads.
- [x] Compile each thread's active prompt contributions into the native Codex
      developer-instructions and Claude Code system-prompt boundaries, plus a
      fingerprinted recovery-safe first-prompt adapter for Grok ACP.
- [ ] T3 adapter: expose active tools through T3's existing per-session MCP
      server.
  - [x] Register the first production adapter, Greppy search, with bearer-scope
        `tools/list` filtering, independent `tools/call` enforcement, effective
        session-cwd propagation, and Preview MCP regression coverage.
- [ ] CTOX adapter: expose the same capabilities through typed Business OS MCP
      and/or validated CTOX business commands.
- [ ] Keep CTOX Business OS data on WebRTC; MCP remains a control and tool
      surface only.
- [ ] Add adapter conformance tests proving the same manifest and JSON schemas
      are visible from T3 and CTOX.

### First capabilities

- [x] `greppy`: managed external binary with controlled store/runtime paths,
      health checks, redacted errors, and enable/disable state.
  - [x] Implement the bounded Greppy 0.3.1 search boundary with exact
        version/surface checks, stable-schema parsing, safe typed failures, and
        one server-wide shared store for every T3 thread and harness.
  - [x] Implement the server-side managed Greppy installation and index
        lifecycle: immutable source/model checksums, CPU-only Rust 1.95 build,
        transactional activation, bounded health probes, canonical-workspace
        indexing, and per-workspace single-flight refreshes.
  - [x] Keep externally administered 0.3.1 runtimes usable when managed source
        installation is unsupported, including Windows `greppy.exe`, and
        normalize legacy `file`/`line` search aliases to the canonical schema.
  - [x] Expose managed install, repair, and health state through the Workjet
        settings surface; keep activation controlled by each thread's Greppy
        toggle while every activated thread uses the same server store.
  - [x] Add the per-thread Greppy activation toggle to the Code composer/thread
        settings without creating thread-, session-, harness-, or provider-scoped
        stores.
- [ ] `web-search`: shared Web Stack search/read surface.
- [ ] `web-stack-browser`: browser prepare/automation surface with explicit
      permissions.
- [ ] Add room for later capabilities without changing thread-role contracts.

## 6. Wave 3 — move the CLIProxyAPI Rust port

Current source:
`ctox/src/core/execution/cliproxyapi`

Current evidence: the CTOX port ledger marks portable Track A complete at the
accepted upstream pin, with 617/617 production files, 442/442 test files, and
10/10 release gates.

Target ownership:

- Workjet owns the canonical portable Rust package and upstream-port ledger.
- CTOX keeps only its product adapter, Business OS projections, and local secret
  store integration.
- Both products build the same tagged provider-gateway source.

Tasks:

- [x] Freeze and record the accepted CLIProxyAPI upstream pin, CTOX source
      commit, subtree object, upstream MIT license, and accepted receipt digest
      in `docs/workjet-source-provenance.md`.
- [x] Import the portable crate with file history where practical.
  - [x] Prepare and tree-verify local branch
        `codex/import-provider-gateway` with the two reachable component
        commits.
  - [x] Merge the prepared history under `native/provider-gateway/` without
        changing its verified source tree.
- [x] Place the canonical crate under `native/provider-gateway/`.
- [x] Rename the public package/binary from CTOX-specific names to Workjet
      provider-gateway names while retaining compatibility aliases for migration.
- [x] Preserve origin and per-file license headers.
- [ ] Keep provider-neutral Track A separate from host adapters.
- [ ] Move or recreate the conformance fixtures, differential runner, port map,
      and porting ledger.
- [ ] Add a Workjet/T3 host adapter using Workjet's secret storage and lifecycle.
- [ ] Route Codex, Claude Code, Grok, and other T3 provider drivers to the one
      Workjet/T3 gateway runtime.
- [ ] Preserve direct provider/model selection in the composer; selection
      chooses a gateway route/profile rather than bypassing the gateway.
- [ ] Add a CTOX dependency on a pinned Workjet provider-gateway release/tag.
- [ ] Keep one gateway runtime inside every CTOX instance with CTOX-local
      credentials and state.
- [ ] Remove the portable duplicate from CTOX only after its pinned dependency
      passes CTOX provider and Business OS tests.
- [ ] Add release artifacts for macOS arm64/x64, Linux x64/arm64, and Windows
      x64/arm64 as required by Workjet and CTOX packaging.

Mandatory regression gates:

```sh
cargo test -p workjet-provider-gateway
cargo clippy -p workjet-provider-gateway --all-targets -- -D warnings
cargo fmt --check --manifest-path native/provider-gateway/Cargo.toml
```

Provider acceptance must cover subscription login/refresh, account pools,
weights, cooldowns, model discovery, OpenAI Responses, Chat Completions,
Anthropic Messages, Gemini/Antigravity translations, streaming, redaction,
management authentication, and process lifecycle.

## 7. Wave 4 — move and generalize the Web Stack

Current source: `ctox/src/tools/web-stack`

Target ownership: Workjet owns one product-neutral Web Stack source package;
CTOX and the T3 harness adapter consume the same tagged package.

- [x] Freeze the CTOX source commit and current Web Stack test evidence.
  - [x] Record the source commit and subtree object in
        `docs/workjet-source-provenance.md`.
  - [x] Capture a fresh full-feature Web Stack gate against the frozen source
        trees after import; add only the required CommonJS package boundary for
        Workjet's ESM repository root.
- [x] Move the crate to `native/web-stack/` with source history where practical.
  - [x] Prepare and tree-verify local branch `codex/import-web-stack` with 130
        reachable component commits.
  - [x] Merge the prepared history under `native/web-stack/` without changing
        its verified source tree.
- [x] Move or externalize the optional PDF parser dependency required by the
      `full` feature.
  - [x] Import the exact frozen parser tree under `native/pdf-parse/` through
        history branch `codex/import-pdf-parse` and verify all six reachable
        component commits.
- [ ] Normalize the imported Web Stack's Rust 1.97 all-target Clippy baseline;
      the first strict run reports 64 pre-existing mechanical findings without
      any global lint suppression.
- [ ] Replace direct CTOX SQLite configuration reads with a small injected
      configuration/store trait.
- [ ] Supply a Workjet/T3 adapter and a CTOX runtime-config adapter.
- [ ] Keep compatibility names for CTOX tool calls during migration while
      introducing product-neutral manifest IDs.
- [ ] Preserve SSRF protection, redirect validation, size limits, untrusted
      content fencing, cache bounds, evidence receipts, and legal/ToS controls.
- [ ] Keep browser dependencies and downloaded browsers under ignored `.deps`
      or runtime directories.
- [ ] Expose the same search/read/deep-research/browser schemas through T3 MCP
      and CTOX's capability adapter.
- [ ] Prove both adapters against a shared fixture suite.
- [ ] Change CTOX to consume the pinned Workjet Web Stack package.
- [ ] Remove the duplicate CTOX source only after parity.

Mandatory gates include Rust tests and clippy, fixture/evidence tests, SSRF
tests, browser-preparation smoke, web-search E2E, web-unlock E2E, and the shared
adapter conformance suite.

## 8. Wave 5 — Workjet/T3 orchestration runtime

Goal: turn the stored role metadata into real local and remote orchestration.

- [ ] Add a radio-style `Code | Orchestrator` control without replacing the
      existing provider-specific Plan/Build control.
- [ ] Add a neighboring settings gear for Workjet configuration.
- [ ] Compile the Workjet managed system prompt for Codex, Claude Code, Grok,
      and other enabled drivers through their supported prompt/rules mechanism.
- [ ] Keep user/developer instructions clearly separated from managed Workjet
      instructions.
- [ ] Create worker threads through normal T3 commands.
- [ ] Store parent/child references and worker status as durable events.
- [ ] Add bounded dispatch, cancellation, retry, timeout, and result-return
      semantics.
- [ ] Treat worker completion as an event, not as a UI-only observation.
- [ ] Support workers in the same environment first.
- [ ] Add cross-environment dispatch only after a durable server-to-server
      coordinator exists; current client-only federation is insufficient.
- [ ] Never copy the old Swift SSH/snapshot remote protocol into T3. T3 remains
      the workspace and remote-environment authority.
- [ ] Preserve direct activation of LLM/provider combinations on orchestrator
      and worker threads.

Abuse and reliability tests must cover duplicate dispatch, stale parent,
deleted worker, server restart, network loss, cancellation race, terminal
failure, remote version skew, and unauthorized cross-environment control.

## 9. Wave 6 — Workjet application identity

- [ ] Change the user-facing desktop name, About panel, package metadata,
      installer names, app icons, update channel, and release filenames to Workjet.
- [ ] Introduce `workjet:` and `workjet-dev:` protocol schemes.
- [ ] Keep safe one-time migration support for existing T3 Code desktop links
      and user data where useful.
- [ ] Use a distinct Workjet user-data directory; import legacy settings only
      through an explicit, tested migration.
- [ ] Keep internal `@t3tools/*` package names where changing them adds only
      upstream merge cost.
- [ ] Update visible copy without rewriting unrelated historical comments,
      storage keys, or contracts.
- [ ] Add new Workjet brand assets only after the shell and behavior are stable.

## 10. Wave 7 — port CTOX Desktop into Workjet

Current source: `ctox/src/apps/business-os-desktop`

The existing CTOX Desktop is not copied wholesale as a second Electron app. Its
capabilities are ported into Workjet's typed Effect/Electron architecture.

### Main-process services

- [ ] Port the instance model, registry normalization, and source merge/sort.
  - [x] Add renderer-safe typed managed-instance contracts, bounded metadata,
        duplicate rejection, and deterministic ctox.dev sorting.
  - [ ] Merge local, SSH, invite, and pairing sources through the shared
        registry.
- [ ] Port ctox.dev login, logout, cookie clearing, session-package discovery,
      launch-token exchange, and managed-instance refresh.
  - [x] Port authenticated session-package discovery behind an injected
        Electron-compatible fetch boundary with redacted typed failures.
  - [x] Own one dedicated persistent account/control-plane Electron session and
        deterministic isolated instance sessions; port bounded single-flight
        login, account-session refresh, scoped cookie/storage logout, and safe
        popup/navigation handling.
  - [ ] Port short-lived launch-token exchange and rotation.
- [ ] Port local-daemon, SSH-managed, invite, and manual-pairing sources.
- [ ] Reuse Workjet's Electron safe storage where possible; preserve platform
      keychain guarantees for room, capability, sudo, and SSH secrets.
- [ ] Port host-key pinning and strict SSH command handling.
- [ ] Port deep-link parsing with explicit user confirmation.
- [ ] Port support-bundle redaction and crash-report metadata without secrets.
- [ ] Port permission denial, safe external navigation, launch-origin checks,
      secret scrubbing, and HTTP data/resource guards.
- [ ] Use Electron `WebContentsView`, matching Workjet's current guest-view
      architecture, rather than the deprecated CTOX `BrowserView` API.
- [ ] Give each CTOX instance a stable isolated persistent session partition.
  - [x] Derive a collision-resistant Workjet-owned partition from the exact
        source and stable instance ID; reject server-provided partitions.
  - [x] Resolve and memoize the validated partitions through Electron with a
        default-deny permission policy and instance-scoped storage/cache wipe.
  - [ ] Bind each instance's `WebContentsView` and requests to its derived
        Electron session.
- [ ] Destroy or detach guest views cleanly on logout, access revocation,
      removal, mode change, and app shutdown.

### Business OS shell delivery

- [ ] Keep Business OS source in the CTOX repository.
- [ ] Publish a versioned Business OS shell artifact from CTOX releases.
- [ ] Add a tracked Workjet manifest containing the shell version, source URL,
      and checksum.
- [ ] Download development/build inputs to ignored `.deps/`.
- [ ] Package the verified shell artifact into Workjet release output.
- [ ] Inject only the packed `ctox_config` launch context expected by the shell.
- [ ] Never implement Business OS collection, command, file, or status reads
      over Workjet HTTP.

### Renderer

- [x] Add the top-left `Code | CTOX` product-mode switch.
- [x] Preserve the T3 project/thread sidebar in Code mode.
- [x] Add the persisted, Electron-only CTOX shell state with an explicit empty
      instance/main surface and no guest or alternate Business OS data path.
- [ ] Render CTOX instance groups, status, role, source, and last-used state in
      CTOX mode.
- [ ] Selecting an instance activates its guest surface in the main region.
- [ ] Show signed-out, needs-auth, unavailable, connecting, ready, and revoked
      states explicitly.
- [ ] Keep CTOX Business OS chat inside the Business OS surface; do not convert
      it into a T3 thread.
- [ ] Provide instance management and refresh actions without exposing secrets.
- [ ] Ensure keyboard shortcuts and zoom target the active Workjet surface
      intentionally.

### Parity gate before CTOX removal

Workjet must pass equivalents of all current CTOX Desktop checks:

- unit and syntax/type checks;
- Electron session-isolation smoke;
- deep-link/protocol smoke;
- renderer badge/instance-list smoke;
- ctox.dev login and session-rotation smoke;
- access-revocation smoke;
- HTTP-data-guard smoke;
- platform-keychain runtime smoke;
- local daemon and bundled-runtime smoke;
- SSH password, host-key, attach, install, rotate, and revoke smokes;
- packaged-app and signed-artifact smokes on supported platforms.

## 11. Wave 8 — retire the standalone CTOX Desktop project

This wave happens in the separate CTOX repository and only after the Workjet
parity gate is green.

- [ ] Start from a clean CTOX branch; do not mix or overwrite unrelated current
      CTOX working-tree changes.
- [ ] Remove `src/apps/business-os-desktop`.
- [ ] Remove its separate packaging/release workflow and download links.
- [ ] Point CTOX documentation to the Workjet Desktop application.
- [ ] Keep the CTOX Business OS shell build and versioned shell artifact.
- [ ] Keep CTOX daemon, Sync Engine, Business OS, MCP channel, provider adapter,
      and Web Stack adapter.
- [ ] Update release smoke tests so CTOX validates the artifacts consumed by
      Workjet instead of building another Electron application.
- [ ] Verify local, managed, SSH, and invite workflows from Workjet against the
      new CTOX commit before merging the deletion.

## 12. Security invariants

- [ ] No Business OS HTTP data bridge or fallback.
- [ ] No raw provider, pairing, capability, sudo, or SSH secrets in Git,
      browser storage, thread events, instance registries, logs, crash reports, or
      support bundles.
- [ ] Separate Electron session partitions for CTOX instances.
- [ ] Default-deny guest permissions; explicitly allow only required safe
      capabilities.
- [ ] Deny untrusted guest navigation and window creation; open validated
      external URLs through the OS.
- [ ] Pin managed launch-config requests to the authenticated ctox.dev origin.
- [ ] Require confirmation for external pairing and instance-switch links.
- [ ] Preserve Web Stack SSRF, redirect, content-size, and untrusted-content
      defenses.
- [ ] Scope T3 MCP tools to the current session/thread and capability grants.
- [ ] Authenticate remote worker dispatch and prevent cross-environment
      authority escalation.
- [ ] Redact provider traffic metadata and never log request bodies by default.

## 13. Licensing policy and release gate

T3 Code is MIT. CTOX-owned components shared with Workjet are authorized under
`MIT OR AGPL-3.0-only`; CTOX itself may remain AGPL-3.0-only. The combined
distribution must not silently change third-party headers or make unsupported
licensing claims.

- [x] Adopt `MIT OR AGPL-3.0-only` for CTOX-owned Desktop/provider/Web Stack
      code shared with Workjet.
- [x] Keep the T3-derived Workjet application under MIT by selecting the MIT
      option for dual-licensed CTOX-owned components in Workjet releases.
- [x] Add the dual SPDX expression only to files Metric Space AI owns or
      controls; do not relicense third-party contributions implicitly.
- [ ] Preserve the T3 MIT copyright and license notices.
- [x] Preserve CLIProxyAPI upstream MIT provenance and the license applicable to
      the Rust-port modifications.
- [ ] Preserve Greppy Apache-2.0 notices.
- [ ] Generate a release NOTICE/source-offer inventory.
- [ ] Review Electron guest-shell packaging and network-use obligations before
      the first public binary.

The license choice is closed. Completing file-level provenance, headers, and
generated notices remains a release gate.

## 14. Upstream maintenance strategy

- [ ] Keep `upstream/main` configured and fetch it regularly.
- [ ] Maintain a short, ordered Workjet patch stack: contracts, orchestration,
      capabilities, provider integration, CTOX services, shell UI, branding.
- [ ] Prefer additive files and adapters over invasive rewrites of T3 core.
- [ ] Avoid changing internal T3 identifiers that are not user-visible.
- [ ] Rebase or merge upstream at the end of every completed wave and run the
      affected regression suite.
- [ ] Track conflicts and recurring upstream hot spots in this document.
- [ ] Contribute generally useful, non-Workjet-specific fixes upstream where
      practical.
- [ ] Never commit `.deps`, build output, local databases, credentials, or
      generated agent worktrees.

## 15. Test and release matrix

Every wave uses targeted tests while developing. Before a public Workjet beta:

- [ ] Full contracts, server, client-runtime, web, and desktop typecheck.
- [ ] Full relevant T3 test suites.
- [ ] Provider-gateway Rust test, clippy, fmt, differential, and real-account
      opt-in gates.
- [ ] Web Stack Rust, fixture, SSRF, search, browser, and E2E gates.
- [ ] Workjet orchestration restart, cancellation, duplicate, and remote tests.
- [ ] CTOX WebRTC data-plane guard and Business OS launch tests.
- [ ] Desktop managed/local/SSH/invite/session/keychain parity matrix.
- [ ] Real end-to-end user stories for Code mode and CTOX mode.
- [ ] Packaged macOS arm64 and x64 tests first; then Linux and Windows targets.
- [ ] Signing, notarization, update, checksum, and provenance verification.
- [ ] Fresh-install, upgrade, rollback, and legacy-settings import tests.
- [ ] No tracked dependency/build/runtime artifacts.

Representative Code-mode E2E:

1. Open a project.
2. Create an orchestrator thread.
3. Enable Greppy and Web Stack.
4. Select a provider/model routed through the local Workjet/T3 gateway.
5. Dispatch a worker thread locally and another on a configured remote T3
   environment.
6. Observe durable status, cancellation, result return, and restart recovery.

Representative CTOX-mode E2E:

1. Sign in to ctox.dev.
2. See only authorized instances.
3. Select an instance and consume a short-lived launch config.
4. Load the bundled Business OS shell.
5. Establish WebRTC replication without an HTTP data route.
6. Use the same Web Stack capability version as Code mode through the CTOX
   adapter.
7. Verify the selected closed CTOX instance uses its own provider-gateway
   runtime and credentials.
8. Revoke access and verify the guest is destroyed and relaunch is blocked.

## 16. Delivery milestones

### M1 — foundation

- Workjet repository, branch, ignore policy, architecture, and native thread
  configuration are green.

### M2 — shared capabilities

- Capability registry, Greppy adapter, and shared Web Stack work in a local T3
  thread with no CTOX changes yet.

### M3 — shared provider source

- Workjet/T3 harnesses use one local gateway runtime from the moved Rust source;
  CTOX consumes the same source in a separate instance-local runtime.

### M4 — local orchestration

- Orchestrator radio control, settings, prompt compiler, worker threads, and
  local dispatch are complete.

### M5 — remote orchestration

- Durable authenticated cross-environment worker dispatch and recovery are
  complete.

### M6 — CTOX mode beta

- Workjet lists managed/local/SSH/invite instances and embeds the selected
  Business OS over the existing WebRTC data plane.

### M7 — one desktop application

- Workjet passes CTOX Desktop parity, signed release evidence, and Code/CTOX
  E2E; the standalone CTOX Electron app is removed from the CTOX repository.

### M8 — public release

- Licensing, security, updater, migration, provenance, and supported-platform
  gates are closed; the Workjet branch is pushed and released.

## 17. Definition of done

Workjet is complete only when all of the following are true:

- One installed Workjet app switches cleanly between Code and CTOX modes.
- Code mode retains upstream T3 behavior and adds durable native Workjet
  orchestration without a Swift runtime dependency.
- Codex, Claude Code, Grok, and other enabled harnesses use the Workjet/T3
  provider-gateway runtime while retaining direct model selection.
- Each CTOX instance remains closed and uses its own gateway runtime from the
  same maintained Rust codebase.
- Greppy and Web Stack use one maintained implementation and can be enabled in
  both modes through their respective adapters.
- Managed and unmanaged CTOX instances launch the full Business OS through the
  unchanged WebRTC data plane.
- The standalone CTOX Desktop project is gone, but the CTOX server/Business OS
  project remains independent.
- The fork can absorb upstream T3 updates with a bounded patch stack.
- All security, license, E2E, packaging, signing, and artifact-hygiene gates are
  green.

## 18. Immediate execution queue

1. [x] Finish and verify Wave 1 thread-domain implementation.
2. [x] Add the minimal capability-registry contract and prompt adapter interface.
3. [x] Build the Code/CTOX product-mode shell state without yet loading a guest.
4. [ ] Port ctox.dev instance discovery and session isolation into typed Electron
       services.
   - [x] Land typed renderer contracts, session-package discovery, redacted
         failures, and deterministic partition derivation.
   - [x] Wire Electron session ownership, cookies, login/logout, and refresh.
5. [x] Prepare tree-verified, history-preserving local import branches for
       CLIProxyAPI Rust and Web Stack.
6. [x] Apply the dual-license policy and provenance inventory while importing
       CTOX-owned code.
7. [ ] Land the first real local orchestrator → worker flow.
8. [ ] Land one managed CTOX instance → Business OS WebRTC launch flow.
