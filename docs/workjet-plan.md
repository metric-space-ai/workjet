# Workjet master plan

Status date: 2026-08-16

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
- [x] Add a tracked dependency manifest with versions and checksums for CTOX
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
- [x] T3 adapter: expose active tools through T3's existing per-session MCP
      server.
  - [x] Register the first production adapter, Greppy search, with bearer-scope
        `tools/list` filtering, independent `tools/call` enforcement, effective
        session-cwd propagation, and Preview MCP regression coverage.
  - [x] Register the Web Stack `web_search` adapter with bearer grant
        `web-search`, independent direct-call enforcement, a bounded native JSON
        process boundary, and one server-wide state root at
        `<ServerConfig.stateDir>/web-stack`.
  - [x] Register the structured Web Stack browser prepare/automation adapter
        with bearer grant `web-stack-browser`, independent direct-call
        enforcement, exact native-surface probing, and a finite action AST that
        exposes no raw JavaScript, shell, path, environment, or secret fields.
- [x] CTOX adapter: expose the same capabilities through typed Business OS MCP
      while leaving validated business commands available for Business OS
      workflows.
- [x] Keep CTOX Business OS data on WebRTC; MCP remains a control and tool
      surface only.
- [x] Add adapter conformance tests proving the same manifest and JSON schemas
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
- [x] `web-search`: shared Web Stack search/read surface consumed by both the T3
      and CTOX MCP adapters.
  - [x] Ship the first Workjet/T3 search surface through the existing
        per-session MCP server; commit `20287044b` passes 19 focused TypeScript
        tests, the server typecheck, strict Rust Clippy, 450 Rust tests with 23
        ignored, four native boundary tests, and all 43 Web Stack fixture tests.
  - [x] Add the remaining bounded read and deep-research T3 surfaces. Commits
        `2ff4a6e39` and `ae9030701` add exact native surface probes, strict
        request decoding, canonical recursively closed output schemas,
        schema-driven response projection, capability-gated MCP registration,
        finite timeouts, and server-owned state. Independent gates pass with 57
        focused TypeScript tests, strict all-feature/all-target Clippy, 450 Rust
        library tests with 23 ignored, nine native boundary tests, and all 43
        Node fixture tests. The package/server typechecks still report only the
        already-known Workjet Effect diagnostics and remain a separate cleanup
        gate.
  - [x] Centralize all five Web Stack tool names, grants, descriptions,
        annotations, and recursively closed input/output schemas in one
        machine-readable contract. Commit `52f9fe82b` adds deterministic
        TypeScript generation and passes the byte-drift gate plus 33 focused
        manifest/registration tests; no host keeps a hand-maintained schema
        copy.
  - [x] Promote the finite decoder, browser action AST/compiler, execution,
        strict response projection, stable redacted errors, and host-controlled
        response budget into the product-neutral Rust library. Commit
        `c9fddb723` reduces the Workjet binary to a thin context/config transport
        and independently passes strict Clippy, 461 Rust tests with 23 ignored,
        and all 43 Node fixture tests.
- [ ] `web-stack-browser`: browser prepare/automation surface with explicit
      permissions.
  - [x] Ship the Workjet/T3 structured prepare and automation surface through
        the existing per-session MCP server. Commits `a4d294f3f` and
        `f9b972167` pass 39 focused TypeScript tests, both package typechecks,
        strict Rust Clippy, 450 Rust tests with 23 ignored, seven native
        boundary tests, and all 43 Web Stack fixture tests. Real installed-
        browser E2E remains open.
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
- [x] Remove the imported built-in Antigravity OAuth client credentials from
      the current portable source and require one typed, zeroizing,
      host-injected credential object for login and refresh.
  - [x] Rewrite every owned, unpublished import/product ref before the first
        push so the two former literals are absent from all reachable blobs and
        commit messages; a 65,388-object exact-literal scan is clean.
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
  - [x] Replace every current `native/pdf-parse/tests/fixtures/**` document/page
        artifact with original Workjet synthetic page-text contracts executable
        in ordinary CI without PDF binaries, downloads, or PDFium. This validates
        the fixture evaluator and linearization expectations only; it adds no PDF
        extraction, rendering, or visual E2E claim, and leaves `parity/**`
        unchanged under its documented LiteParse transposition boundary.
  - [x] Normalize the PDF parser strict all-target Clippy baseline so both the
        no-default and all-feature modes are green; algorithm parity and tests
        remain unchanged, with no PDF visual or extraction E2E coverage claim.
  - [x] Before public history, perform and independently verify the one-time Git
        history purge of the former imported PDF fixture corpus. No root-level
        legacy fixture object remains reachable; exactly one native-path commit
        restores the byte-identical synthetic tree.
