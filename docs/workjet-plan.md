# CTOX Desktop App — implementation plan

Status date: 2026-08-17

Checklist progress: 57.8% (`192/332` complete, `140` open).

Current repository: `metric-space-ai/workjet`

Target desktop repository: `metric-space-ai/ctox-desktop-app`

Upstream repository: `pingdotgg/t3code`

This document is the executable plan for the separate CTOX Desktop App. The
application combines a T3-derived Code tool with a Business OS client while
keeping CTOX itself independently deployable and fully operational without the
desktop application. `Workjet` is the internal orchestration subsystem used by
Code mode, not the desktop product name.

## 1. Product contract

CTOX Desktop App is one Electron client with two equal, mutually exclusive
product modes. The persistent top-left control is labelled exactly
`Code | Business OS`; switching modes replaces both the sidebar and the main
surface rather than mounting one mode over the other.

### Code mode

- Retains T3 projects, environments, threads, turns, terminals, previews, Git,
  and remote-worker management.
- Supports Codex, Claude Code, Grok, and the existing T3 provider-driver model.
- Adds native `standard`, `orchestrator`, and `worker` thread roles.
- Treats sub-agents as ordinary local or remote T3 threads with an explicit
  parent reference.
- Keeps direct provider/model selection available for every thread.
- Adds per-thread Greppy, Web Stack, web-search, and future skill/tool toggles.

### Business OS mode

- Shows the CTOX instances available to the operator in the left sidebar.
- Supports ctox.dev managed instances plus the existing local, SSH, invite, and
  manual-pairing connection paths.
- Shows the selected instance's complete CTOX Business OS, including its chat,
  inside the main application surface.
- Leaves Business OS records, commands, files, policy, and orchestration under
  the authority of the selected CTOX instance.
- Keeps the CTOX Sync Engine WebRTC data plane unchanged. CTOX Desktop App must
  not add an HTTP data bridge or fallback.

### Integrated modes with explicit authority boundaries

The two modes form one integrated product. They share the desktop shell,
navigation, capability packages, selected source code, notifications, and
explicit cross-mode workflows. Business OS is not merely a second application
opened inside Code, and Code is not merely a link launched from Business OS.
The modes remain separate runtime authorities, however, and a CTOX instance is
not reclassified as a coding harness.

Skills and tools follow a strict **one implementation, multiple host adapters**
model:

- Code harnesses (Codex, Claude Code, Grok, and later harnesses) and the CTOX
  harness resolve capabilities from the same versioned catalog, manifests,
  schemas, implementation packages, fixtures, and release artifacts.
- A capability is implemented and maintained once. Code exposes it through the
  per-session T3 MCP adapter; CTOX exposes it through the typed Business OS MCP
  adapter. Host adapters may translate lifecycle, policy, and context, but may
  not fork the capability implementation or its public schema.
- Availability is shared; activation is independent. Code can enable a skill or
  tool per thread, while each CTOX instance applies its own server-authoritative
  policy and grants.
- Secrets, indexes, caches, credentials, audit data, and mutable runtime state
  remain inside their authority boundary. Sharing a skill implementation never
  means sharing a CTOX instance's data with Code mode.

Cross-mode integration uses typed references and authorized commands rather
than a shared database or an untyped renderer bridge:

- Business OS can create or delegate implementation work to a Code thread and
  retain a durable link to the resulting environment, thread, run, and
  artifacts.
- Code can open permitted CTOX context, return results/evidence to the linked
  Business OS work item, and request a review or follow-up through the CTOX MCP
  command boundary.
- Switching modes preserves the current counterpart/link context so the user
  can move between a Business OS record and its Code work without searching.
- Shared notifications, approvals, capability status, and command-palette
  actions may span both modes, but every read or mutation is still authorized
  by its owning T3 server environment or CTOX instance.
- Cross-mode links contain stable typed references and redacted presentation
  metadata only. They never copy provider credentials, pairing secrets, raw
  database records, or unrestricted launch capabilities between authorities.

### Cross-mode workflow bridge

- [ ] Define versioned contracts for a cross-mode link containing the CTOX
      authority/instance and Business OS object reference plus the Code
      authority/environment/thread/run/artifact references; reject ambient or
      renderer-invented authority.
- [ ] Add `Delegate to Code`/`Open in Code` actions to eligible Business OS
      work, creating or selecting a Code thread with an explicit scoped context
      handoff and durable backlink.
- [ ] Add `Return to Business OS`, result/evidence submission, review request,
      and follow-up actions to linked Code threads through validated CTOX MCP
      commands and the existing approval model.
- [ ] Add a shared desktop link navigator and context-preserving mode switch;
      opening a link selects the correct mode, sidebar entry, and main surface
      without mounting both surfaces simultaneously.
- [ ] Add unified, redacted notifications and pending-approval indicators that
      route the user to the owning mode while keeping payload data in the
      owning authority.
- [ ] Prove local, remote, offline, revoked-access, stale-link, and deleted-
      counterpart behavior without a shared database or a Business OS HTTP
      data bridge.

- Every closed CTOX instance runs its own CLI-proxy Rust runtime and owns its
  own provider credentials, pools, cooldowns, and routing state.
- Code mode runs a different CLI-proxy runtime for all coding harnesses
  connected to that T3 runtime.
- A CTOX instance is not a T3 harness.
- CLI-proxy Rust and Web Stack have one canonical maintained source base used
  by both products.
- Code mode uses exactly one Greppy store per server environment at
  `<ServerConfig.stateDir>/greppy`. All local threads and harnesses share it;
  thread, provider-session, harness, and provider-instance IDs must never be
  components of that path. Each remote T3 server naturally owns its own local
  store, while CTOX instance state remains separate.
- T3 and CTOX keep separate event/state machines and persistence.

## 2. Repository and source policy

- [x] Fork T3 Code into the `metric-space-ai` organization.
- [x] Create the initial T3-derived implementation repository as
      `metric-space-ai/workjet`.
- [ ] Rename/move that repository to `metric-space-ai/ctox-desktop-app` and set
      the package, application, installer, updater, and release identity to
      `CTOX Desktop App` before public distribution.
- [x] Keep `origin` on the current `metric-space-ai/workjet` repository and
      `upstream` on
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
CTOX Desktop App (optional client)
├── shared CTOX desktop shell
│   ├── Code mode renderer
│   └── Business OS mode instance switcher + Business OS guest
├── Code-mode T3 server
│   ├── T3 thread and workspace authority
│   ├── Workjet orchestration coordinator
│   ├── per-session T3 MCP server
│   └── one provider-gateway runtime for all coding harnesses
└── shared source packages
    ├── provider-gateway (Rust CLIProxyAPI port)
    ├── web-stack (Rust)
    ├── skill/tool catalog + canonical implementations
    └── thin Code/T3 and CTOX/Business-OS host adapters