- [x] Replace every current `native/web-stack/fixtures/sources/**` website/API
      snapshot with a minimal original synthetic Workjet fixture; parser tests
      now assert exact fictional records, reserved-domain contacts, metadata,
      optional branches, deduplication, and source-specific links.
  - [x] Before public history, perform and independently verify the one-time Git
        history purge of the former imported snapshots. No root-level legacy
        fixture object remains reachable; exactly one native-path commit restores
        the byte-identical synthetic tree.
- [x] Normalize the imported Web Stack's Rust 1.97 all-target Clippy baseline;
      commit `90dac51de` resolves all 64 pre-existing mechanical findings with
      only narrow, locally justified compatibility exceptions. Strict
      all-target Clippy and the 444-Rust/43-Node full-feature gate pass.
- [x] Replace direct CTOX SQLite configuration reads with the call-scoped,
      object-safe `RuntimeConfigStore` boundary. Commit `f0cf09ed8` keeps SQL
      knowledge inside the CTOX adapter and adds product-neutral context entry
      points without process-global or thread-local configuration.
- [x] Supply the SQL-free immutable `WorkjetRuntimeConfigStore` and the
      compatibility `CtoxRuntimeConfigStore`; adapter-conformance and
      concurrent-isolation tests pass with the 450-Rust/43-Node full gate.
  - [x] Bind the CTOX compatibility adapter to the one authoritative CTOX
        runtime-config store at `runtime/ctox-runtime.sqlite3`. Commit
        `8472d6847` proves that a conflicting value in the consolidated
        `runtime/ctox.sqlite3` core database is ignored and introduces no
        fallback, copying, synchronization, or second configuration authority.
- [x] Keep compatibility names for CTOX tool calls during migration while
      introducing product-neutral manifest IDs. Commits `52f9fe82b` and
      `c9fddb723` add the canonical five-tool contract and shared host API
      without removing legacy crate exports or CTOX CLI command names.
- [ ] Preserve SSRF protection, redirect validation, size limits, untrusted
      content fencing, cache bounds, evidence receipts, and legal/ToS controls.
- [ ] Keep browser dependencies and downloaded browsers under ignored `.deps`
      or runtime directories.
- [x] Expose the same search/read/deep-research/browser schemas through T3 MCP
      and CTOX's capability adapter.
  - [x] Expose the first product-neutral search schema through T3 MCP using the
        SQL-free `WorkjetRuntimeConfigStore`; no CTOX SQLite, thread, session,
        harness, or provider identifier enters its server state path.
  - [x] Expose the structured browser prepare/automation schema through T3 MCP
        with the same SQL-free store and server-wide Web Stack state root.
  - [x] Add the read and deep-research T3 surfaces with canonical input/output
        schemas and a strict native response projection.
  - [x] Make the canonical schemas and finite execution boundary consumable by
        both hosts through the shared package.
  - [x] Add the CTOX host adapter for search, read, deep research, and browser.
        CTOX commit `a2c422f56` consumes public Workjet revision `8726b9bf2`,
        preserves the WebRTC data plane, maps the five canonical tools onto
        channel plus server-authoritative Business OS policy, requires explicit
        confirmation for browser automation, and redacts raw arguments from
        audit metadata.
- [x] Prove both adapters against a shared fixture suite.
  - [x] Add the canonical adapter fixture and consume it from Rust unit and
        downstream-facing public API tests, including invalid controls,
        redaction canaries, finite browser actions, host budgets, and host-owned
        state assertions.
  - [x] Run the same fixture through the CTOX MCP registration, grants, policy,
        audit, and dispatch boundary. The focused CTOX gate passes all six
        adapter tests, `cargo check --bin ctox`, `rustfmt --check`, and
        `git diff --check`.
- [x] Change CTOX to consume the pinned Workjet Web Stack package.
- [ ] Remove the duplicate CTOX source only after parity.
  - [ ] Reconcile the still-divergent local and Workjet `ctox-pdf-parse` trees
        before collapsing Cargo's local and Git package instances; do not
        silently substitute one implementation for the other.

Mandatory gates include Rust tests and clippy, fixture/evidence tests, SSRF
tests, browser-preparation smoke, web-search E2E, web-unlock E2E, and the shared
adapter conformance suite.

## 8. Wave 5 — Workjet/T3 orchestration runtime

Goal: turn the stored role metadata into real local and remote orchestration.

- [ ] Add a radio-style `Code | Orchestrator` control without replacing the
      existing provider-specific Plan/Build control.
- [ ] Add a neighboring settings gear for Workjet configuration.
- [x] Compile deterministic Workjet role instructions through the existing
      managed-prompt path used by Codex, Claude Code, and Grok.
- [x] Keep user/developer instructions clearly separated from managed Workjet
      instructions.
- [x] Create the first same-environment worker thread through normal T3
      `thread.create` and `thread.turn.start` commands, exposed only through the
      orchestrator-scoped `workjet_dispatch_worker` MCP boundary.
- [ ] Store parent/child references and worker status as durable events.
- [ ] Add bounded dispatch, cancellation, retry, timeout, and result-return
      semantics.
- [ ] Treat worker completion as an event, not as a UI-only observation.
- [x] Support initial fire-and-forget worker dispatch in the same environment;
      completion, cancellation, retry, and remote coordination remain future work.
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
  - [x] Merge managed discovery with persisted invite and manual-pairing
        entries through one deterministic renderer-safe registry result; retain
        paired entries when the ctox.dev account is signed out or unavailable.
  - [ ] Add local-daemon and SSH-managed entries to the same registry result;
        do not introduce a second renderer-side registry or discovery store.
- [x] Port ctox.dev login, logout, cookie clearing, session-package discovery,
      launch-token exchange, and managed-instance refresh.
  - [x] Port authenticated session-package discovery behind an injected
        Electron-compatible fetch boundary with redacted typed failures.
  - [x] Own one dedicated persistent account/control-plane Electron session and
        deterministic isolated instance sessions; port bounded single-flight
        login, account-session refresh, scoped cookie/storage logout, and safe
        popup/navigation handling.
  - [x] Port the short-lived launch-token exchange for a selected managed
        ctox.dev instance without exposing the token to the renderer.
  - [x] Port the in-guest managed-capability retry: a parameterless, isolated
        preload event revalidates entitlement and consumes a fresh one-time
        launch contract without exposing it to the renderer.
- [ ] Port local-daemon, SSH-managed, invite, and manual-pairing sources.
  - [x] Port bounded invite and manual-pairing import, deterministic identity,
        expiry handling, duplicate updates, removal, and strict rejection of
        HTTP bridges or unsafe signaling URLs.
  - [x] Accept the canonical invite JSON and
        `ctox-business-os-desktop://pair?payload=...` shape emitted by the CTOX
        Rust service without widening the accepted schema to arbitrary links.
  - [x] Bind paired entries to the verified bundled Business OS shell and its
        native WebRTC launch context; registry presence alone is not a launch
        or data-plane claim.
  - [ ] Port local-daemon discovery, ownership, lifecycle, and launch.
  - [ ] Port SSH-managed discovery, attach/install/rotate/revoke, and launch.
- [ ] Reuse Workjet's Electron safe storage where possible; preserve platform
      keychain guarantees for room, capability, sudo, and SSH secrets.
  - [x] Store pairing room/capability secrets separately from public instance
        metadata using Electron Safe Storage; fail closed for unavailable,
        Linux `basic_text`, and unknown Linux storage backends.
  - [ ] Port the equivalent sudo and SSH credential handling and platform
        keychain runtime smokes before claiming complete secret-storage parity.
- [ ] Port host-key pinning and strict SSH command handling.
- [ ] Port deep-link parsing with explicit user confirmation.
- [ ] Port support-bundle redaction and crash-report metadata without secrets.
- [ ] Port permission denial, safe external navigation, launch-origin checks,
      secret scrubbing, and HTTP data/resource guards.