Closed CTOX instance A                 Closed CTOX instance B
├── CTOX daemon                        ├── CTOX daemon
├── Business OS authority              ├── Business OS authority
├── its own provider-gateway runtime   ├── its own provider-gateway runtime
└── shared Web Stack package           └── shared Web Stack package
```

CTOX instances continue running when the desktop application is closed or not
installed. CTOX Desktop App may connect to multiple instances, but it never
becomes their provider proxy, database authority, or availability dependency.

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
- [ ] Enforce one canonical capability version lock for both hosts in release
      assembly; fail the build when Code and CTOX resolve different manifests,
      schemas, implementation revisions, or artifact hashes.
- [ ] Add a cross-host conformance gate that invokes every dual-host capability
      through both adapters against the same fixtures and compares canonical
      success/error projections while allowing only documented host-policy
      differences.
- [ ] Make capability availability visible in both UIs from the same catalog:
      per-thread toggles/settings in Code and instance-policy-derived controls
      or status in Business OS, without duplicating capability metadata.

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

Implementation status on 2026-08-17: the first Workjet host-authority slice is
present in source as a separate loopback-only Rust sidecar plus a typed,
authorized Code-server lifecycle/status/catalog service. Focused contracts,
authorization, configuration, and lifecycle tests pass after integration. The
host-adapter checkbox remains open until the full Rust clippy/fmt/portable
regression gates, packaging, real account path, and Settings account surface
are green; harness routing has not been switched to the gateway yet.

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
- [x] Keep provider-neutral Track A separate from host adapters.
- [ ] Move or recreate the conformance fixtures, differential runner, port map,
      and porting ledger.
- [x] Remove the imported built-in Antigravity OAuth client credentials from
      the current portable source and require one typed, zeroizing,
      host-injected credential object for login and refresh.
  - [x] Rewrite every owned, unpublished import/product ref before the first
        push so the two former literals are absent from all reachable blobs and
        commit messages; a 65,388-object exact-literal scan is clean.
- [x] Add a Workjet/T3 host adapter using Workjet's secret storage and lifecycle.
  - [x] Add the isolated Rust host sidecar, private runtime configuration,
        loopback-only readiness/management control plane, zeroized secret
        resolution, and bounded start/stop lifecycle.
  - [x] Integrate environment-authoritative status/catalog/start/stop RPCs with
        explicit authorization, redaction, a Node platform boundary, and a
        deterministic stopped test layer.
  - [x] Verify 38 focused TypeScript tests, contracts typecheck, zero new
        gateway/server diagnostics in the full server typecheck, 2 Rust unit
        tests, 2 Rust integration tests, full portable gateway tests (2513
        passed, 3 ignored), clippy with warnings denied, and formatting. The
        unrelated existing server transfer-budget test still times out after
        120 seconds (124/125 other server tests pass) and remains a regression
        backlog item, not a host-adapter acceptance gap.
- [ ] Routing design (2026-08-18, ready to implement): provider sessions are
      routed through the gateway by injecting harness base-URL and API-key
      environment variables through the EXISTING per-instance
      `ProviderInstanceEnvironment` merge point (`mergeProviderInstanceEnvironment`
      feeds every driver's `processEnv`), not by forking driver internals.
      Prerequisites: (1) a STABLE provider-endpoint port per environment
      (today the host binds `127.0.0.1:0`, so every restart would break
      long-lived sessions — persist an allocated port in the gateway
      configuration and pass it into the host config); (2) a
      server-minted gateway API key via the management `api-keys` surface,
      stored as a server secret and injected per session; (3) per-harness
      env mapping verified against the installed CLIs (Claude:
      `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`; Codex: provider base-URL
      config/env; Grok ACP: first-prompt adapter config) — verify each
      against the real binaries before enabling. Composer model selection
      resolves to a gateway route/profile; sessions without a routed
      selection keep today's direct behavior until cutover.
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
- [ ] Port the Swift Workjet configuration model into versioned Code-mode
      contracts and migrations: orchestrator prompt, progress-board policy,
      worker catalog, provider/model selection, computer target, telemetry,
      execution limits, and verification state. Do not make the Electron
      renderer or the legacy Swift application an authority for these values.
  - [x] Add a versioned, server-authoritative Workjet configuration contract
        and whole-object settings persistence with typed defaults and focused
        migration/round-trip coverage.
  - [x] Add reusable computer records that reference the existing Code
        environment authority and declare per-computer harness availability
        without duplicating SSH, relay, or Tailscale credentials.
  - [x] Add reusable worker profiles with independent computer, harness,
        route, model, reasoning, instructions, and capability selections.
  - [x] Persist the managed prompt plus initial telemetry and execution-policy
        settings independently from the worker catalog.
  - [x] Add a server-authoritative, per-Code-environment worktree storage root
        to Execution settings. New temporary Git worktrees must use the selected
        writable disk (for example `/Volumes/tmp/workjet/worktrees`) without
        moving active worktrees or relocating durable state, secrets, databases,
        logs, attachments, or provider credentials. Validate absolute/canonical
        path, safe root boundaries, writeability, available capacity, collision-
        resistant repository namespaces, and restart-free application; expose
        effective/default path plus health in the UI and preserve the current
        environment-local default when unset.
        Completed 17 August 2026: the selected Code server now validates and
        persists the setting, reports the effective/default/canonical path,
        writeability, and available capacity, and applies A→B changes without a
        restart or moving existing worktrees. Automatic Git worktrees use
        collision-resistant repository/ref namespaces while explicit paths stay
        unchanged. Default/current/prior roots remain reviewable without
        following a replaced prior-root symlink. The native Execution UI exposes
        selected-server identity plus Check, Apply, and Use default actions and
        the existing-worktree notice. Main-checkout verification passed 203/203
        relevant tests, contracts/shared/web typechecks, the filtered server
        typecheck, and a real validation of `/Volumes/tmp/workjet/worktrees` as
        canonical and writable with 220,184,014,848 bytes available.
        The complete Web + server + Electron bundle and the desktop startup
        smoke also passed from the main checkout on 17 August 2026. This proves
        build/startup integrity; it does not replace the still-open packaged
        cross-mode and real-peer UI/E2E gates below.
  - [x] Replace the provisional LLM-route reference to Code provider-driver
        instances with the real provider-gateway account/pool contract. Code
        provider drivers represent harness runtimes and must not be presented
        as OpenAI, Anthropic, Kimi, MiniMax, xAI, Z.ai, Antigravity, or custom
        LLM accounts. Done 2026-08-19 (commit `593ec0cba`): `WorkjetLlmRoute`
        now references `gatewayAccountId` (branded gateway account id);
        configuration schemaVersion 2 with the inspectable one-shot migration
        `migrateWorkjetLlmRouteV1ToV2` implemented as a versioned decode step
        in the contracts schema (the settings document is the persistence
        boundary; a decode failure would have discarded all of settings.json,
        so the v1 field is read leniently). The editor consumes gateway
        catalog accounts; pools remain future work.
  - [ ] Port the progress-board policy, verification state, provider capacity,
        and inspectable one-shot migration/version steps from the Swift model.
- [ ] Replace the current Greppy-only `/settings/workjet` page with the native
      CTOX Code configuration surface covering Prompt, Providers, Computers,
      Telemetry, Execution, and the editable worker catalog. Preserve the
      existing per-thread provider/model controls rather than hiding them
      behind global Workjet defaults.
  - [x] Replace the Greppy-only page with compact Workers, Computers, LLM
        routes, Prompt, Telemetry, Execution, and Capabilities tabs that use
        the existing Code settings layout and search/deep-link behavior.
  - [x] Add tested editors for reusable computers, harness availability, LLM
        routes, and worker composition; keep Greppy in Capabilities instead of
        treating it as Workjet itself.
  - [x] Prove the native settings slice through 112 focused tests, direct
        contracts/shared/web typechecks, a complete desktop build, and an
        Electron UI pass at 1100 px and 840 px without page-level horizontal
        overflow.
  - [ ] Add the real provider-account surface backed by the shared Rust
        provider gateway, environment-scoped secure credentials, account
        pools, health/capacity, and model discovery. Do not reuse the existing
        Codex/Claude/Grok provider-driver list as the LLM provider catalog.
        Progress 2026-08-18: the OAuth login pipeline is implemented end to
        end below the UI. The workjet gateway host exposes canonical
        management OAuth routes (begin `…/anthropic|codex|antigravity-auth-url`,
        `oauth/status`, cancel, loopback callback on the same listener) plus a
        one-time management-key-gated
        `POST /v0/management/oauth/session/<state>/claim` whose per-provider
        payloads match the host's own secret-store serialization
        byte-for-byte; the host also boots in a zero-account bootstrap mode
        (management/OAuth only, provider endpoint refuses with 503) so the
        first login is possible (commits `72fb47a6f`, `683f4df8a`,
        `553a59ef1`; host 5+8 tests, portable suite 2513 green, clippy/fmt
        clean). The Node server drives begin/poll/claim, persists claimed
        tokens into the ServerSecretStore, appends the account to
        `provider-gateway.json` (decode-validated, token material never in
        config), reloads the gateway, and exposes
        `workjet.providerGateway.oauthStart|oauthPoll|oauthCancel` RPCs behind
        the orchestration-operate scope; a missing configuration file now
        yields the bootstrap state (commits `100a2f3b5`, `fb4effbb2`; 12
        focused service tests). Open: settings UI + client-runtime wiring (in
        flight), live provider round trip (dynamic loopback redirect port
        unverified against real OAuth client registrations), pools/weights
        editing, health/capacity, model discovery beyond configured models,
        and harness routing through the gateway.
  - [ ] Replace declared harness availability with live environment-scoped
        inspect/install/update/remove actions and consume the resulting truth
        during worker validation and dispatch.
- [ ] Add an orchestrator-scoped worker overview showing child threads grouped
      under their parent with task, harness/model, environment/computer,
      delivery/turn state, completion/result state, and actionable links to
      open the ordinary worker thread.
- [ ] Keep the normal Code sidebar authoritative: every created worker remains
      visible as an ordinary local or remote thread even when the specialized
      orchestrator overview is closed.
- [ ] Migrate existing Swift Workjet configurations through a one-shot,
      inspectable import/export path; after parity is proven, CTOX Code must
      not require the Swift runtime or its local store.
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

### Distributed worker mailbox and delegation graph

Worker communication is a Workjet protocol, not a Claude-, Codex-, Grok-,
desktop-, or same-process feature. Every worker remains an ordinary thread on
one authoritative Workjet/T3 server. A worker on any supported harness may
send a message or delegate a prompt to an authorized thread on the same or a
different computer. The recipient may be offline when the sender submits it.

CTOX Code does not replicate T3's event store, worktrees, terminals, provider
sessions, or credentials through RxDB and does not make Code servers
multi-writer peers. It may reuse the audited CTOX Sync building blocks for
device identity, encrypted peer sessions, revocation, checkpoints, reconnect,
and an opportunistic direct WebRTC live path. The durable Workjet mailbox and
the owning T3 server remain authoritative; the relay provides store-and-forward
delivery whenever direct peers or desktop clients are offline. A desktop may
cache only a redacted, read-only thread/worker projection for local-feeling
navigation and must route every mutation to the thread's owning environment.

The existing client-side remote-environment federation is not sufficient:
delivery must continue while the Workjet Desktop is closed. Membership and
identity come from the CTOX sync engine, not from a new system: joining the
Workjet mesh is joining a CTOX-style room (invite = room + room password +
signaling URLs) with the engine's capability/session layer and device-scoped
revocation on top. T3 Connect account/DPoP/environment-discovery identities
are explicitly NOT reused for mesh membership. Any coordination fallback is a
mailbox/router, never the authority for a thread, provider session,
repository, Greppy store, capability grant, or execution result.
Same-environment delivery may take a local fast path but must obey the same
contracts and state machine as remote delivery.

Decision (owner, 2026-08-18) — transport weighting and portability model:

- The CTOX Sync WebRTC data plane (device identity, encrypted peer sessions,
  revocation, checkpoints) is the PRIMARY and ONLY planned transport between
  the user's machines: the durable per-machine mailboxes replicate peer to
  peer whenever any two machines are online, with no third-party server,
  SSH, or VPN requirement. Onboarding a new machine is the existing CTOX
  pairing flow — one invite carrying room, room password, and signaling
  URLs; a publicly reachable signaling endpoint (ctox.dev managed instance
  or any of the user's own instances) covers machines behind NAT. Membership
  security rides on the engine's capability/session layer plus the
  device-scoped active-session revocation landed in rc7 — the room password
  alone is not the security boundary, so a single lost device can be revoked
  without rotating the room. A separate self-hostable relay is NOT planned;
  should never-overlapping-online machines ever matter, the store-and-forward
  role falls to one of the user's own always-on CTOX instances, not to new
  infrastructure. Authority boundaries are unchanged: T3 event stores,
  worktrees, terminals, provider sessions, and credentials are never
  replicated; mailbox envelopes and the redacted read-only activity
  projection are the only replicated payloads.
- Cross-machine visibility: the desktop shows a global multi-computer
  activity overview built on that replicated redacted projection, including
  the last known state of currently offline machines. Scheduled after M3.
- History/worktree portability uses the HANDOFF-SNAPSHOT model, not event
  export and not event replication: a typed thread handoff carries an
  immutable prompt/context snapshot, bounded artifact references, a pushed
  (or bundled-over-sync) Git branch — the per-worker isolated worktree
  branches make this natural — and a durable link to the source thread. The
  target machine creates a NEW thread from the handoff and continues with any
  harness/LLM; the source server keeps the original raw history readable.
  Full event export/import and CTOX-Sync replication of thread history were
  considered and rejected (authority conflicts, multi-writer risk).

```text
source thread -> source server outbox -> Workjet coordination relay
                                      -> target server inbox -> target thread
                                      <- receipt/result/review <-