- [ ] Use Electron `WebContentsView`, matching Workjet's current guest-view
      architecture, rather than the deprecated CTOX `BrowserView` API.
  - [x] Use a sandboxed `WebContentsView` for the managed ctox.dev guest path.
- [x] Give each CTOX instance a stable isolated persistent session partition.
  - [x] Derive a collision-resistant Workjet-owned partition from the exact
        source and stable instance ID; reject server-provided partitions.
  - [x] Resolve and memoize the validated partitions through Electron with a
        default-deny permission policy and instance-scoped storage/cache wipe.
  - [x] Bind each managed instance's `WebContentsView`, navigation, and requests
        to its main-process-derived Electron session.
  - [x] Bind invite/manual-pairing guests to an equally isolated partition
        derived from the exact persisted paired source and stable ID.
- [x] Destroy or detach guest views cleanly on logout, access revocation,
      removal, mode change, and app shutdown.
  - [x] Detach and destroy the managed guest on replacement, logout, discovery
        removal/revocation, mode exit, and service shutdown.
  - [x] Detach and destroy the paired guest on replacement, pairing removal or
        expiry, mode exit, and service shutdown.
  - [x] Clear the removed paired instance's persistent Electron storage/cache
        after detaching its guest, without accepting a renderer-supplied
        partition; continue the guest/session cleanup even when public registry
        removal succeeded but encrypted-record cleanup reports a partial
        persistence failure.

### Business OS shell delivery

- [x] Keep Business OS source in the CTOX repository.
- [x] Publish a versioned Business OS shell artifact from CTOX releases.
- [x] Add a tracked Workjet manifest containing the shell version, source URL,
      and checksum.
- [x] Pin the detached release manifest, embedded inventory, archive bytes,
      expanded bytes, entry/file counts, path lengths, and individual file
      hashes before accepting release input.
- [x] Download development/build inputs to ignored `.deps/` through bounded,
      checksum-verifying extraction and atomic cache publication.
- [x] Revalidate cached metadata, entry budgets, exact inventory, file sizes,
      and file hashes before every cache hit or desktop package build.
- [x] Package the verified shell artifact into Workjet release output outside
      ASAR as the single `ctox-business-os-shell` resource.
- [x] Inject only the packed `ctox_config` launch context expected by the shell.
  - [x] Resolve pairing secrets only in the Electron main process, never expose
        them through renderer IPC, persistence, logs, or a durable launch URL.
  - [x] Serve only the verified static shell from a loopback/custom-protocol
        boundary with no Business OS HTTP data endpoints.
  - [x] Prove identical shell resolution for ignored development `.deps/` and
        packaged `process.resourcesPath` layouts.
  - [x] Require the exact pinned completion sentinel before the runtime serves
        a shell root, and send `Referrer-Policy: no-referrer` on every response.
- [ ] Never implement Business OS collection, command, file, or status reads
      over Workjet HTTP.

### Renderer

- [x] Add the top-left `Code | CTOX` product-mode switch.
- [x] Preserve the T3 project/thread sidebar in Code mode.
- [x] Add the persisted, Electron-only CTOX shell state with an explicit empty
      instance/main surface and no guest or alternate Business OS data path.
- [ ] Render CTOX instance groups, status, role, source, and last-used state in
      CTOX mode.
  - [x] Render the managed ctox.dev group with bounded status, role, source, and
        last-used metadata.
  - [x] Render separate deterministic Managed and Paired groups, including
        invite/manual source, role, expiry, removal, and non-launchable state.
  - [ ] Render populated Local and SSH groups after their main-process sources
        exist.
- [x] Selecting a managed ctox.dev instance activates its native guest surface
      in the main region.
- [x] Selecting a valid invite/manual-pairing instance activates the same guest
      surface through the local verified shell; expired, local, SSH, and forged
      entries remain non-launchable.
- [ ] Show signed-out, needs-auth, unavailable, connecting, ready, and revoked
      states explicitly.
- [ ] Keep CTOX Business OS chat inside the Business OS surface; do not convert
      it into a T3 thread.
- [ ] Provide instance management and refresh actions without exposing secrets.
  - [x] Provide managed login, logout, and refresh actions through typed IPC
        without exposing tenant IDs, partitions, cookies, or launch tokens.
  - [x] Provide invite/manual-pairing add and paired-instance removal through
        typed IPC; keep room/capability values out of discovery responses,
        renderer persistence, feedback copy, and launch URLs.
  - [ ] Provide local-daemon and SSH-managed lifecycle actions with the same
        renderer-secret boundary.
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
  - [x] Add a cross-platform `T3CODE_DESKTOP_APP_DATA_DIR` override so all
        app-managed `userData` resolution can target `/Volumes/tmp` without
        repurposing `HOME`.
  - [ ] Pass the same isolated path as Electron's startup
        `--user-data-dir=<root>/t3code` in the packaged-smoke launcher and
        assert it on child processes. A real packaged run proved that the GPU
        process may start before Workjet calls `app.setPath`, so the environment
        override alone is not a complete normal-profile isolation guarantee.
  - [x] Build a real unsigned macOS arm64 DMG and ZIP under `/Volumes/tmp` from
        the staged packaged layout. Omit `workspace:` dependencies from the
        staged server runtime manifest because those Workjet packages are
        already inlined in the server bundle; retain catalog dependency
        resolution and its focused regression test.
  - [ ] Make the isolated staged production install consume the repository's
        locked resolutions (or an equivalently pinned generated lock) instead
        of re-resolving package ranges from the network. The successful retry
        still resolved a newer `@anthropic-ai/claude-agent-sdk` than the root
        lock before Electron Builder ran.
  - [ ] Run the paired packaged-app smoke against the operator-selected real
        CTOX instance. Temporary Workjet profiles and invite files stay under
        `/Volumes/tmp`, but the smoke must not override `CTOX_ROOT`,
        `CTOX_STATE_ROOT`, or `CTOX_INSTALL_ROOT` to a synthetic empty instance.
  - [ ] Capture the browser peer ID only from the live WebRTC signaling
        handshake or another non-persistent runtime diagnostic, keep it out of
        logs/artifacts, and guarantee `peer unrevoke` before any later cleanup.
    - [ ] Add a bounded CTOX advanced-status field for the browser's own live
          signaling peer ID, populated only after the `init.yourPeerId`
          handshake and never persisted or logged. The packaged Electron
          `WebContentsView` changes renderer targets during navigation, so an
          external CDP listener attached at view creation cannot reliably
          observe that first frame; rejected smoke drafts must not replace this
          with a broad browser-target hook, synthetic CTOX roots, or durable
          test IPC.

Latest verified CTOX increment (Workjet commits `6f0fc627a`, `03a87bd70`,
`e00ebfa61`, `9047bed3f`, `042f8af38`, `d35d9ebbf`, `31fe2c70e`,
`483df6064`, `a640dad00`, `4dc74c432`, and `8672548b4`; CTOX shell commits `aa7d64c22`,
`967043561`, and `144f4ddef`): 100 focused CTOX/registry/IPC/guest/UI tests,
7 desktop-environment tests, 233 scripts tests, desktop/web/scripts typechecks,
36 focused desktop-artifact tests, formatting, and `git diff --check` pass.
The real `business-os-shell-v0.1.0-rc.1` release was downloaded, verified, and
revalidated from an ignored `.deps/` symlink backed by `/Volumes/tmp`; a real
runtime integration test served that release successfully on loopback. Workjet
now launches paired entries with main-process-only packed WebRTC config through
the pinned shell, while local/SSH and all Workjet HTTP data routes remain
disabled. The focused gate plus desktop typecheck proves targeted
guest detachment and main-derived partition cleanup, including the partial
registry-write failure path. This evidence does not yet cover a packaged
Electron guest observing the native CTOX peer, packaged ready/revoked
transitions or packaged partition deletion, local, SSH, or platform keychain
parity. The packaged test can now direct Workjet state and app-managed Electron
`userData` under `/Volumes/tmp`, and the real unsigned macOS arm64 DMG/ZIP now
build from the staged layout after removing bundled `workspace:` packages from
the staged production manifest. Live packaged pairing reached the real selected
CTOX instance without rewriting any CTOX root, but the external CDP capture
stayed attached to Electron's pre-navigation target and could not observe the
guest's first signaling frame. Those smoke drafts were removed rather than
claiming revoke/recovery coverage. The run also proved that Electron's early GPU
process needs an explicit `--user-data-dir` in addition to the app-level
environment override. An earlier draft that pointed CTOX roots at a synthetic
empty instance remains explicitly rejected. Independent Kimi review remains
deferred because the required review provider is unavailable; adversarial
self-review additionally caught and fixed cleanup being skipped after a partial
registry removal.