```

A plain message and a delegation are related but distinct. A message informs
another worker and may require no execution. A delegation carries a prompt,
explicit scope and completion contract, schedules a target turn, and owns a
durable lifecycle. Sending “message + task” creates both in one atomic command.

- [ ] Define a globally routable worker address as account/workspace authority
      plus `environmentId` and `threadId`; keep harness and provider IDs out of
      the address so a thread can change model without breaking the route.
- [ ] Add versioned contracts for `WorkerMessage`, `Delegation`,
      `DelegationRef`, delivery receipt, result, review verdict, and bounded
      artifact/context references.
- [ ] Model delegation states explicitly: `queued | delivered | accepted |
running | needs-input | review-requested | changes-requested | completed |
failed | cancelled | expired`.
- [ ] Persist source outbox, target inbox, delegation state, and thread-visible
      message/delegation events transactionally on their authoritative servers.
- [ ] Replicate the per-machine durable mailboxes and the redacted activity
      projection over the CTOX Sync WebRTC data plane between the user's own
      machines (primary transport per the 2026-08-18 owner decision), joined
      through the existing CTOX pairing invite flow (room + room password +
      signaling URLs) with the engine's capability/session layer and
      device-scoped revocation; signaling via ctox.dev or the user's own
      instances. No new relay service and no T3 Connect identity reuse for
      mesh membership; an always-on user-owned CTOX instance covers
      store-and-forward if ever needed.
- [ ] Add the typed thread-handoff contract and flow (immutable prompt/context
      snapshot, bounded artifact references, pushed or sync-bundled Git branch,
      durable source-thread link); the target machine continues in a new
      thread with any harness/LLM. Prove a real machine-A → machine-B handoff
      including a worker worktree branch.
- [ ] Add the global multi-computer activity overview on the replicated
      redacted projection, including last known state of offline machines.
- [ ] Encrypt message/delegation payloads end to end to the target environment
      key and sign the immutable routing envelope with the source environment
      key; the relay may inspect only the minimum routing and expiry metadata.
- [ ] Add narrowly scoped server credentials and ACL checks for send, receive,
      reply, cancel, reassign, and review operations; account co-membership
      alone must not grant cross-project or cross-environment execution rights.
- [ ] Guarantee at-least-once transport with stable envelope IDs, idempotent
      inbox insertion, acknowledgements, bounded retry/backoff, expiry, and a
      dead-letter state visible to the user. Never promise exactly-once network
      delivery; guarantee exactly-once delegation effects by deduplication.
- [ ] Add a server-side mailbox reconciler that resumes after restart, applies
      backpressure, orders events per delegation, and queues target prompts
      while a thread already has an active turn.
- [ ] Expose harness-neutral MCP tools `workjet_send_message`,
      `workjet_delegate_task`, `workjet_reply`, `workjet_request_review`, and
      `workjet_update_delegation`; all harnesses receive the same schemas and
      authorization boundary from the per-session T3 MCP server.
- [ ] Deliver accepted tasks through normal T3 `thread.turn.start` semantics
      and the existing Codex, Claude Code, and Grok session adapters. Do not
      implement direct harness-to-harness sockets or provider-specific remote
      protocols.
- [ ] Preserve the delegation link when a result returns to the source thread;
      allow the source worker to ask a follow-up, request independent review,
      or send `changes-requested` back to the original worker without creating
      an unrelated task chain.
- [ ] Represent review and revision as typed edges (`reviews`, `revises`,
      `follows-up`) in one delegation graph, with configurable maximum depth,
      review rounds, token/cost/time budgets, and approval gates to prevent
      autonomous infinite loops.
- [ ] Add interruption, cancellation, reassignment, target-offline, deleted-
      thread, and target-version-skew handling with explicit terminal or
      recoverable states; never silently drop a message or start it elsewhere.
- [ ] Transfer context by immutable prompt snapshots and bounded references to
      artifacts, diffs, files, and Greppy results instead of copying complete
      chat histories. All Code-mode threads on one server continue to share its
      single Greppy store; remote servers resolve references against their own
      authorized environment state.
- [ ] Add thread UI for “Nachricht” versus “Nachricht + Auftrag”, recipient
      selection across connected computers, delivery/state badges, linked
      source/target navigation, reply, follow-up, review, cancel, and reassign.
- [ ] Add redacted audit/observability events and user notifications without
      storing prompts, secrets, provider payloads, or artifact contents in
      relay logs, traces, push notifications, or crash reports.
- [ ] Prove the protocol with same-server and cross-computer mixed-harness E2E:
      Codex -> Claude Code, Claude Code -> Grok, and Grok -> Codex, including
      offline delivery, duplicate envelopes, restart recovery, busy targets,
      review/changes-requested cycles, cancellation races, and revoked access.

Abuse and reliability tests must cover duplicate dispatch, stale parent,
deleted worker, server restart, network loss, cancellation race, terminal
failure, remote version skew, and unauthorized cross-environment control.

## 9. Wave 6 — CTOX Desktop App identity

- [ ] Change the user-facing desktop name, About panel, package metadata,
      installer names, app icons, update channel, and release filenames to
      `CTOX Desktop App` without renaming internal packages, storage keys,
      bundle IDs, or protocol schemes in the same change.
  - [x] Rebrand the current macOS arm64 package, executable, title, release
        filenames, and app icon to CTOX. The 17 August packaged Electron QA
        proves `CTOX Desktop App (Alpha)`, no rendered T3 wordmark, a CTOX
        `icon.icns`, and the final DMG/ZIP names.
  - [ ] Finish the About-panel and update-channel identity audit on every
        supported platform before closing the parent identity task.
- [ ] Introduce `ctox-desktop:` and `ctox-desktop-dev:` protocol schemes while
      keeping CTOX instance/invite protocols distinct.
- [ ] Keep safe one-time migration support for existing T3 Code desktop links
      and user data where useful.
- [ ] Use a distinct CTOX Desktop App user-data directory; import legacy
      T3 Code/Workjet settings only
      through an explicit, tested migration.
- [ ] Keep internal `@t3tools/*` package names where changing them adds only
      upstream merge cost.
- [ ] Update visible copy without rewriting unrelated historical comments,
      storage keys, or contracts.
- [ ] Add CTOX Desktop App brand assets only after the shell and behavior are
      stable.
- [x] Default a fresh CTOX Desktop App profile to the coherent dark shell while
      preserving explicit Light selection and the existing browser/system-theme
      behavior. Cover both the synchronous boot script and React theme hook;
      prove the packaged Code and Business OS surfaces are dark.

## 10. Wave 7 — port the legacy CTOX Desktop client into CTOX Desktop App

Current source: `ctox/src/apps/business-os-desktop`

The existing CTOX Desktop wrapper is not copied wholesale as a second nested
Electron app. Its client capabilities are ported into the T3-derived, typed
Effect/Electron architecture of CTOX Desktop App. CTOX daemon, Sync Engine,
Business OS authority, and Business OS web source remain in the independent
CTOX project.

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
  - [x] Add an atomic Electron main-process Business OS mode lease: activation
        fails with `not_active` outside the mode, and mode exit destroys the
        native guest before releasing the lease.
  - [x] Make the visible Business OS -> Code switch await successful native
        mode exit before rendering the Code surface; keep unmount cleanup as a
        second idempotent boundary.
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
      over the Code/T3 HTTP server.

### Business OS desktop-coherent theme

- [x] Add a host-scoped CTOX Desktop theme layer and deterministic visual QA
      shell in the CTOX repository. The source reuses the production Business
      OS tokens and three-pane grammar, adds light/dark and responsive states,
      and deliberately excludes the outer desktop mode switch and instance
      sidebar (`metric-space-ai/ctox` commit `f5ee27eab`).
- [x] Load the theme stylesheet from the production Business OS shell while
      leaving it inert for standalone/browser use unless the trusted desktop
      host marker is present. Shipped in `business-os-shell-v0.1.0-rc.9`
      (rc.8 lacked the `themes/` tree — builder fix in CTOX commit
      `28b7294aa`); every theme rule is scoped to
      `html[data-desktop-host="ctox"]` and the QA suite proves the scope guard.
- [x] Set and clear the desktop host marker from the isolated Electron guest
      lifecycle. The marker is set only by the isolated guest preload on the
      main-process `instance:apply-host-theme` IPC (allowlisted token keys,
      bounded color pattern); page content cannot claim it. The Workjet
      renderer projects the current appearance theme (tokens resolved to
      concrete colors via probe element, filtered through the shared
      `CtoxHostThemeColor` schema) on mount, on `<html>` attribute mutations,
      and on every guest ready transition; the guest manager replays the last
      theme on `did-finish-load`. 2026-08-18: dark T3, chat-dock flattening,
      flat desktop ground (rc.10), and live Ocean-theme projection verified
      in the installed packaged app via CDP
      (`--ctox-host-bg: oklch(0.242641 0.024125 250.573)` under Ocean).
- [ ] Publish and pin the first Business OS shell release containing the theme,
      then prove dark/light plus three/two/one-pane layouts inside packaged
      CTOX Desktop App and prove the standalone shell remains unchanged.
      `v0.1.0-rc.10` is published and pinned; dark plus theme projection are
      proven in the installed app. Light-scheme and pane-collapse proof in the
      packaged app remain open.

### Renderer

- [x] Expose the top-left product-mode switch with the final visible labels
      `Code | Business OS` (the persisted internal `ctox` value remains for
      backward compatibility). The 17 August packaged Electron proof covers
      mouse and radio-keyboard switching, no-wrap labels, the 840 px minimum
      window, open/collapsed/restored sidebar states, and contained titlebar
      geometry: the control ends at x=246 inside the 248 px compact sidebar.
- [x] Preserve the T3 project/thread sidebar in Code mode.
- [x] Add the persisted, Electron-only CTOX shell state with an explicit empty
      instance/main surface and no guest or alternate Business OS data path.
- [ ] Render CTOX instance groups, status, role, source, and last-used state in
      Business OS mode.
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
- [ ] Ensure keyboard shortcuts and zoom target the active desktop surface
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
  - [x] Pass the same isolated path as Electron's startup
        `--user-data-dir=<root>/t3code` in the packaged-smoke launcher and
        assert the exact disposable profile recursively on renderer, GPU, and
        utility child processes. A prior real packaged run proved that the GPU
        process may start before Workjet calls `app.setPath`, so the environment
        override alone was not a complete normal-profile isolation guarantee.
  - [x] Build a real unsigned macOS arm64 DMG and ZIP under `/Volumes/tmp` from
        the staged packaged layout. Omit `workspace:` dependencies from the
        staged server runtime manifest because those Workjet packages are
        already inlined in the server bundle; retain catalog dependency
        resolution and its focused regression test.
  - [x] Make the isolated staged production install consume the repository's
        locked resolutions (or an equivalently pinned generated lock) instead
        of re-resolving package ranges from the network. Commit `e5b731a02`
        derives a stage `pnpm-lock.yaml` from the root lock
        (`createStagePnpmLockfile`) and installs with
        `vp install --prod --frozen-lockfile`; drift between the staged
        manifest and the lock fails the build.
  - [ ] Run the paired packaged-app smoke against the operator-selected real
        CTOX instance. Temporary Workjet profiles and invite files stay under
        `/Volumes/tmp`, but the smoke must not override `CTOX_ROOT`,
        `CTOX_STATE_ROOT`, or `CTOX_INSTALL_ROOT` to a synthetic empty instance. - [x] Add the macOS-first packaged smoke runner and focused tests. It uses
        only the typed CTOX desktop bridge, keeps the real CTOX instance
        roots intact, discovers changing `WebContentsView` CDP targets by
        capability, retains invite and peer secrets only in memory, and
        enforces unrevoke/recovery before pairing or profile cleanup. - [x] Rewrite the packaged smoke driver to use the visible `Code | Business
OS` control and the safe paired-instance row, verify DOM-relative
        sidebar/chrome/main/guest geometry, and prove no guest target remains
        after returning to Code; it no longer calls guest activation,
        deactivation, or discovery directly. - [x] Resolve packaged guest activation on a successful same-origin
        top-frame navigation commit and keep the pending React activation
        observable across ResizeObserver updates. The focused Web/Desktop
        suite is `16/16` plus `43/43`, both affected direct typechecks pass,
        and the fresh packaged host now advances from `connecting` to
        `ready`. - [x] Align the packaged health probe with CTOX lazy replication by using
        the public `waitForHealthy()` contract, give only the expensive
        Advanced Status snapshot a longer bounded CDP window, and emit only
        allowlisted non-secret collection/transport diagnostics. - [x] Repair the RC6 paired-guest WebRTC room handshake/stream activation.
        The fresh packaged host now pairs through the authenticated room,
        yields its ephemeral signaling peer ID, and reports initial,
        streaming-ready, and checkpoint health for
        `business_module_catalog`, `ctox_runtime_settings`,
        `business_commands`, and `ctox_queue_tasks`. - [ ] Rebuild the packaged app with the mode lease and UI-driven smoke, then
        pass the real RC6 revoke/unrevoke/recovery run before closing this
        gate.
  - [ ] Capture the browser peer ID only from the live WebRTC signaling
        handshake or another non-persistent runtime diagnostic, keep it out of
        logs/artifacts, and guarantee `peer unrevoke` before any later cleanup.
    - [x] Add a bounded CTOX advanced-status field for the browser's own live
          signaling peer ID, populated only after the `init.yourPeerId`
          handshake and never persisted or logged. The change is isolated in
          clean CTOX commit `1e2808814` on branch
          `codex/browser-peer-shell-rc2`; it is not yet contained in the pinned
          `v0.1.0-rc.1` shell. The packaged Electron
          `WebContentsView` changes renderer targets during navigation, so an
          external CDP listener attached at view creation cannot reliably
          observe that first frame; rejected smoke drafts must not replace this
          with a broad browser-target hook, synthetic CTOX roots, or durable
          test IPC.
    - [x] Restore the CTOX browser suite without absorbing the unrelated dirty
          main checkout. Clean commit `71b80c625` refreshes the command-consumer,
          command-type, and task-ID inventory generators. Commit `1e2808814`
          also carries the narrow reconnect and bounded direct-push invariants
          required by the already-committed recovery/handshake tests. The
          release-strict suite passes `102/102` with the real Rust wire daemon
          and no skips.
    - [x] Restore the versioned shell publication source on the clean release
          branch through commits `15abb6427`, `cbefe7521`, and `3572b3f56`,
          including deterministic archive generation, manifest/checksum output,
          no-clobber publication, and prerelease marking.
    - [x] Push clean CTOX branch `codex/browser-peer-shell-rc2` so immutable
          source commit `3572b3f56` is reachable from `metric-space-ai/ctox`;
          the dirty main checkout and its unrelated work remain untouched.
    - [x] Pass all 8 shell-builder tests, build `v0.1.0-rc.2` entirely under
          `/Volumes/tmp`, and publish it as a GitHub prerelease through Actions
          run `31949321934`. The Node 24 release build is byte-identical to an
          independent local Node 24 build; detached and embedded manifests,
          checksum, 1,768-file inventory, no-symlink invariant, source commit,
          and prerelease flag are verified. Node 26 produces the same payload
          inventory but different compressed bytes, so Node 24 remains part of
          the pinned release toolchain.
    - [x] Update Workjet's shell version, URL, checksum, size, inventory, and
          source-commit pin to `v0.1.0-rc.2`; install and revalidate it through
          ignored `.deps/` storage backed by `/Volumes/tmp`. The second prepare
          is a verified cache hit, the expanded shell contains the transient
          peer diagnostic, 17 focused tests pass, and desktop/scripts
          typechecks have no errors.
    - [x] Persist one browser device/session identity across reconnects through
          `ctoxProtocol.peerSession.sessionId` while retaining the signaling
          peer ID as socket-scoped diagnostics and legacy revocation input.
    - [x] Enforce device-scoped revocation in the Business OS shell and cover
          reconnect behavior without adding persistent test IPC or an HTTP data
          path.
    - [x] Reuse the authenticated paired-guest room handshake in RC6 so the
          shell and native peer resolve the same room and all four required
          replication streams can become healthy.
    - [x] Build the deterministic RC6 shell payload under `/Volumes/tmp` at
          source commit `1a7872378b698f1f89871f1372f969039606a8c4`; verify its
          detached and embedded manifests, 1,768-file inventory, 128,452,286
          byte local archive, and SHA-256
          `a577d403f100f4cf7c7484db4b02123a49294740a78c456b1ae277916f2cd612`.
          The canonical Node 24 release archive uses different compression
          bytes while retaining the identical 1,768-file manifest payload and
          embedded-manifest hash.
    - [x] Publish immutable tag `business-os-shell-v0.1.0-rc.6` and its three
          release assets from the clean shell branch without absorbing the
          dirty CTOX main checkout. Actions run `31986068315` passed; the
          canonical archive is 129,005,908 bytes with SHA-256
          `59f320e7de8a6fb96957eea7254353d68ea25862e3997d0b4613281f5ddf828d`.
    - [x] Pin Workjet's four shell identity/manifest surfaces to the locally
          verified RC6 candidate and then the canonical published hashes; pass
          89 focused tests plus desktop, web, and scripts typechecks without
          changing `pnpm-lock.yaml`.
    - [x] Build a fresh unsigned macOS arm64 package with the RC6 shell at
          `/Volumes/tmp/workjet/t3code-desktop-mac-stage-0XIQd7` and retain the
          exact ZIP as the current smoke candidate.
    - [x] Prove the packaged desktop pairs with the real selected CTOX instance
          and reports initial, live-streaming, and checkpoint health for all
          four required collections.
    - [x] Seed disposable Electron partition markers and apply the real durable
          browser-session revocation through the packaged UI-driven run.
    - [ ] Implement an independent store-backed
          `WebRTCPeerSessionValidator` for native inbound and outbound traffic,
          preserving the separate signaling validator and legacy wrappers.
          The initial isolated worker snapshot passes four focused
          accept/revoke tests and the complete locked Rust check, but its real
          optimized packaged-app run never makes the four required streams
          healthy. The validator hunks are now integrated into the newer
          current source and its optimized ARM64 binary reaches healthy pairing
          and accepts the durable revoke, yet the packaged guest still does not
          remain unhealthy with `peer_revoked`. Cleanup verified unrevoke first,
          removed the disposable profile, and restored the installed service
          byte-for-byte with exactly one listener. The next repair must explain
          this live-connection behavior rather than attributing it to snapshot
          drift.
    - [x] Apply only the four-file native validator delta to the dirty CTOX
          main checkout, re-run its gates there, and retain all unrelated user
          work unchanged. The current-source integration keeps startup
          staggering, projection clocks, Eager-Pull, Browser-Live, auxiliary
          requests, metrics, and cancellation intact; 5 focused tests,
          formatting, the complete locked root check, and `git diff --check`
          pass. The release compiler also produced a valid signed ARM64 binary
          with SHA-256
          `1c7448aec4eb6c8ac8adca0267c0f0394168eb508485972f293222dd5996d758`;
          Cargo failed only after successful linking because its external
          target `.fingerprint` directory disappeared, so the decisive smoke
          executed the byte-identical linked artifact directly.
    - [ ] Pass the complete packaged healthy → revoke → unhealthy → unrevoke →
          healthy → remove/reimport sequence and verify guest detachment plus
          Electron partition deletion.
    - [x] Wire the trusted Electron guest-host marker to the host-scoped
          Business OS desktop theme, link the inert stylesheet in production,
          and prove standalone Business OS remains visually unchanged.
          Done 2026-08-18 with shell `v0.1.0-rc.10` and the Workjet theme
          projection pipeline (see the Wave 7 desktop-coherent-theme section);
          the stylesheet is scope-guarded to the preload-set
          `data-desktop-host="ctox"` marker, so the standalone shell is
          untouched by construction and QA.
    - [x] Download RC6 through Workjet's normal network prepare path after
          publication; verify the canonical Node 24 archive and manifests, then
          pass a second full cache-hit inventory check under `/Volumes/tmp`.
          The expanded 1,768-file payload and embedded-manifest hash are
          identical to the independent local candidate; only the gzip archive
          bytes and their detached size/hash fields differ by builder runtime.

Latest verified CTOX increment (Workjet commits `6f0fc627a`, `03a87bd70`,
`e00ebfa61`, `9047bed3f`, `042f8af38`, `d35d9ebbf`, `31fe2c70e`,
`483df6064`, `a640dad00`, `4dc74c432`, `8672548b4`, and `aabaccbc5`; CTOX shell commits `aa7d64c22`,
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
environment override. The new packaged smoke runner now supplies that argument,
recursively verifies the disposable profile, and has 22 focused tests plus
scripts typecheck, formatting, and `git diff --check` green.

The next CTOX shell candidate is isolated on clean branch
`codex/browser-peer-shell-rc2` above committed CTOX main `825ee651d`. Commit
`71b80c625` repairs the three deterministic inventory gates; commit `1e2808814`
adds the transient browser-peer status plus the production reconnect/batching
invariants already required by committed tests; commits `15abb6427`,
`cbefe7521`, and `3572b3f56` restore the hardened versioned-shell builder and
prerelease workflow. The Rust wire daemon was built in a release target under
`/Volumes/tmp`, and the release-strict Business OS suite passes `102/102` with
zero failures and zero skips. Adversarial self-review found no HTTP data path,
persistent peer identity, durable test IPC, logging surface, or mutation of the
deterministic client identity.

Clean branch `codex/browser-peer-shell-rc2` and annotated tag
`business-os-shell-v0.1.0-rc.2` are published in `metric-space-ai/ctox` at
`3572b3f56`. Actions run `31949321934` published a prerelease whose Node 24
archive is byte-identical to the independent local Node 24 build: 129,003,880
bytes, SHA-256 `60b362503785a82fe087be5a3360f2fff74afdbff51c32a8f4b448f907490495`,
1,768 files, and no symlinks. Workjet now pins this exact release and revalidated
its detached manifest, embedded inventory, archive, expanded files, completion
sentinel, and cache-hit path under ignored `.deps/` storage backed by
`/Volumes/tmp`. The pinned shell exposes the transient browser-peer diagnostic
required by the packaged runner. The next proof sequence is to make the staged
production dependency install consume locked resolutions, rebuild the unsigned
package, and run the real revoke/unrevoke/recovery/partition smoke. An earlier
draft that pointed CTOX roots at a synthetic empty instance remains explicitly
rejected.
Independent Kimi review remains deferred because the required review provider
is unavailable; adversarial self-review additionally caught and fixed cleanup
being skipped after a partial registry removal and set the unrevoke barrier
before an ambiguous native revoke result.

## 11. Wave 8 — retire the legacy CTOX Electron wrapper

This wave happens in the separate CTOX repository and only after the CTOX
Desktop App parity gate is green. It removes only the legacy desktop wrapper;
CTOX continues to run as an independent backend/harness without any desktop
application.

- [x] Start from a clean CTOX branch; do not mix or overwrite unrelated current
      CTOX working-tree changes.
- [ ] Remove `src/apps/business-os-desktop`.
- [ ] Remove its separate packaging/release workflow and download links.
- [ ] Point optional desktop-client documentation to CTOX Desktop App without
      presenting it as a CTOX runtime prerequisite.
- [x] Keep the CTOX Business OS shell build and versioned shell artifact.
- [ ] Keep CTOX daemon, Sync Engine, Business OS, MCP channel, provider adapter,
      and Web Stack adapter.
- [ ] Update release smoke tests so CTOX validates the artifacts consumed by
      CTOX Desktop App instead of building another Electron application.
- [ ] Verify local, managed, SSH, and invite workflows from CTOX Desktop App
      against the new CTOX commit before merging the deletion.

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
      authority escalation. Require signed, end-to-end encrypted delegation
      envelopes, target-side capability checks, bounded payloads, expiry, and
      revocable environment credentials.
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
6. Send a plain inter-worker message and a prompt delegation between different
   harnesses and computers while the Workjet Desktop is closed.
7. Observe delivery receipts, durable status, result return, follow-up,
   independent review, changes-requested, cancellation, and restart recovery.

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

- One versioned capability catalog, canonical Greppy/Web Stack
  implementations, and thin host adapters work from both a Code thread and a
  CTOX instance without schema or implementation forks.

### M3 — shared provider source

- Workjet/T3 harnesses use one local gateway runtime from the moved Rust source;
  CTOX consumes the same source in a separate instance-local runtime.

### M4 — local orchestration

- Orchestrator radio control, settings, prompt compiler, worker threads, and
  the local mailbox/delegation state machine are complete.

### M5 — remote orchestration

- Durable authenticated and end-to-end encrypted cross-environment messaging,
  prompt delegation, result return, review/revision loops, and recovery are
  complete across Codex, Claude Code, and Grok.

### M6 — Business OS mode beta

- CTOX Desktop App lists managed/local/SSH/invite instances and embeds the
  selected Business OS over the existing WebRTC data plane.

### M7 — one optional desktop application

- CTOX Desktop App passes legacy desktop parity, signed release evidence, and
  Code/Business OS E2E; the legacy CTOX Electron wrapper is removed from the
  CTOX repository without making the CTOX backend depend on the app.

### M8 — public release

- Licensing, security, updater, migration, provenance, and supported-platform
  gates are closed; the Workjet branch is pushed and released.

## 17. Definition of done

CTOX Desktop App is complete only when all of the following are true:

- One installed CTOX Desktop App switches cleanly between equal `Code` and
  `Business OS` modes; neither mode overlays or visually owns the other.
- Code mode retains upstream T3 behavior and adds durable native Workjet
  orchestration without a Swift runtime dependency.
- Code harnesses and the CTOX harness consume the same versioned skill/tool
  catalog, schemas, implementations, fixtures, and release artifacts through
  different thin host adapters; no capability is maintained twice.
- The same capability can be enabled in Code and CTOX, while activation,
  authorization, secrets, indexes, caches, and mutable state remain scoped to
  the owning Code server environment or CTOX instance.
- Codex, Claude Code, Grok, and other enabled harnesses use the Workjet/T3
  provider-gateway runtime while retaining direct model selection.
- Each CTOX instance remains closed and uses its own gateway runtime from the
  same maintained Rust codebase.
- Greppy and Web Stack use one maintained implementation and can be enabled in
  both modes through their respective adapters.
- Managed and unmanaged CTOX instances launch the full Business OS through the
  unchanged WebRTC data plane.
- The legacy standalone CTOX Electron wrapper is gone, but the CTOX backend,
  daemon, Sync Engine, Business OS, and web shell remain independently
  deployable and operational without CTOX Desktop App.
- The fork can absorb upstream T3 updates with a bounded patch stack.
- All security, license, E2E, packaging, signing, and artifact-hygiene gates are
  green.

## 18. Immediate execution queue

1. [x] Finish and verify Wave 1 thread-domain implementation.
2. [x] Add the minimal capability-registry contract and prompt adapter interface.
3. [ ] Finish the `Code | Business OS` product-mode shell and prove through a
       packaged UI-driven smoke that the native guest can exist only inside the
       selected Business OS main surface.
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
    - [x] Add the matching Electron startup `--user-data-dir` argument so even
          pre-`app.setPath` GPU/network initialization is isolated, then assert
          every packaged child process stays under the disposable profile.
    - [x] Keep the real CTOX instance selection intact; do not point CTOX roots
          at the disposable Workjet smoke profile.
    - [x] Expose the browser's handshake-assigned peer ID through a bounded,
          non-persistent CTOX advanced-status diagnostic; external CDP capture
          does not survive the packaged WebContentsView's navigation target
          swap reliably. The diagnostic is isolated in clean CTOX commit
          `1e2808814`; publication and Workjet pinning remain gated below.
    - [x] Add the packaged smoke automation that captures that ephemeral peer ID
          in memory, drives native revoke and guaranteed-first unrevoke, checks
          healthy recovery, removes/reimports the pairing, verifies
          cookie/localStorage/IndexedDB/CacheStorage partition deletion, and
          retains Workjet/profile files if unrevoke cleanup fails.
    - [x] Restore the CTOX browser suite to `102/102` with the real Rust wire
          daemon and zero skips, and commit the inventory repairs plus transient
          diagnostic on clean branch `codex/browser-peer-shell-rc2` without
          absorbing unrelated dirty-tree work.
    - [x] Restore the hardened versioned-shell builder and prerelease workflow
          on that clean branch.
    - [x] Push the clean CTOX branch, pass the shell-builder unit gate, and
          build/publish/verify `business-os-shell-v0.1.0-rc.2` entirely from
          `/Volumes/tmp` scratch output with the pinned Node 24 toolchain.
    - [x] Update Workjet's immutable shell manifest/checksum/source pin, fetch
          the release through ignored `.deps/` storage, and prove both fresh
          installation and verified cache-hit paths.
    - [x] Execute the packaged runner to prove native revoke,
          guaranteed-first unrevoke, healthy recovery, pairing removal, and
          same-partition cookie/localStorage/IndexedDB/CacheStorage deletion
          against the operator-selected real CTOX instance, leaving no
          revocation behind on any failure or catchable signal path.
          PASSED 2026-08-18 against the live local instance (packaged build
          from this branch with pinned shell `0.1.0-rc.7`; all phases green
          including persistent `peer_revoked`, healthy recovery after
          unrevoke, pairing removal, and partition deletion). The 2026-08-17
          runs failed with verified negative results (clean unrevoke cleanup
          both times) and surfaced two real CTOX product gaps, both fixed on
          `metric-space-ai/ctox` branch `codex/ctox-rc7-active-revocation`
          (merge to main pending): 1. Revocation only gated new connections: `is_peer_valid` /
          `is_peer_session_valid` ran at connect/handshake time only, so a
          peer revoked mid-session kept its established WebRTC session.
          Fixed with a periodic server-side revocation sweep that records
          each peer's handshake session identity and severs peers whose
          transport or session identity is revoked (commits `684a989` and
          `d177311`; regression tests
          `revocation_sweep_severs_established_peer` and
          `revocation_sweep_severs_peer_with_revoked_session_identity`;
          crate suite 385 ok, browser suite 104/104 with real wire daemon). 2. The revoked guest lost its revocation reason: after severing,
          the native peer denies the revoked device at connect time
          without a handshake, so status snapshots decayed to
          `no-active-peer`. Fixed by latching `peer_revoked` in the
          shell's advanced status (`noPeerRevocation` check plus
          `sync.peerRevocation`) until required collections stream again
          (commit `cccb672`, released and pinned as
          `business-os-shell-v0.1.0-rc.7`).
          Two runner flake classes remain documented: packaged
          WebContentsView CDP timeouts (retry), and instance-side outages
          (native peer watchdog respawn); both are distinguishable via the
          runner's revocation-wait observation logging.
    - [x] Build the real unsigned macOS arm64 DMG and ZIP under `/Volumes/tmp`
          from the packaged staging layout.
    - [x] Pin the staged production dependency install to repository lock
          resolutions before treating packaged builds as reproducible/offline.
          Done in commit `e5b731a02` (stage lockfile derived from the root
          lock plus `--frozen-lockfile` staging install).
13. [ ] Port local-daemon and SSH-managed sources after the paired shell path is
        green, retaining one registry and one renderer-secret boundary.
14. [ ] Complete the durable local mailbox/delegation state machine, then add
        the authenticated coordination relay and mixed-harness cross-computer
        messaging, prompt delegation, result, follow-up, and review/revision
        flows specified in Wave 5.
15. [ ] Add the configurable per-environment temporary worktree storage root,
        prove new Code and orchestrated worker worktrees land on an operator-
        selected `/Volumes/tmp` root, and prove existing active worktrees plus
        durable state remain untouched when the setting changes.
        The server setting, ordinary Code worktree creation, A→B transition,
        explicit-path bypass, existing-worktree preservation, and real
        `/Volumes/tmp` validation are complete. Keep this queue item open until a
        dispatched orchestrated worker is proven end to end against that selected
        root.
        Decision (owner, 2026-08-17): one isolated Git worktree per dispatched
        worker. The current shared contract — `WorkerDispatch` creates an
        ordinary child thread inheriting the orchestrator's branch and
        `worktreePath` — is rejected as the target semantics because parallel
        workers can mutate the same files. Redesign requirements: - `WorkerDispatch` creates one isolated worktree per worker beneath the
        configured per-environment worktree storage root. - Merge-back is the acknowledged cost. The orchestrator must plan
        parallelization explicitly: assign disjoint file scopes per worker
        brief, and fall back to sequential dispatch when disjoint scopes are
        impossible or when estimated conflict rework outweighs the parallel
        gain. Conflict rework is pure overhead, not a worker defect. - Worktree cleanup on worker completion/abandonment; existing active
        worktrees and durable state remain untouched.
        Close this item only after a dispatched orchestrated worker is proven
        end to end in its own isolated worktree beneath the operator-selected
        root. Do not count synthetic path inheritance as proof.
        Progress 2026-08-18 (commit `fb3d9f407`): `WorkerDispatch.dispatch` now
        creates one worktree per worker via `GitWorkflowService.createWorktree`
        with `path: null` (routed through `WorktreeStorage.resolveAutomaticPath`),
        branched from the parent ref under `workjet/worker/<workerThreadId>`;
        rollback on create/turn-start failure also removes the new worktree, and
        isolation is mandatory (`worktree-failed` instead of silent inheritance).
        10 focused tests pass; zero new server diagnostics. Still open before
        closing: the end-to-end proof with a real dispatched worker, a durable
        completion/abandonment cleanup hook (no such lifecycle boundary exists in
        the server yet — rollback-path cleanup only), and deleting the worker
        branch ref after worktree removal.
        Progress 2026-08-18 (real-stack proof): `apps/server/src/workjet/
WorkerDispatch.e2e.test.ts` dispatches workers through the production
        layer graph — real `GitVcsDriver`/`GitVcsDriverCore` subprocesses against
        a real temporary repository, real `VcsDriverRegistry`, real
        `GitWorkflowService`, real `WorktreeStorage` plus
        `WorktreeRootValidation` over an operator-selected root under
        `/Volumes/tmp/workjet/e2e-worktrees`, and the real
        `OrchestrationEngineService` / projection pipeline /
        `ProjectionSnapshotQuery` on an in-memory SQLite store. Only `GitManager`
        (an unused construction-time dependency of `GitWorkflowService`),
        `ServerSettingsService`, `ServerConfig` and the absent provider harness
        are substituted; none of them sits on the dispatch → worktree path. The
        proof reads each worker's `worktreePath` back out of the real projection
        and asserts it exists on disk, is a genuine Git worktree of the parent
        repository (`git worktree list --porcelain`, `rev-parse
--show-toplevel`), lies beneath the configured root, checks out
        `workjet/worker/<workerThreadId>`, differs from the parent checkout and
        from a second dispatched worker's checkout, and that a write inside one
        worker checkout is invisible to the other and to the parent, whose
        HEAD/branch/porcelain status are byte-identical before and after both
        dispatches. Rollback is proven in the real stack through the
        `create-failed` branch (the real decider's `requireThreadAbsent`
        invariant rejects the worker thread): the already-created worktree is
        removed from disk and from Git's worktree registry. The
        `turn-start-failed` branch cannot be forced through the real engine
        without a fake — the decider only rejects a turn for a missing thread —
        so it stays covered unit-level in `WorkerDispatch.test.ts` over the same
        rollback code path. Verified: `vp test run
apps/server/src/workjet/WorkerDispatch.e2e.test.ts
apps/server/src/workjet/WorkerDispatch.test.ts` → 12 passed, exit 0; the
        new file adds zero server typecheck diagnostics; the fixtures clean
        themselves up through scoped temp directories. Still open before closing:
        the durable completion/abandonment cleanup hook and deleting the worker
        branch ref after worktree removal.