## 11. Wave 8 — retire the standalone CTOX Desktop project

This wave happens in the separate CTOX repository and only after the Workjet
parity gate is green.

- [x] Start from a clean CTOX branch; do not mix or overwrite unrelated current
      CTOX working-tree changes.
- [ ] Remove `src/apps/business-os-desktop`.
- [ ] Remove its separate packaging/release workflow and download links.
- [ ] Point CTOX documentation to the Workjet Desktop application.
- [x] Keep the CTOX Business OS shell build and versioned shell artifact.
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

- [x] Keep `upstream/main` configured and fetch it regularly.
- [ ] Maintain a short, ordered Workjet patch stack: contracts, orchestration,
      capabilities, provider integration, CTOX services, shell UI, branding.
- [ ] Prefer additive files and adapters over invasive rewrites of T3 core.
- [ ] Avoid changing internal T3 identifiers that are not user-visible.
- [ ] Rebase or merge upstream at the end of every completed wave and run the
      affected regression suite.
- [x] Track conflicts and recurring upstream hot spots in this document.
  - [ ] Reconnect sanitized Workjet baseline `39d3a27d3` to its tree-identical
        public T3 baseline `6ae44b418` before a normal merge or pull request;
        the current 225-commit downstream stack has no Git ancestry link.
  - [ ] Reconcile the Workjet patch stack with refreshed `upstream/main`
        `d484735c6` and record recurring conflicts after the first replay.
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
4. [x] Port ctox.dev instance discovery and session isolation into typed Electron
       services.
   - [x] Land typed renderer contracts, session-package discovery, redacted
         failures, and deterministic partition derivation.
   - [x] Wire Electron session ownership, cookies, login/logout, and refresh.
5. [x] Prepare tree-verified, history-preserving local import branches for
       CLIProxyAPI Rust and Web Stack.
6. [x] Apply the dual-license policy and provenance inventory while importing
       CTOX-owned code.
7. [x] Land the first real local orchestrator → worker flow.
8. [x] Land one managed CTOX instance → Business OS WebRTC launch flow.
9. [x] Land the shared managed + invite/manual-pairing registry, encrypted
       pairing-secret store, and paired-instance management UI.
10. [x] Publish and pin the versioned CTOX Business OS shell artifact, download
        it into ignored `.deps/`, and package only the checksum-verified artifact.
11. [x] Launch invite/manual-pairing entries through that shell using only the
        native packed `ctox_config` WebRTC context.
12. [ ] Run the packaged Electron paired-guest smoke against a real native CTOX
        peer and verify ready/revoked transitions plus the now-implemented
        partition cleanup in packaged runtime behavior.
    - [x] Add the app-level packaged Workjet state and Electron `userData`
          override beneath an explicit `/Volumes/tmp` root without changing
          `HOME`.
    - [ ] Add the matching Electron startup `--user-data-dir` argument so even
          pre-`app.setPath` GPU/network initialization is isolated, then assert
          every packaged child process stays under the disposable profile.
    - [x] Keep the real CTOX instance selection intact; do not point CTOX roots
          at the disposable Workjet smoke profile.
    - [ ] Expose the browser's handshake-assigned peer ID through a bounded,
          non-persistent CTOX advanced-status diagnostic; external CDP capture
          does not survive the packaged WebContentsView's navigation target
          swap reliably.
    - [ ] Capture that ephemeral peer ID in memory, prove native revoke,
          guaranteed-first unrevoke, healthy recovery, pairing removal, and
          same-partition cookie/localStorage/CacheStorage deletion, and leave no
          revocation behind on any failure or signal path.
    - [x] Build the real unsigned macOS arm64 DMG and ZIP under `/Volumes/tmp`
          from the packaged staging layout.
    - [ ] Pin the staged production dependency install to repository lock
          resolutions before treating packaged builds as reproducible/offline.
13. [ ] Port local-daemon and SSH-managed sources after the paired shell path is
        green, retaining one registry and one renderer-secret boundary.
14. [ ] Complete durable local orchestration semantics, then add authenticated
        cross-environment dispatch and recovery.
