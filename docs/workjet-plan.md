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

- [x] Define versioned contracts for a cross-mode link containing the CTOX
      authority/instance and Business OS object reference plus the Code
      authority/environment/thread/run/artifact references; reject ambient or
      renderer-invented authority. Done 2026-08-20 (commit `eeff37c0b`,
      migration 052): `WorkjetCrossModeLink` reuses existing bounded ids on
      both sides; presentation is a CLOSED struct (title/subtitle only) and a
      test asserts record/data/body keys are dropped by decode. Authority is
      not the caller's: the Code side has NO `environmentId` input field at
      all (the ambient mistake is unrepresentable) and the CTOX side is
      re-verified on EVERY operation, refusing `unverified-authority` before
      any durable effect. Two UNIQUE constraints carry the invariants in SQL:
      (instance, module, kind, object) IS the create-or-select guarantee, and
      a unique code thread gives "which object does this thread implement"
      exactly one answer.
- [~] Add `Delegate to Code`/`Open in Code` actions to eligible Business OS
  work, creating or selecting a Code thread with an explicit scoped context
  handoff and durable backlink. Server half done 2026-08-20 (commits
  `6ff86928c`, `6bb947285`): the RPC creates the thread with the scoped
  context and the durable backlink, or SELECTS the existing linked thread
  (the server decides created|selected, not the caller). Remaining: the
  invoking button lives in the CTOX Business OS UI, i.e. the CTOX repo.
- [~] Add `Return to Business OS`, result/evidence submission, review request,
  and follow-up actions to linked Code threads through validated CTOX MCP
  commands and the existing approval model. Done 2026-08-20 (commits
  `e47a643ab` + the navigator wire): the link card carries the three
  operations and reuses the existing `WorkjetDelegationApprovalState`
  rather than a parallel enum; "Return to Business OS" now routes through
  the cross-mode navigator (teardown-before-mount). HONEST BLOCKER, with
  evidence: `apps/server` has NO path to a Business OS command today —
  there is no MCP CLIENT in the repo, the mailbox transport's daemon
  treats payloads as opaque blobs by contract, and commands travel
  renderer→IPC→guest. BLOCKER RESOLVED 2026-08-20 (commit `88a509a74`):
  `WorkjetCrossModeCtoxClient` is the repo's first outbound MCP client —
  plain JSON-RPC 2.0 over `POST /mcp` on the daemon's existing loopback
  listener, bearer token from `ctox secret get`, 10 s timeout, no retry,
  256 KB bound, every response Schema-decoded, token and payload never
  logged. Authority is REAL: the running daemon's published `instanceId` must
  equal the caller's AND an `initialize` handshake must identify as
  `ctox-business-os-mcp`; a mismatch never reaches the wire. Failure mapping
  uses CTOX's own vocabulary (`confirmation_required` → awaiting-approval;
  runtime/channel/sync/rate codes → unavailable; other typed refusals →
  rejected; malformed → unavailable, never "landed"). LIVE-PROBED against the
  running daemon: the handshake identifies, a token-less request 401s, and
  the port answered true for the real instance id and false for an invented
  one. Honest ceiling: CTOX exposes NO module-agnostic review/follow-up tool,
  so all three operations ride the one generic `ctox.delegate_task` action
  distinguished by `payload.operation`. The proof matrix's no-data-bridge
  invariant was SHARPENED rather than relaxed for it: the command client is
  the single sanctioned HTTP speaker and is held to a positive rule — every
  request it builds targets `/mcp` — while Business OS data routes stay
  forbidden everywhere, mutation-verified.
- [x] Add a shared desktop link navigator and context-preserving mode switch;
      opening a link selects the correct mode, sidebar entry, and main surface
      without mounting both surfaces simultaneously. Done 2026-08-20 (commit
      `3e30612ba`): `apps/web/src/crossMode/` — a dependency-injected
      `navigateToCrossModeTarget` returning an ordered step journal, plus the
      real-deps hook and a one-shot handoff slot (the shell provider does not
      exist at the instant the mode flips). The non-obvious hazard is handled:
      the Business OS surface is a main-process `WebContentsView`, so React
      unmount does NOT remove it — teardown is AWAITED and a navigation whose
      teardown does not confirm returns `blocked/teardown-failed` instead of
      hiding a live native view under the Code shell. Ordering is asserted
      three ways (real call order, a probe proving the handoff slot is null at
      teardown, and a static source assertion that the shell's surface choice
      stays ONE ternary so a refactor cannot mount both). Context restore:
      one bounded address-only slot per mode.
- [~] Add unified, redacted notifications and pending-approval indicators that
  route the user to the owning mode while keeping payload data in the
  owning authority. Model + rendering done 2026-08-20 (commit
  `3e30612ba`): three bounded kinds (link-created, approval-pending,
  result-submitted) COMPOSED from ids and codes — no field a payload could
  travel in, with canaries asserting the exact allowed key set and that
  free text cannot pose as an id or outcome code; rows never navigate
  themselves, the click hands the target to the navigator. Honest
  three-way empty state (not asked / asked-nothing / n waiting).
  Deliberately NOT mounted yet: nothing publishes into the store until the
  cross-mode link RPCs land, and a panel that can only say "no activity"
  would be a worse lie than showing nothing.
- [x] Prove local, remote, offline, revoked-access, stale-link, and deleted-
      counterpart behavior without a shared database or a Business OS HTTP
      data bridge. Done 2026-08-20 (commit `aaafe6ed2`): all six behaviours
      plus both invariants proved in `WorkjetCrossModeProofMatrix.test.ts`
      against the port INTERFACE with fakes over a real migration-052 store —
      local (select reuses the thread), remote (`unauthorized`), offline
      (`ctox-command-unavailable`, nothing durable written), revoked
      (`unverified-authority` before any effect, link row survives), stale
      (`link-expired`; reads still show it — a stale link is history, not a
      lie), deleted counterpart both directions. EVERY proof was
      mutation-verified: 13 inverted guards, each killing its intended proof
      (table in the log). Invariant A/B are source+schema scans, so a second
      data route or a CTOX table in this database fails the build. Found and
      fixed while proving: "Open in Code" returned a SELECTED link pointing at
      a DELETED thread — the select branch now checks the counterpart lives.
      Honest limitation recorded: a link to an already-vanished Business OS
      object can still be created locally, because the port verifies an
      instance, not an object.

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
- [x] Enforce one canonical capability version lock for both hosts in release
      assembly; fail the build when Code and CTOX resolve different manifests,
      schemas, implementation revisions, or artifact hashes. Done 2026-08-20
      (commits `66e0ee4fc`, `21b5c6466`): dual-host membership is DERIVED from
      each manifest's `supportedAdapters` (never a second list); the committed
      `capability-version-lock.json` is checked by a repo test AND enforced
      inside release assembly, so a divergent artifact is refused before
      packaging. All four dimensions are genuinely enforced for the two
      web-stack capabilities (Code's TS catalog/generated schemas/compiled
      surface strings vs the crate's published fixture, schema and Rust
      source). HONEST GAP, not faked: Greppy is `unenforceable` on all four —
      CTOX runs its own Greppy runtime and this repo pins Greppy for the Code
      host only, so there IS no second value; the check refuses to compare a
      value with itself and a test asserts every unenforceable dimension
      carries its reason. Mutation-verified with 8 proofs, four of them
      editing the real on-disk artifacts and restoring them.
- [x] Add a cross-host conformance gate that invokes every dual-host capability
      through both adapters against the same fixtures and compares canonical
      success/error projections while allowing only documented host-policy
      differences. Done 2026-08-20 (commit `fea754053`): 26 cases across all
      three dual-host capabilities. The Code leg really calls the production
      tool registrations (an unregistered tool surfaces as a defect instead of
      being laundered into a conforming refusal); the CTOX leg reads the
      crate's OWN published fixture — the same file the Rust side is
      independently held to — so there is no private copy. Host-policy
      differences must be declared with a reason (response budget 2 MiB vs
      256 KiB, runtime config store, Greppy's Code-only cwd precondition);
      an undeclared difference fails, and a new dual-host capability with no
      declared coverage fails rather than being skipped. Mutation-verified on
      all three capabilities. Limitation stated: the gate compares
      projections, not two running binaries.
- [~] Make capability availability visible in both UIs from the same catalog:
  per-thread toggles/settings in Code and instance-policy-derived controls
  or status in Business OS, without duplicating capability metadata. Code
  side done 2026-08-20 (commit `935f5e0ec`): one resolver answers the
  question for both hosts and returns the manifest BY REFERENCE, never
  copies; the composer's Tools menu now takes its label, description,
  aria-label and failure toast from the catalog — the hardcoded Greppy
  strings are gone. Availability stays separate from activation, and a
  pinned-but-uninstalled version reports `incompatible` instead of
  silently resolving another. Business OS side needs the CTOX repo: a
  settings surface rendering `CapabilityAvailabilityView[]` plus an MCP
  control method to read those views and write instance activation.

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
      Progress 2026-08-19 (commits `8a3ac7e60`, `3740700cd`): implemented for
      Claude Code and Codex behind the per-instance `routeViaGateway` opt-in.
      Injection happens at session start via a `resolveSessionEnvironment`
      thunk (gateway state is read lazily, so restarts/faults are seen);
      precedence is process env < gateway injection < instance-declared vars.
      Claude: `ANTHROPIC_BASE_URL` + placeholder `ANTHROPIC_API_KEY`
      (`ANTHROPIC_AUTH_TOKEN` asserted absent). Codex, verified empirically
      against codex-cli 0.144.1 with a local probe: `OPENAI_BASE_URL` is
      IGNORED by the binary; routing uses dotted
      `-c model_providers.workjet_gateway.*` overrides through the existing
      `T3CODE_CODEX_LAUNCH_ARGS` seam (30/30 probe hits on
      `POST /v1/responses`; `wire_api` must be `responses`). Grok and
      OpenCode routed 2026-08-19 (commit `c8da109cd`), both verified against
      the real binaries with loopback probes: grok via
      `GROK_MODELS_BASE_URL` (+`XAI_API_KEY`, `/v1`-prefixed — real GETs/POSTs
      observed on gateway routes); opencode via
      `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` inherited by its `serve` child
      (Anthropic- and OpenAI-shaped providers only — other vendors keep
      direct credentials, stated in the overlay). One shared
      `gatewayVersionedBaseUrl()` for all `/v1` consumers; an OpenCode
      instance with an external `serverUrl` is rejected `instance-unroutable`
      instead of silently not routing. Cursor stays unrouted
      (`driver-unsupported`). KNOWN FOLLOW-UP: a grok login session sends the
      user's real xAI JWT to the loopback gateway — the Rust host must
      substitute its own upstream credential, never forward that header.
      Composer model-selection → route resolution done 2026-08-20 (commits
      `c40a03f50`, `094550140`): pure `resolveWorkjetGatewayModelRoute`
      (route patterns most-specific-first > pools > enabled-account catalog;
      `route-ambiguous`/`model-ambiguous`/`model-unrouted` are typed and loud;
      model-unspecified and empty-catalog deliberately skip), the resolved
      provider travels as `X-CTOX-Provider` — the Rust host's ONLY
      per-request selector — via `ANTHROPIC_CUSTOM_HEADERS` (claude, probe-
      verified) and codex `-c …http_headers…` (probe-verified); grok/opencode
      have NO header mechanism and skip resolution honestly. The LLM-routes
      tab now renders the SAME resolver read-only per catalog model. Note:
      nothing writes `pools`/`routes` yet (hand-edited config only), so the
      account fallback is what runs in practice. Still open: a live routed
      turn against a real gateway account (needs the user's first account).
      LIVE FINDINGS 2026-08-19 (user attempted the first real logins):
      (1) BOTH provider OAuth flows are rejected by the real IdPs — Anthropic:
      "Redirect URI http://127.0.0.1:<port>/management/oauth/anthropic/callback
      is not supported by client"; OpenAI: `invalid_authorize_request`. The
      Rust host's authorize construction never matched the official CLI
      clients; fix in flight (evidence-first from the installed claude/codex
      binaries, verified unauthenticated via login-page-vs-rejection probes).
      (2) An orphaned gateway host from a dead server squatted the stable
      port; "Start gateway" then failed as "invalid readiness record" — fixed
      (commit `db483f608`: pid-file reap, stop cleanup, OAuth autostart).
      (3) Provider coverage done 2026-08-20 (commits `d53904e38`…`7f41c7120`):
      an API-key account type (key → ServerSecretStore, config carries only a
      secret reference + 4-char suffix, a literal assertion proves the key
      never serializes) with zai/minimax/xai/kimi — all proxied as OpenAI
      Chat Completions upstream with structural credential substitution (the
      route handler HAS no inbound-header path, settling the grok-JWT
      follow-up); provider selection via `X-CTOX-Provider`. Evidence levels
      recorded per endpoint (xai verified-from-repo; minimax/kimi
      public-docs — confirm with one real key); Z.ai's Anthropic-shaped
      endpoint deliberately excluded (proxy speaks OpenAI upstream only).
      OAuth for xai/kimi not invented; API-key pool round-robins by priority
      without the OAuth cooldown machine (documented).
      (4) UX consolidation done 2026-08-19 (commit `b23da973b`): ONE provider
      surface — Settings → Providers carries "Harness runtimes" and "Workjet
      gateway accounts" as two sections; the Workjet tab is a pointer; no
      Start/Stop buttons (autostart; only a faulted gateway offers Retry —
      add-account now also allowed on a stopped gateway so the flow has no
      dead end); every auth claim shows its probe age ("Authenticated ·
      checked 1h ago") and the page dispatches a fresh provider probe on open
      (30 s cooldown, never for read-only sessions). Behavior change worth
      knowing: the gateway section follows the page's device switcher.
- [ ] Route Codex, Claude Code, Grok, and other T3 provider drivers to the one
      Workjet/T3 gateway runtime.
- [ ] Preserve direct provider/model selection in the composer; selection
      chooses a gateway route/profile rather than bypassing the gateway.
- [ ] Add a CTOX dependency on a pinned Workjet provider-gateway release/tag.
- [ ] Keep one gateway runtime inside every CTOX instance with CTOX-local
      credentials and state.
- [ ] Remove the portable duplicate from CTOX only after its pinned dependency
      passes CTOX provider and Business OS tests.
- [~] Add release artifacts for macOS arm64/x64, Linux x64/arm64, and Windows
  x64/arm64 as required by Workjet and CTOX packaging. Pipeline + contract
  done 2026-08-20 (commits `34ba5de64`…): one source of truth for tag,
  naming (`workjet-provider-gateway-host-<version>-<triple>`), the six
  triples, a release manifest mirroring the CTOX-shell shape
  (sourceCommit + per-artifact sha256) and a consumer pin whose URLs are
  locked to this repo, so a tampered manifest cannot redirect anyone. The
  release is all-or-nothing — `collect` refuses a manifest missing a
  triple (verified). Desktop resolution order: env override, then a
  digest-verified pinned artifact, else local build in development and a
  HARD FAILURE when packaged. TWO targets genuinely built and verified
  here with independently reproduced digests, byte-identical on rebuild
  (aarch64/x86_64-apple-darwin); the four Linux/Windows triples are
  workflow-only and NOT faked — the end-to-end collect/verify/pin run used
  clearly labelled placeholders outside the repo whose digests appear
  nowhere in it. Still open: running the workflow (needs a tag), the two
  unverified ARM runner labels, and wiring the resolver into server
  startup + packaging.
  PIPELINE LANDED 2026-08-20, NO RELEASE TAGGED YET. The artifact contract
  (six target triples, asset naming, detached manifest, sha256sums, tag
  `provider-gateway-host-v*` which cannot collide with `release.yml`'s
  `v*.*.*`) lives in `scripts/lib/provider-gateway-host-artifacts.ts`;
  `scripts/provider-gateway-host-artifacts.ts` stages/collects/verifies/pins
  and is exactly what `.github/workflows/provider-gateway-host-release.yml`
  calls. Consumer side mirrors the CTOX-shell precedent:
  `apps/desktop/resources/provider-gateway/host-release.pin.json` +
  `apps/desktop/src/providerGateway/ProviderGatewayHostArtifact.ts`
  (packaged builds accept ONLY a digest-verified pinned artifact;
  development falls back to the existing local build and says why).
  VERIFIED LOCALLY: `aarch64-apple-darwin` (17 311 904 B, sha256
  `bebddae6…95ec1`) and `x86_64-apple-darwin` (18 693 696 B, sha256
  `db8d6ea2…6b7f9`) built and digest-checked; the other four triples cannot
  be built on macOS and were NOT faked — only the workflow covers them. See
  `docs/workjet-provider-gateway-host-artifacts.md` and its
  `.local-builds.md` evidence file. STILL OPEN: tag the first release, then
  replace the `unreleased` pin with the workflow's emitted pin — that is
  what unblocks the CTOX pinned dependency and the portable-duplicate
  removal above.

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

Reconciliation audit 2026-08-20: every unchecked item in this section and in
the mailbox subsection below was re-read against the code and its tests, and
each box now carries either the files/tests that justify a tick, the precise
remaining delta behind a `[~]`, or a "verified open" note naming what is
actually missing. Acceptance evidence for the audit itself:
`pnpm test run src/workjet/` in `apps/server` → 32 files, 489 tests, all
green. Four claims in this section were found to be WRONG rather than merely
stale and are marked CORRECTION in place: the `pools`/`routes` "dead schema"
verdict, the "completion/cancellation/retry/remote coordination remain future
work" clause on fire-and-forget dispatch, the thread-UI reassign-port
follow-up, and the superseded "Open" list on the provider-account surface.

- [x] Add a radio-style `Code | Orchestrator` control without replacing the
      existing provider-specific Plan/Build control. Done 2026-08-20 (commit
      `934b3d029`): the composer's left cluster now carries a role radio next
      to Plan/Build, with the constraint made ASSERTABLE — the cluster moved
      into `ComposerFooterControls` so one test can prove both controls render
      together (plan mode, a provider without an interaction toggle, and the
      worker state each keep Plan/Build). WORKER is a read-only third state,
      not a greyed pair: the contract's worker variant REQUIRES a parent
      reference only the dispatching orchestrator knows, so a client-side
      conversion would orphan the worker; `aria-disabled` rather than
      `disabled` keeps the tooltip that carries the reason. A role change
      takes effect at the next session (the role compiles into the provider
      system prompt at session start) and says so. Compact footer gets the
      role as a menu radio group. Bug found while wiring: the optimistic
      override compared only `enabledCapabilityIds`, so a role change flicked
      back to Code before the projection caught up.
- [x] Add a neighboring settings gear for Workjet configuration. Done
      2026-08-20 (commit `934b3d029`): navigates to the EXISTING
      Settings → Workjet surface as a plain push, so the settings screen's own
      back/Escape returns to the thread. No second configuration surface.
- [~] Port the Swift Workjet configuration model into versioned Code-mode
  contracts and migrations: orchestrator prompt, progress-board policy,
  worker catalog, provider/model selection, computer target, telemetry,
  execution limits, and verification state. Do not make the Electron
  renderer or the legacy Swift application an authority for these values.
  Audited 2026-08-20: six of the seven sub-items are landed and verified;
  the only remaining gap is the last sub-item below (progress-board policy
  and verification state have no field and no code at all).
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
  - [~] Port the progress-board policy, verification state, provider capacity,
    and inspectable one-shot migration/version steps from the Swift model.
    Audited 2026-08-20, one of four done. DONE — inspectable one-shot
    migration/version steps: `WORKJET_CONFIGURATION_SCHEMA_VERSION = 2` and
    the versioned decode transform in
    `packages/contracts/src/workjet.ts:202-218`, the exported pure step
    `migrateWorkjetLlmRouteV1ToV2` (`:123-129`) and the lenient persisted
    reader `WorkjetLlmRoutePersisted` (`:137-153`), covered by
    `packages/contracts/src/workjet.test.ts` describe "Workjet
    configuration migration step 2 (LLM route reference retype)" (four
    tests, incl. "upgrades a persisted v1 configuration to v2 while
    carrying route ids over"). PARTIAL — provider capacity: the only
    capacity field is a PRESENCE FLAG, `WorkjetGatewayHealth.capacity:
"reported" | "not-reported-by-host"` (`workjet.ts:588-592`, `:632`),
    hardcoded to `not-reported-by-host` by
    `apps/server/src/providerGateway/ProviderGatewayService.ts:1123-1124`
    because the Rust host publishes no route for it; there is no capacity
    FIGURE anywhere and `WorkjetExecutionConfiguration`
    (`workjet.ts:183-188`) carries only probe/turn timeouts and
    `degradationAllowed` — no parallel-worker ceiling. OPEN — progress-board
    policy and verification state: neither exists as a field on
    `WorkjetConfigurationValue` (`workjet.ts:221-233`) and a repo-wide grep
    for `progressBoard`/`progress-board`/`verificationState` returns zero
    Workjet code hits (the `verificationState` hits are web-research result
    metadata in `apps/server/src/mcp/toolkits/workjet/WebStackResearch.ts`).
- [~] Replace the current Greppy-only `/settings/workjet` page with the native
  CTOX Code configuration surface covering Prompt, Providers, Computers,
  Telemetry, Execution, and the editable worker catalog. Preserve the
  existing per-thread provider/model controls rather than hiding them
  behind global Workjet defaults. Audited 2026-08-20: the surface itself is
  complete (three sub-items ticked below); what remains is the live provider
  round trip and live harness availability, both sub-items below.
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
  - [~] Add the real provider-account surface backed by the shared Rust
    provider gateway, environment-scoped secure credentials, account
    pools, health/capacity, and model discovery. Do not reuse the existing
    Codex/Claude/Grok provider-driver list as the LLM provider catalog.
    AUDIT 2026-08-20 — five of the six gaps this entry lists as "Open"
    below are in fact CLOSED; only the live provider round trip stands.
    Closed and verified: settings UI + client-runtime wiring
    (`packages/client-runtime/src/state/server.ts:768-836`, exported
    `:1013-1021`;
    `apps/web/src/components/settings/useWorkjetGatewaySection.ts:45-83`;
    mounted in `ProviderSettingsPanel.tsx:314-333` and
    `WorkjetSettings.tsx:939`); pools/weights editing
    (`WorkjetGatewayAccountRoutingUpdate` in `workjet.ts:678-701`, RPC
    `workjet.providerGateway.updateRouting`,
    `ProviderGatewayService.ts:1220-1245` re-decodes before writing, UI
    `WorkjetGatewayPools.tsx:142-205` with tests "offers a weight field
    only where the gateway reads weights"); health (RPC + service
    `ProviderGatewayService.ts:159`, aged reading in
    `WorkjetGatewayPools.tsx:214-260`, test "ages a reading rather than
    presenting it as live"); model discovery (`workjet.ts:643-675`, RPC
    `discoverModels`, test "separates catalog models from configured models
    and names a missing catalog"); and harness routing through the gateway
    — a real agent session now routes its LLM calls through it:
    `routeViaGateway` on the provider instance
    (`packages/contracts/src/providerInstance.ts:142`), toggle in
    `ProviderInstanceCard.tsx:499-504`,
    `resolveGatewayRoutedEnvironment` in
    `apps/server/src/provider/ProviderGatewayRouting.ts:414-460` called at
    session start by all four drivers (Claude/Codex/Grok/OpenCode), the
    model's provider carried as `X-CTOX-Provider`, and a typed
    `ProviderGatewayRoutingError` instead of any silent fallback to the
    CLI's own credentials (nine tests in
    `apps/server/src/provider/ProviderGatewayRouting.test.ts`).
    CORRECTION 2026-08-20 — the "DEAD SCHEMA" verdict below is WRONG.
    `WorkjetGatewayCatalog.pools`/`.routes` (`workjet.ts:562-581`) are
    live, load-bearing, and user-visible. They are parsed and validated
    from `provider-gateway.json`
    (`ProviderGatewayConfig.ts:400-446` `parsePools`, `:448-…`
    `parseRoutes`, `:544-546`), copied into the emitted catalog
    (`:676-677`), and PRESERVED across every account append and routing
    update (`ProviderGatewayService.ts:901-902`, `:1017-1018`,
    `:1233-1234`). They are honoured on the hot path:
    `resolveWorkjetGatewayModelRoute`
    (`packages/contracts/src/workjetGatewayRouting.ts:170-233`) resolves
    routes first, then pools, and
    `apps/server/src/provider/ProviderGatewayRouting.ts:396-409` calls it
    at EVERY routed session start, failing the session typed on
    `route-ambiguous`/`model-ambiguous`. They are user-visible through
    `WorkjetGatewayModelRoutes.tsx:32-70`, mounted at
    `WorkjetSettings.tsx:939`, which names the route/pool a model resolved
    through. Seven contract tests in `workjetGatewayRouting.test.ts` plus
    `ProviderGatewayRouting.test.ts` "lets an explicit route override which
    provider the model resolves to" pin the behaviour. The claim was
    already false when written: the routing resolver landed in
    `801ef24e4` at 02:14 on 2026-08-20, the "dead schema" note in
    `5bd652f55` at 11:20 the same day. What IS true — and all the sibling
    actually proved — is that the RUST HOST has no named pool object and
    never receives `pools`/`routes` (`rustHostConfiguration` omits them),
    and that no UI writes them: they are an operator-authored, Node-side
    routing table.
    Pools, health and model discovery done 2026-08-20 (commits
    `5bd652f55`, `0a358ba3b`) — each limited to what the host can actually
    answer, verified against its source. Pools: the host has NO named pool
    object, one per provider only, so the contract's `pools`/`routes` are
    not honoured BY THE HOST — `rustHostConfiguration` omits them, and no UI
    writes them (KORREKTUR to an earlier wording here that called them
    "dead schema": that was wrong. The composer's route resolver landed
    hours earlier and DOES honour them on the hot path at every routed
    session start, failing typed on ambiguity — see the correction note
    above); exposed
    instead are the host's real semantics — a single runtime-wide routing
    strategy (Node was hardcoding round-robin, so `weight` had been inert),
    priority-exclusive OAuth pools vs round-robin API-key pools, and
    `weightHonored` only where the host reads it, so the UI shows no weight
    field where it would do nothing. Health: endpoint phase and per-provider
    counts are published and shown with honest ages; per-account cooldown,
    rate-limit and capacity are `not-reported-by-host` — the host HAS that
    state in an in-process store but publishes no route for it. Discovery:
    the host's model catalog is a COMPILE-TIME list, not an upstream call,
    and every model is labelled accordingly; zai and minimax have no
    channel at all and say so rather than showing an empty list.
    Environment scoping is PROVED on both sides (decode refuses foreign
    scopes and traversal; two gateways side by side touch only their own
    state). Real gap fixed: Node accepted a bare `.` secret name the host
    refuses — that combination wrote a config the host would not start on.
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
    focused service tests). Open (superseded list — see the AUDIT note at
    the top of this item; only the first entry still stands as of
    2026-08-20): settings UI + client-runtime wiring (in
    flight), live provider round trip (dynamic loopback redirect port
    unverified against real OAuth client registrations), pools/weights
    editing, health/capacity, model discovery beyond configured models,
    and harness routing through the gateway.
    REMAINING 2026-08-20, verified: (1) the live provider round trip —
    `apps/server/src/providerGateway/` has no e2e/live-host harness and no
    recorded successful OAuth login against a real client registration;
    (2) per-account capacity, cooldown, and rate-limit stay
    `not-reported-by-host` because the Rust host publishes no route for
    them; (3) harness routing is proven at the environment/argv layer
    against a test gateway layer, not by an executed completion through a
    running host — the same residue as (1).
  - [ ] Replace declared harness availability with live environment-scoped
        inspect/install/update/remove actions and consume the resulting truth
        during worker validation and dispatch.
        Verified open 2026-08-20: availability is still a hand-toggled static
        boolean — `WorkjetHarnessConfiguration = { harness, available:
Schema.Boolean (default false), executableOverride? }`
        (`packages/contracts/src/workjet.ts:50-55`), flipped by a Switch in
        `apps/web/src/components/settings/WorkjetComputerEditor.tsx:246-254`
        under the copy "Declare what is available on this existing
        environment". Its ONLY consumer is a client-side advisory warning in
        `WorkjetWorkerEditor.tsx:126-129` that does not block the save; the
        server never reads it (`apps/server/src/workjet/WorkerDispatch.ts` and
        `apps/server/src/mcp/toolkits/workjet/WorkerTool.ts` contain zero
        harness references). No harness inspect/install/update/remove RPC
        exists — the Workjet RPC surface (`packages/contracts/src/rpc.ts:330-345`)
        has `workjet.greppy.inspect|install` (a capability runtime, not a
        harness) and `workjet.worktrees.inspect`, and nothing else.
- [x] Add an orchestrator-scoped worker overview showing child threads grouped
      under their parent with task, harness/model, environment/computer,
      delivery/turn state, completion/result state, and actionable links to
      open the ordinary worker thread. Done 2026-08-19 (commits `5dcbfa61d`,
      `c91c563f5`): a pure `groupWorkerThreads` selector (parent→children +
      unlinked-workers bucket, same-environment orchestrator parents only) and
      an additive collapsible "Workers (N)" section at the top of the
      orchestrator thread view with model/provider/turn-state and open-thread
      links, no new server RPC. Harness/computer labels are omitted honestly
      (client state carries model + provider name, not a separate
      harness/computer label).
- [x] Keep the normal Code sidebar authoritative: every created worker remains
      visible as an ordinary local or remote thread even when the specialized
      orchestrator overview is closed. Verified 2026-08-19: the sidebar does no
      role-based filtering; a test asserts worker threads stay in the source
      thread list independent of the overview.
- [~] Migrate existing Swift Workjet configurations through a one-shot,
  inspectable import/export path; after parity is proven, CTOX Code must
  not require the Swift runtime or its local store. Reader, mapping and
  runner done 2026-08-20 (commits `e89873c6a`, `b23729f49`, `a6b2c5e1b`,
  47 tests). The format was NOT guessed: the real
  `~/Library/Application Support/Workjet/config.v1.json` (62 KB) plus six
  dated backups were read READ-ONLY, and the complete key universe and
  every enum raw value were recovered from the shipped app binary's
  CodingKeys tables — two keys exist there that appear in no live
  document, which is why the sample alone was not enough. All seven real
  documents decode with ZERO unknown fields. The reader fails closed and
  never silently drops: 74 source leaves are each mapped, folded into the
  managed prompt, or dropped WITH a reason (46), and 5 sourceless
  destinations state their default. A wrong first assumption
  (`reasoningEffort: ""` meaning automatic) was caught by the real data —
  the key is simply absent — which is what fail-closed is for. DECISIVE
  FINDING: computer→environment, provider→gateway-account and pool→route
  cannot be carried over at all (the Swift ids are UUIDs and CLIProxy
  hashes; no value would ever resolve), so they are operator BINDINGS and
  unbound records land in `pending` instead of a silent partial import —
  on the real config: 3 computers, 7 providers, 4 pools, 12 workers. The
  runner lives server-side because the authority is `settings.workjet` in
  each environment's own settings and the legacy file belongs to the
  machine that server runs on. Remaining: no offer surface is wired — the
  service exposes decision/offer/accept/decline but no RPC or settings
  panel calls it yet, and `make` resolves the decision eagerly, which
  wants a look before it goes on the boot path.
  Verified open 2026-08-20: nothing exists. There is no import/export RPC
  in `packages/contracts/src/rpc.ts`, no importer/exporter module anywhere
  under `apps/` or `packages/`, and no Swift source or Swift Workjet store
  in the tree. The only migration machinery is the in-schema
  `migrateWorkjetLlmRouteV1ToV2`, which migrates T3's OWN v1 config to v2,
  not a Swift document.
- [x] Compile deterministic Workjet role instructions through the existing
      managed-prompt path used by Codex, Claude Code, and Grok.
- [x] Keep user/developer instructions clearly separated from managed Workjet
      instructions.
- [x] Create the first same-environment worker thread through normal T3
      `thread.create` and `thread.turn.start` commands, exposed only through the
      orchestrator-scoped `workjet_dispatch_worker` MCP boundary.
- [~] Store parent/child references and worker status as durable events.
  Audited 2026-08-20 — the two halves differ, and the wording matters.
  PARENT/CHILD: genuinely durable EVENTS. The worker variant of
  `WorkjetThreadConfig` makes `parent` mandatory
  (`packages/contracts/src/workjet.ts:401-406`), and that config travels in
  the orchestration event log — the `thread.created` event payload carries
  `workjetConfig` (`apps/server/src/orchestration/decider.ts:370-383`,
  projected at `projector.ts:290-305`) and every later change is a
  `thread.workjet-config-set` event (`decider.ts:915-932`,
  `projector.ts:493-506`). WORKER STATUS: not an event, in either
  mechanism. (a) For threads created by `workjet_dispatch_worker`, status
  is derived CLIENT-SIDE by `resolveWorkerTurnState`
  (`apps/web/src/components/WorkjetWorkerOverview.tsx:58-71`) from the
  projected `latestTurn.state` plus `session.status`; nothing durable
  records "this worker's status" and nothing addresses the parent. (b) For
  delegations, status is a MUTABLE ROW COLUMN — `workjet_delegations.state`
  in `apps/server/src/persistence/Migrations/042_WorkjetMailbox.ts`, moved
  by `transitionDelegationState` inside one transaction. There is no
  append-only delegation-state event table anywhere in migrations 042-052.
  The durable events that do exist are DERIVED and BEST-EFFORT: each
  `appendActivity` is a separate `thread.activity.append` dispatch piped
  through `Effect.ignore`
  (`apps/server/src/workjet/mailbox/WorkjetDelegationExecutor.ts:574-601`,
  `WorkjetMailboxDelivery.ts:503-527`), and the redacted audit stream is
  IN-MEMORY ONLY — a 128-entry ring buffer plus a sliding PubSub in
  `WorkjetMailboxAuditEmitter.ts`, with no table behind it. Remaining
  delta: an append-only per-delegation state event log (or an equivalent
  transactional trace), and any durable status record for
  dispatch-workers.
- [~] Add bounded dispatch, cancellation, retry, timeout, and result-return
  semantics.
  Audited 2026-08-20: all five exist for the DELEGATION path and none
  exist for the `workjet_dispatch_worker` path. Delegations — bounded
  dispatch: `WORKJET_DELEGATION_EXECUTOR_BATCH_SIZE = 32` and one turn per
  thread per cycle (`WorkjetDelegationExecutor.ts:109-115`; test "starts
  only one turn per thread per cycle even with two delivered
  delegations"); cancellation: the `cancelled` terminal state and
  `workjet.mailbox.updateDelegation` (`WorkjetMailboxStore.test.ts`
  "rejects an illegal transition and keeps a terminal delegation
  immutable", delivery test "cancels a delegation with no graph edge");
  retry: a turn-start command id derived from the delegation id so a retry
  is idempotent by command receipt, transient failures retried and
  non-retryable engine rejections made terminal (tests "retries an
  accepted row with the same command id after a transient rejection",
  "fails a delegation the engine rejects for a non-retryable reason");
  timeout: the delegation budget's `expiresAt`
  (`packages/contracts/src/workjetMailbox.ts:376`) swept in one
  transaction (store test "sweeps overdue outbox, inbox, and non-terminal
  delegation rows in one pass") plus a 60 s per-cycle guard; result-return:
  migration 047 plus the executor's completion path. `workjet_dispatch_worker`
  (`apps/server/src/mcp/toolkits/workjet/WorkerTool.ts`,
  `apps/server/src/workjet/WorkerDispatch.ts`) still only creates a thread
  and starts its first turn — it has no cancel, no retry, no timeout, and
  no result return, and the tool description says so ("returns immediately
  after dispatch and does not wait for completion"). Remaining delta:
  either give the dispatch-worker path the same semantics or retire it in
  favour of a delegation.
- [~] Treat worker completion as an event, not as a UI-only observation.
  Audited 2026-08-20. For DELEGATIONS this is largely met: the executor's
  running-scan completes only the exact turn it dispatched (message-id +
  turn-id + session correlation), writes a durable
  `WorkjetDelegationResult` row (migration 047), and then returns it — as a
  durable `workjet.delegation.result` thread activity on a
  same-environment source (`WorkjetDelegationExecutor.ts:131`, `:1026-1044`)
  or as a signed pending-outbound result envelope cross-environment, with
  migration-049 markers making redelivery exactly-once (tests "completes a
  running delegation whose dispatched turn ended and returns the result",
  "enqueues a result envelope outbound for a cross-environment source",
  "retries a transiently failed result enqueue on the next cycle, exactly
  once"). Precise remaining delta, in order of weight: (1) for
  `workjet_dispatch_worker` workers there is STILL no completion event of
  any kind — the orchestrator learns of completion only by the client
  re-deriving `latestTurn.state` in
  `WorkjetWorkerOverview.tsx:58-71`, which is exactly the UI-only
  observation this line forbids; (2) even for delegations the completion
  EVENT is best-effort (`Effect.ignore`), so a failed append leaves a
  completed delegation with no timeline trace while the row stands; (3)
  the `delegation-completed` audit event is in-memory only.
- [x] Support initial fire-and-forget worker dispatch in the same environment;
      completion, cancellation, retry, and remote coordination remain future work.
      CORRECTION 2026-08-20: the trailing clause is no longer true. Completion,
      cancellation, retry, and cross-machine coordination all landed for the
      delegation path (see the three items above and the mailbox section); they
      remain absent only for `workjet_dispatch_worker` itself.
- [x] Add cross-environment dispatch only after a durable server-to-server
      coordinator exists; current client-only federation is insufficient.
      Gate MET and cross-environment dispatch SHIPPED, verified 2026-08-20.
      The coordinator is durable at both ends and lives in the SERVER, not a
      client: migration 042 gives every server its own transactional
      outbox/inbox/delegation tables with idempotent dedup, bounded
      backoff-to-dead-letter, and an expiry sweep; and
      `apps/server/src/server.ts:542-561` merges `WorkjetMailboxTransport.layer`
      and the single `WorkjetDelegationExecutorLive` into the routes layer as
      background loops with no request scope — they run whether or not any
      browser or desktop is open, which is precisely what "client-only
      federation is insufficient" was written against. The carrier is
      deliberately dumb: the local CTOX daemon replicates opaque bounded blobs,
      while signature verification, key binding, idempotent insertion, and all
      delegation effects stay in the Workjet server
      (`WorkjetMailboxTransport.ts` `ingest` → `applyDeliveredDelegation` in
      `WorkjetMailboxDelivery.ts:406-421`). The loop closes end to end: a
      cross-env delegation's prompt bytes travel sealed and are
      digest-reverified into the receiver's snapshot store BEFORE the
      delegation row is written (transport test "stores received snapshot bytes
      and makes the delegation executable"), the receiving executor runs it as
      a normal `thread.turn.start`, and a signed result envelope is enqueued
      back with durable redelivery markers (migration 049). QUALIFICATION, so
      the tick is not read as more than it is: this is not a server-to-server
      SOCKET. The hop is server → local daemon loopback → CTOX room peer →
      remote daemon → remote server, so by the 2026-08-18 owner decision (no
      relay) the two daemons must be online at overlapping times; an envelope
      waits durably in the local outbox meanwhile. And the whole path is proven
      in-process and at the two-daemon level only — never between two real
      machines (see the E2E item at the end of the mailbox section).
- [x] Never copy the old Swift SSH/snapshot remote protocol into T3. T3 remains
      the workspace and remote-environment authority.
      Invariant verified HELD 2026-08-20 (this is a constraint, not a
      deliverable): the only `ssh` token in the Workjet contracts is the
      presentation-only literal in `WorkjetComputerPresentationKind`
      (`packages/contracts/src/workjet.ts:41-48`), carrying the comment
      "Presentation only. The referenced Code environment remains transport
      authority." There is no SSH reference anywhere under
      `apps/server/src/workjet/`; the actual remote protocol is the CTOX daemon
      loopback plus the replicated envelope collection.
- [~] Preserve direct activation of LLM/provider combinations on orchestrator
  and worker threads.
  Audited 2026-08-20: structurally true, not yet assertable. No role gating
  exists on the provider/model path — `ProviderModelPicker` in
  `apps/web/src/components/chat/ChatComposer.tsx:3026-3049` takes no
  `workjetRole` prop at all, the only `disabled` logic in
  `WorkjetRoleControl.tsx:214-215` disables the ROLE radio (not any
  provider control), and the server applies `command.modelSelection`
  (`apps/server/src/orchestration/decider.ts:834`) with no Workjet role
  check, `thread.workjet-config.set` being a wholly separate case. Workers
  keep an explicit per-worker combination:
  `apps/server/src/workjet/WorkerDispatch.ts:162` (`input.modelSelection ??
parent.modelSelection`) applied to both create and turn-start, proven by
  `WorkerDispatch.test.ts` "accepts a capability subset and canonical model
  override including options". Remaining delta: no test asserts the
  PICKER itself stays rendered and enabled on an orchestrator or worker
  thread — `ComposerFooterControls.test.tsx` proves co-existence with
  Plan/Build, which is a different control one level down. Make the
  invariant assertable the way the role/Plan-Build one deliberately was.

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

- [x] Define a globally routable worker address as account/workspace authority
      plus `environmentId` and `threadId`; keep harness and provider IDs out of
      the address so a thread can change model without breaking the route.
      Done 2026-08-19 (commit `fe58d3bfc`): `WorkjetWorkerAddress` in
      `packages/contracts/src/workjetMailbox.ts` — opaque bounded
      `WorkjetMeshWorkspaceId` (CTOX pairing charset, no account/room/signaling
      material) + `environmentId` + `threadId`; a test asserts the exact key
      set contains no harness/provider field.
- [x] Add versioned contracts for `WorkerMessage`, `Delegation`,
      `DelegationRef`, delivery receipt, result, review verdict, and bounded
      artifact/context references. Done 2026-08-19 (commit `fe58d3bfc`,
      46 focused tests): sealed-or-inline message bodies (inline bounded to
      the same-environment fast path), digest-pinned prompt snapshots,
      bounded scope/budget/artifact references, delegation graph edges
      (`reviews | revises | follows-up`), the `WorkjetThreadHandoff` contract
      from the portability decision, and a separate `WorkjetRoutingEnvelope`
      that IS the only relay-inspectable projection (routing + expiry + source
      signature; payload fields are unrepresentable on it).
- [x] Model delegation states explicitly: `queued | delivered | accepted |
running | needs-input | review-requested | changes-requested | completed |
failed | cancelled | expired`. Done in the same commit
      (`WorkjetDelegationState`, terminal set exported).
- [~] Persist source outbox, target inbox, delegation state, and thread-visible
  message/delegation events transactionally on their authoritative servers.
  AUDIT 2026-08-20: the first three are done and transactional; the FOURTH
  is not, and the word "transactionally" is where the gap sits. Outbox,
  inbox, and delegation state all live in migration 042 with
  single-transaction transitions and a one-pass expiry sweep (store tests
  "encodes the transition table exactly as documented", "walks the full
  legal delegation lifecycle", "sweeps overdue outbox, inbox, and
  non-terminal delegation rows in one pass"). The thread-visible
  message/delegation events are NOT in that transaction: every
  `appendActivity` is a separate engine dispatch piped through
  `Effect.ignore` (`WorkjetMailboxDelivery.ts:503-527`,
  `WorkjetDelegationExecutor.ts:574-601`), deliberately, so a refused
  append cannot turn an executed delegation into a reported failure — but
  the consequence is that a row can land with no timeline trace. Second
  gap: the cross-environment INBOUND path appends no thread activity at
  all. The shared helper `applyDeliveredDelegation`
  (`WorkjetMailboxDelivery.ts:406-421`) only transitions the row, and
  `WorkjetMailboxTransport.ts` contains no `thread.activity.append`
  anywhere, so `workjet.delegation.received` / `workjet.message.received`
  are emitted only by the same-environment fast path. A remotely delivered
  delegation first appears on the target timeline as the executor's
  `workjet.delegation.started`.
  Progress 2026-08-19 (commits `d7aae00b2`, `3d48fd5f4`): migration 042 and
  the standalone `WorkjetMailboxStore` are done — transactional outbox
  (pending|delivered|dead with bounded exponential backoff to a queryable
  dead-letter state), idempotent inbox insertion mirroring the delivery
  receipt statuses (accepted-new / duplicate-ignored / expired, expiry
  checked before dedup), the enforced delegation state machine (single
  transaction, no TOCTOU; `running → completed` legal for zero-review-round
  budgets), a one-transaction expiry sweep, and corrupt-row surfacing as
  typed errors (19 focused tests). Progress 2026-08-19, slice 3
  (commit `837331d58`): the store is wired into the server routes layer,
  `WorkjetMailboxDelivery` implements the same-environment local fast path
  (enqueue → idempotent inbound → delivered receipt; cross-environment
  sends stay pending outbound; duplicate envelopes skip delegation
  effects — exactly-once effects under at-least-once delivery), and
  thread-visible durable traces ride the existing
  `thread.activity-appended` event as four `workjet.message/delegation.*`
  activity kinds with payload-material canary tests. MCP tools
  `workjet_send_message` and `workjet_delegate_task` are registered
  orchestrator-scoped (least privilege until the reply/ACL items land).
  Progress 2026-08-19, slice 4 (commits `4f37e2202`, `d47dcbdf5`,
  `69535cb0e`): routing envelopes are now Ed25519-signed against a durable
  per-environment mesh identity (private key create-once in the
  ServerSecretStore, never exported; domain-tagged canonical
  serialization exported for the transport slice; local inbound verifies
  before insertion and rejects `invalid-signature`); the source workspace
  id comes from the identity service, not the caller (generated mesh id
  documented as the pre-pairing fallback until the CTOX-room-derived
  identity lands); and `workjet_delegate_task` takes bounded prompt TEXT,
  stores it in the content-addressed immutable snapshot store beneath the
  server state root (digest-sharded, atomic, reverified on read), and
  pins the delegation to the digest the server itself wrote. Still open:
  payload sealing (encryption) to the target environment key, peer-key
  distribution, the CTOX-Sync transport itself, the reconciler, and the
  thread UI.
- [~] Replicate the per-machine durable mailboxes and the redacted activity
  projection over the CTOX Sync WebRTC data plane between the user's own
  machines (primary transport per the 2026-08-18 owner decision), joined
  through the existing CTOX pairing invite flow (room + room password +
  signaling URLs) with the engine's capability/session layer and
  device-scoped revocation; signaling via ctox.dev or the user's own
  instances. No new relay service and no T3 Connect identity reuse for
  mesh membership; an always-on user-owned CTOX instance covers
  store-and-forward if ever needed.
  Transport architecture (2026-08-19, docking decision): the Workjet
  server does NOT embed its own WebRTC peer. Each machine's LOCAL CTOX
  daemon carries a dedicated `workjet_mailbox_envelopes` synced collection
  and replicates it through its existing native peer, room membership,
  capability/session layer, and device revocation — the sync engine is
  reused as-is. The Workjet Code server exchanges envelopes with its local
  daemon over a loopback intake/outtake surface only (bounded, no
  Business-OS data access), and remains the sole authority over its own
  outbox/inbox semantics: envelope signature verification, idempotent
  insertion, and delegation effects all stay in the Workjet mailbox store.
  The daemon treats envelope payloads as opaque bounded blobs.
  PROVEN 2026-08-19 at the two-daemon level: CTOX rc-branch commits
  `0faa62a12` (native peer presents its capability token in the
  ctoxProtocol handshake), `b4fedd2ba` (a room-joining native peer
  initiates offers — the symmetric handler otherwise waits forever),
  `caa12db8f` (`ctox workjet mesh join|status|leave`, membership under
  the state root 0600, own-room guard, mailbox-only session scope), and
  `eeb62b667` (loopback writes carried malformed revisions and
  schema-invalid tombstones — updates and retirements were silently
  dropped by every peer, browsers included; fixed). The decisive test
  `two_daemons_replicate_only_the_mailbox_across_a_mesh_join` runs two
  real daemons on two storage roots against a real signaling server:
  envelope A→B, envelope B→A, and an expiry tombstone all replicate
  (11.3 s; independently re-verified). Client auth satisfies the
  serving daemon's real signaling-partition and capability validators —
  nothing serving-side was relaxed. Trust binding resolved 2026-08-20
  (commits `ce4ceb09f`…, migration 050): the room-derived MAC was
  investigated and REJECTED as security theater — writing into the
  replicated collection already requires the room secret, so a MAC keyed
  on it proves nothing more. Instead a REAL live hole was found and
  closed: `payload_json` was unsigned, so any room member could republish
  an honest envelope with a substituted X25519 encryption key and read
  every later sealed reply. Wrapper v3 adds a detached Ed25519
  `keyBinding` over {envelope, addresses, both public keys}, verified
  against the envelope's signer before any pin; downgrades are refused
  (`binding-downgrade`) and audited (`mesh-peer-binding-rejected`); the
  roster and send panel show the honest trust level (`tofu` |
  `self-signed` — nothing shipped earns "room-bound"). REMAINING,
  honestly: pure first-contact impersonation (attacker reaches an
  environment id first with a key it holds) needs a CTOX-daemon device
  attestation — out of Workjet's reach. Follow-up once the fleet emits
  v3: refuse v1/v2 wrappers outright. Still open: a live (non-test)
  two-machine run.
  Progress 2026-08-19: both sides are implemented. CTOX rc-branch commit
  `9518d2ae0` adds the replicated `workjet_mailbox_envelopes` collection
  (bounds/charset validation only, payload ceiling 200 000 B derived from
  the real 262 144-B replication chunk budget, tombstoning expiry sweep)
  plus the authenticated loopback publish/pending/consumed routes on the
  MCP-channel listener, landed line-count-neutrally against the exact
  module-size ratchets. Workjet commits `062922610` + `c6f0e0f3d` add
  migration 043 (peer-key pinning) and `WorkjetMailboxTransport`: 10-s
  jittered poll loop that idles cleanly until descriptor+token resolve
  (token via CTOX's first-class `ctox secret get
business_os/mcp_inbound_auth_token` path, operator-overridable), pushes
  pending outbound with the existing backoff-to-dead-letter, pulls and
  verifies inbound (signature against the sender key with TOFU key
  continuity as the DOCUMENTED interim until CTOX-room-derived identity
  binding; poison envelopes consumed, never looped), and reuses the local
  fast path's delegation semantics via a shared helper. Still open: the
  real two-instance replication proof, inbound thread-activity traces,
  in-cycle cursor following for >50 backlogs, payload sealing, and the
  key-rotation path.
  AUDIT 2026-08-20, re-verified against this tree. CLOSED since that note:
  payload sealing (see the sealing item below) and cross-machine snapshot
  transfer. STILL OPEN, each confirmed in code: (1) the live two-machine
  run — nothing in this repo boots two hosts, every transport test drives a
  fake daemon `HttpClient` stub, and the cited
  `two_daemons_replicate_only_the_mailbox_across_a_mesh_join` is two
  processes on one host in the CTOX repo; (2) inbound thread-activity
  traces — `WorkjetMailboxTransport.ts` appends no thread activity at all
  (see the item above); (3) in-cycle cursor following — `next_cursor` is
  decoded (`WorkjetMailboxTransport.ts:595`) and then never used, so a
  backlog drains one `WORKJET_TRANSPORT_PULL_LIMIT = 50` page per 10 s
  cycle (`:173-176`, `pull` at `:1581-1636`); (4) key ROTATION is refused,
  not supported — the tests "rejects and consumes an envelope whose sender
  key rotated" and "…whose ENCRYPTION key rotated" pin the refusal, and no
  re-pin path exists.
- [~] Add the typed thread-handoff contract and flow (immutable prompt/context
  snapshot, bounded artifact references, pushed or sync-bundled Git branch,
  durable source-thread link); the target machine continues in a new
  thread with any harness/LLM. Prove a real machine-A → machine-B handoff
  including a worker worktree branch. Flow done 2026-08-20 (7 commits
  `b92a24ba3`…`28c75b65b`, migration 051): server-composed bounded
  snapshot (header + operator note + newest-first byte-bounded message
  tail, 40 msgs/8k chars/256KiB, no events/tools/paths), send RPC
  (orchestrator-source), transport shares the delegation snapshot-bytes
  path, received handoffs recorded idempotently, list RPC + accept RPC
  (creates ONE standalone thread seeded with the snapshot, race-safe
  claim, durable backlink + accepted activity), composer "Hand off" tab +
  received-handoff inbox beside the worker overview. Honest gaps: branch
  ref carries branch+remoteConfigured only (no headCommit read yet, no
  push — never silent); cross-env acceptance notification has no envelope
  kind yet; the REAL machine-A→machine-B proof needs the live two-machine
  mesh run.
  AUDIT 2026-08-20: all three stated gaps re-verified as real and accurately
  described — the box correctly stays `[~]`. (a) `WorkjetHandoffBranchRef`
  (`packages/contracts/src/workjetMailbox.ts:617-627`) has `headCommit` as an
  optionalKey that nothing ever writes; `handoffBranchOf`
  (`WorkjetMailboxRpc.ts:383-404`) takes only the projection's branch NAME plus
  a boolean, and `remoteConfigured` comes from a local config read that "never
  runs `git ls-remote` and never pushes" (`apps/server/src/ws.ts:467-490`);
  tests "never claims the branch was pushed and never leaks a filesystem path",
  "says the head is unknown rather than inventing one". (b)
  `WorkjetMailboxEnvelopeKind`
  (`packages/contracts/src/workjetMailbox.ts:687-694`) is
  `message|delegation|receipt|result|review|handoff` — no acknowledgement kind;
  `WorkjetMailboxDelivery.ts:1497-1500` says so in place, and the gap is pinned
  by the test "never appends an acceptance activity onto a thread another
  machine owns". Consequence to keep visible: after a cross-machine handoff,
  machine A never learns machine B continued the work. (c) every cross-env
  handoff test runs against the fake daemon HTTP stub; no script or fixture in
  the tree boots two hosts.
- [x] Add the global multi-computer activity overview on the replicated
      redacted projection, including last known state of offline machines.
      Done 2026-08-20 (commits `3b9e49d2b`, `3e12960cf`): a `/machines` route
      (sidebar footer, mirrors /usage) fed by the redacted
      `workjet.mesh.overview` RPC — per peer: identity/trust level (roster),
      lastInboundAt (inbox MAX), lastOutboundAt (outbox enqueue MAX — never
      framed as delivery), delegation counts by state; NO liveness claims,
      enforced at contract, projection-test, and page-test layers (the words
      online/offline/connected are asserted absent). Verified finding: the
      daemon loopback exposes NO presence route, so last-known contact is the
      honest maximum. Known follow-ups: no index behind the JSON-extract
      scans (fine at current volumes), per-environment (unmerged) rendering
      by design.
- [x] Encrypt message/delegation payloads end to end to the target environment
      key and sign the immutable routing envelope with the source environment
      key; the relay may inspect only the minimum routing and expiry metadata.
      Done 2026-08-19 (commits `4f37e2202` signing, `7d1797d0f` sealing):
      Ed25519 envelope signatures over a domain-tagged canonical
      serialization, and X25519-ECDH + HKDF-SHA256 + AES-256-GCM sealing to
      the target environment's encryption key (fresh ephemeral per envelope,
      AAD-bound envelope id, signature verified before unsealing, one
      collapsed failure reason). INTERIM until CTOX-room-derived identity
      binding: encryption keys are exchanged in-band and TOFU-pinned
      (migration 044); exactly one first-contact envelope per peer travels
      plain inside the room trust boundary and is counted. Local fast path
      stays plaintext by design.
- [~] Add narrowly scoped server credentials and ACL checks for send, receive,
  reply, cancel, reassign, and review operations; account co-membership
  alone must not grant cross-project or cross-environment execution rights.
  Audited 2026-08-20. The SECOND sentence is fully enforced, structurally:
  cross-environment reassignment is refused with `unknown-target` before
  any effect, the executor refuses foreign-environment targets outright
  (test "skips a delegation whose target thread lives in another
  environment"), and every routing envelope must carry an Ed25519 signature
  that verifies against a pinned per-environment mesh identity before
  insertion. The FIRST sentence is not: there is one coarse gate, not six
  narrow ones. Every mailbox RPC — sendMessage, delegateTask, reply,
  requestReview, updateDelegation, reassignDelegation, sendHandoff,
  acceptHandoff — passes through the same two steps: the transport scope
  `orchestration:operate` from the RPC authorization table, then the single
  `requireOrchestratorSource` check
  (`apps/server/src/workjet/mailbox/WorkjetMailboxRpc.ts:169-181`), which
  collapses "thread missing", "thread deleted", and "not an orchestrator"
  into one `unauthorized`. The MCP side is the same decision:
  `requireWorkjetOrchestrator` on all five tools. The module says so itself
  at `WorkjetMailboxRpc.ts:58-62` — "Worker-initiated traffic
  (`workjet_reply`, delegation updates) and per-operation ACLs are separate,
  still-open plan items". Remaining delta: per-operation scopes/credentials,
  and a path for a WORKER thread (not just an orchestrator) to reply or
  update its own delegation — today a worker cannot use the mailbox RPCs at
  all. Related still-open item: "Scope T3 MCP tools to the current
  session/thread and capability grants" later in this plan.
- [~] Guarantee at-least-once transport with stable envelope IDs, idempotent
  inbox insertion, acknowledgements, bounded retry/backoff, expiry, and a
  dead-letter state visible to the user. Never promise exactly-once network
  delivery; guarantee exactly-once delegation effects by deduplication.
  Audited 2026-08-20: everything except the last clause is done. Stable
  envelope ids (minted once at send, the PRIMARY KEY of both outbox and
  inbox, migration 042); idempotent inbox insertion with expiry checked
  BEFORE dedup (store test "inserts an inbound envelope idempotently and
  rejects an expired one"); acknowledgements (delivery-receipt statuses,
  `markOutboundDelivered` — test "marks an outbound envelope delivered
  exactly once" — and the daemon-side `consumed` call); bounded
  retry/backoff to dead-letter (tests "backs off exponentially and
  dead-letters after the attempt budget", "caps the exponential backoff");
  expiry (one-pass sweep across all three tables); and exactly-once
  delegation effects by deduplication (transport test "consumes a replayed
  envelope without repeating its delegation effects", delivery test "treats
  a replayed envelope as a duplicate without a second inbound activity").
  Remaining delta — "visible to the user": no UI reads the dead-letter
  state. The executor's counters are annotated "for later UI exposure"
  (`WorkjetDelegationExecutor.ts:197-199`), and the redacted audit stream
  reaches a client-runtime atom
  (`packages/client-runtime/src/state/server.ts:1044-1046`) that no
  component renders. A dead-lettered DELEGATION does surface indirectly,
  because its source row reconciles to `failed`/`delivery-dead-lettered`
  with a source-thread trace (test "fails a source delegation whose
  outbound envelope dead-lettered"); a dead-lettered plain MESSAGE surfaces
  nowhere at all.
- [x] Add a server-side mailbox reconciler that resumes after restart, applies
      backpressure, orders events per delegation, and queues target prompts
      while a thread already has an active turn.
      Done 2026-08-19, verified 2026-08-20:
      `apps/server/src/workjet/mailbox/WorkjetDelegationExecutor.ts`, whose
      module docstring cites this exact line. All four properties, each with a
      test in `WorkjetDelegationExecutor.test.ts`: resumes after restart —
      "resumes rows a previous process left in delivered and in accepted";
      backpressure and target-prompt queueing are the SAME mechanism, since the
      loop is the queue and a busy target simply stays `delivered` with no
      second table — "holds a delegation in delivered while the target turn
      runs, then executes it" and "starts only one turn per thread per cycle
      even with two delivered delegations", with "treats both a running latest
      turn and a live session as an active turn" defining busy; ordering per
      delegation — `listDelegationRowsByState` scans `ORDER BY
state_changed_at_ms ASC, delegation_id ASC`
      (`WorkjetMailboxStore.ts:1816`) and the cycle scans `running` before any
      accept moves a fresh row into `running`. Bounded at 32 rows per state per
      cycle, 10 s cadence, 60 s cycle timeout, with a resilient per-row scan so
      one version-skewed row is counted and skipped rather than aborting the
      cycle (test "skips a version-skewed delegation row while still running
      its readable neighbour"). Exactly one instance runs, provided as a single
      shared layer constant in `apps/server/src/server.ts:477-487` and `:561`.
      Honest caveat: the restart test seeds rows in the same in-memory database
      rather than killing a process.
- [x] Expose harness-neutral MCP tools `workjet_send_message`,
      `workjet_delegate_task`, `workjet_reply`, `workjet_request_review`, and
      `workjet_update_delegation`; all harnesses receive the same schemas and
      authorization boundary from the per-session T3 MCP server. All five done
      2026-08-19 (send/delegate earlier; reply/request-review/update in commits
      `0354175b7`, `575bfbf61`): orchestrator-scoped visibility +
      `requireWorkjetOrchestrator`, bounded tool-local schemas, mapped onto the
      store's enforced transition table (no invented edges).
- [x] Deliver accepted tasks through normal T3 `thread.turn.start` semantics
      and the existing Codex, Claude Code, and Grok session adapters. Do not
      implement direct harness-to-harness sockets or provider-specific remote
      protocols. Done 2026-08-19 (commits `f41a08eab`, and its parent):
      `WorkjetDelegationExecutor` reconciles `delivered`→`accepted`→`running`
      on a 10 s loop, resolves the prompt snapshot, refuses orchestrator
      targets (terminal `failed`), holds `delivered` while the target thread
      has an active turn (backpressure = the scan queue, no second table),
      dispatches `thread.turn.start` with a derived idempotent commandId
      (invariant/previously-rejected → terminal fail, transient → retry next
      cycle), and resumes `delivered`/`accepted` rows after restart. 13
      focused tests. Same-environment only — cross-machine snapshot transfer
      and completion/result-return remain open.
      CORRECTION 2026-08-20: that last sentence no longer holds. Cross-machine
      snapshot transfer landed (commit `ee82c5ac2`; transport test "stores
      received snapshot bytes and makes the delegation executable") and
      completion/result-return landed (commit `c4c5d8851`, migration 047, with
      durable redelivery via migration 049). The executor's own module
      docstring still carries the superseded "SAME-ENVIRONMENT delegations
      only" scope note — a stale code comment, not a behavioural limit.
- [x] Preserve the delegation link when a result returns to the source thread;
      allow the source worker to ask a follow-up, request independent review,
      or send `changes-requested` back to the original worker without creating
      an unrelated task chain. Result return done 2026-08-19 (commit
      `c4c5d8851`): the executor completes a `running` delegation only on the
      exact turn it dispatched (message-id + turn-id + session correlation),
      writes a durable `WorkjetDelegationResult` (migration 047), and returns
      it to the source — a `workjet.delegation.result` thread activity
      same-environment, a signed pending-outbound result envelope
      cross-environment (idempotent). Cross-machine snapshot transfer done
      (commit `ee82c5ac2`): a cross-env delegation carries its prompt bytes
      SEALED within the 200000-byte wire ceiling, digest-reverified into the
      receiver's snapshot store before the delegation row so the executor can
      run it; oversized → ref-only marker, never silent. Follow-up/review
      linkage lands with the reply/review/update MCP tools (in flight).
      COMPLETE 2026-08-20: follow-up/review linkage landed with the
      reply/review/update tools and the card actions; cross-env result
      redelivery is durable (migration 049 markers, executor retry scan,
      permanent failures marked; dead-letter reconcile stamps
      `reconciled_at_ms` so dead rows are handled exactly once; the ws
      reassign port now routes through the ONE executor instance provided via
      server.ts).
- [~] Represent review and revision as typed edges (`reviews`, `revises`,
  `follows-up`) in one delegation graph, with configurable maximum depth,
  review rounds, token/cost/time budgets, and approval gates to prevent
  autonomous infinite loops. Done 2026-08-19 (commit `0354175b7`,
  migration 045 `workjet_delegation_edges`): idempotent typed edges
  (`reviews`/`revises`/`follows-up`, stable id, `listDelegationEdges`), and
  loop gates enforced BEFORE any durable effect — review round >
  `maxReviewRounds` → `review-rounds-exceeded`, depth+1 > `maxDepth` →
  `depth-exceeded`. Token/cost budgets + approval gate done 2026-08-19
  (commits `b66f7e4aa`, `13c0d23ab`, `dac16d7bc`, migration 048): optional
  `maxTokens`/`maxCostMicros` (integer micro-currency) with transactional
  `recordDelegationUsage` refusing `token-budget-exceeded`/
  `cost-budget-exceeded` before the durable write, and `requiresApproval`
  seeding a delegation `pending` — the executor's delivered→accepted path
  consults `isDelegationExecutable` and holds until approved (reject →
  terminal cancelled). Fully closes the anti-infinite-loop requirement.
  Real usage wiring done 2026-08-19 (commit `c05ab1266`): the executor
  charges each delegation the DELTA of its turn's cumulative
  `context-window.updated` snapshots (ProviderRuntimeIngestion is the only
  per-turn token source; idempotent delta-vs-recorded-total, no double
  count), gates on completion AND mid-run (breach on a running turn
  dispatches `thread.turn.interrupt` with a derived command id), fails with
  the bounded budget reason, persists a bounded failed result, and emits the
  previously dead `budget-exceeded{kind}` audit event. Cost stays 0 — no
  per-turn cost figure exists anywhere reachable; the cost ceiling remains
  enforced at the store. Granularity caveats: provider-driven snapshot
  cadence and the 10 s cycle allow bounded overshoot between reports.
  AUDIT 2026-08-20: all six gates the line names are present and tested —
  typed edges (migration 045, store tests "inserts a delegation-graph edge
  idempotently on its stable id", "lists every edge touching a delegation as
  from or to, in creation order"), max depth, max review rounds, the TIME
  budget as `WorkjetDelegationBudget.expiresAt`
  (`packages/contracts/src/workjetMailbox.ts:376`) enforced by the one-pass
  expiry sweep, `maxTokens`, `maxCostMicros`, and `requiresApproval` (store
  tests "gates a requiresApproval delegation as pending until approved",
  "rejection cancels the delegation terminally and keeps it non-executable").
  The box stays `[~]` for exactly one reason: the COST ceiling can never fire,
  because no per-turn cost figure exists to charge against it, so
  `maxCostMicros` is enforced machinery over an input that is always zero.
  Everything else on this line is closed.
- [x] Add interruption, cancellation, reassignment, target-offline, deleted-
      thread, and target-version-skew handling with explicit terminal or
      recoverable states; never silently drop a message or start it elsewhere.
      Done 2026-08-19 (commits `31aa98de9`, `c05e8cdb7`): deleted target thread
      → terminal `failed` `target-thread-deleted` (delivered AND mid-run, with
      expiry as backstop); cross-env offline = transport backoff→dead-letter,
      and a dead-lettered delegation envelope reconciles its source row to
      `failed` `delivery-dead-lettered` (idempotent, with a source-thread
      trace); `reassignDelegation` moves a delivered/needs-input delegation to
      a different local thread in place (refuses running/terminal/foreign — a
      task can never start on two threads); an undecodable row is a counted
      `version-unsupported` skip via a resilient per-row scan instead of
      aborting the cycle; an interrupted turn fails with explicit
      `turn-interrupted`. Cancellation existed already. No contract changes
      were needed.
- [~] Transfer context by immutable prompt snapshots and bounded references to
  artifacts, diffs, files, and Greppy results instead of copying complete
  chat histories. All Code-mode threads on one server continue to share its
  single Greppy store; remote servers resolve references against their own
  authorized environment state.
  Audited 2026-08-20. DONE — the snapshot half, thoroughly: prompt text is
  written into the content-addressed immutable store beneath the server
  state root (`WorkjetSnapshotStore.ts`: digest-sharded, atomic, reverified
  on read), the delegation is pinned to the digest the server itself wrote,
  and cross-machine transfer carries the bytes sealed and digest-reverified
  into the receiver's store before the delegation row is written; a thread
  handoff carries a bounded composed snapshot (40 msgs / 8k chars / 256KiB,
  no events, tools, or paths). No complete chat history ever travels.
  PARTIAL — the reference half: `WorkjetArtifactReferences`
  (`packages/contracts/src/workjetMailbox.ts:308-314`) is modelled and
  carried on the wire, but nothing POPULATES it. The executor writes
  `artifacts: { schemaVersion: 1, commitHashes: [], paths: [] }` on every
  result (`WorkjetDelegationExecutor.ts:914`, with the comment at `:880`
  conceding "a later slice can lift it into `artifacts`") and
  `WorkjetMailboxRpc.ts:471` does the same. OPEN — there is no diff
  reference type and no Greppy reference type at all, and nothing resolves
  a reference against a remote server's own authorized environment state;
  that clause is unimplemented and untested. Remaining delta: populate
  `artifacts` from the completed turn's worktree, add the diff/Greppy
  reference kinds, and prove one resolution on the receiving side.
- [x] Add thread UI for “Nachricht” versus “Nachricht + Auftrag”, recipient
      selection across connected computers, delivery/state badges, linked
      source/target navigation, reply, follow-up, review, cancel, and reassign.
      Send + render done (commits `68e42c912`…`b5908195c`): the four
      `workjet.*` activity kinds render as compact timeline cards with delivery
      dispositions, delegation-state badges, and same-environment thread links;
      orchestrator threads get the composer “Send to worker” panel (Message /
      Message + Task tabs) behind `workjet.mailbox.sendMessage|delegateTask`
      RPCs (operate scope + handler-side orchestrator validation collapsing
      refusals to `unauthorized`). Lifecycle actions done 2026-08-19 (commits
      `bb3283c60`, `72475c418`, `754907a47`, and the ChatView wire): reply,
      request-review, cancel, and reviewer approve / request-changes are
      state-gated action affordances on the delegation cards behind
      `workjet.mailbox.reply|requestReview|updateDelegation` RPCs, wired
      through ChatView. Cross-machine recipient picker done 2026-08-19 (commits
      `483749f7d`…`3200a6537` + ChatView wire `85eb60bb6`): a redacted
      `workjet.mesh.roster` RPC (read scope) lists TOFU-pinned peers —
      workspace/environment ids, first-contact timestamp, and a derived
      sealed-delivery-ready flag; the panel's "Another machine" mode offers a
      "Remote environments" group (honest "first contact" label, NO invented
      online state), a required bounded thread-id input ("this machine cannot
      list another machine's threads"), per-peer prefill, and the old silent
      environment-id-as-thread-id fallback was removed as a guess dressed as a
      default. Zero-peer/no-roster/truncated states covered. Follow-up/revise/
      reassign + compact composer done 2026-08-20 (commits `9b08253e0`,
      `026f95471`): follow-up on running (optional bounded note sent as a reply
      FIRST — an undeliverable note never precedes a silent state change), revise
      on changes-requested, reassign on delivered/needs-input via the new
      `workjet.mailbox.reassignDelegation` RPC (operate scope; cross-env →
      `unknown-target` before any effect) with the send panel's local-target
      list, refusal reasons rendered on the card; the send-to-worker control now
      also renders in the composer's compact footer as an icon-popover (it was
      previously absent there entirely).
      TICKED 2026-08-20 after audit. CORRECTION: the "Known follow-up" this entry
      used to carry — "the ws layer satisfies the reassign port with the store
      write" — is DONE, and the sentence was already contradicted by the
      result-return item above. `apps/server/src/server.ts:477-487` defines ONE
      shared `WorkjetDelegationExecutorLive` constant (Effect memoizes a layer by
      reference), provided both to `websocketRpcRouteLayer` at `:517` and as the
      background loop at `:561`; `apps/server/src/ws.ts:464` sets
      `reassign: workjetDelegationExecutor.reassign`, not a store write, and the
      only `store.reassignDelegation` call site in the repo is inside the executor
      (`WorkjetDelegationExecutor.ts:1774`). Test: "satisfies the mailbox RPC's
      reassignment port with its own guard". Every affordance this line names is
      present with a test: Message / Message+Task tabs plus the third Hand-off tab
      (`WorkjetSendToWorkerPanel.test.tsx` "shows all three tabs and marks the
      active one", "hides every task field until the task tab is chosen");
      cross-computer recipient selection ("groups the roster peers under a remote
      environments group, newest first", "requires the remote thread id and says
      why it cannot be picked"); delivery/state badges
      (`WorkjetMailboxActivityCard.test.tsx` "names every delivery disposition and
      treats an absent one as queued", "tones every delegation state literal in the
      contract"); source/target navigation ("links a same-environment peer thread
      and calls back with its address", "names but never links a peer on another
      machine"); reply; follow-up; review (request, approve, request-changes);
      cancel; reassign ("offers reassign only on the two pending states, and only
      with local targets"); and the compact footer popover ("collapses to an icon
      button that still names itself, keeping the same popover"). Residual, minor
      and previously unstated: no test asserts that `server.ts` hands the ws layer
      the SAME executor instance as the loop — that rests on the shared constant
      plus Effect's reference memoization, verified by reading.
- [x] Add redacted audit/observability events and user notifications without
      storing prompts, secrets, provider payloads, or artifact contents in
      relay logs, traces, push notifications, or crash reports. Done 2026-08-19
      (commit `b06c3d837` + merge): `WorkjetMailboxAuditEvent` tagged union
      (enqueued/delivered/dead-lettered/rejected/state-changed/
      approval-required/completed/budget-exceeded/mesh-replication-error) with
      only ids, closed literals, integers, and timestamps — a redaction canary
      asserts no payload field exists; `WorkjetMailboxNotification` subset
      builds user-safe titles from ids+codes; emitted best-effort AFTER the
      durable write from delivery/executor/transport via a bounded
      `WorkjetMailboxAuditEmitter` pub-sub (ResourceTelemetry pattern);
      consumable over the new streamed `subscribeWorkjetMailboxAudit` RPC
      (read scope) with client-runtime atom plumbing. Honest gap: nothing
      emits `budget-exceeded` at runtime until real usage accumulation is
      wired into `recordDelegationUsage`; no toast/UI rendering yet.
- [ ] Prove the protocol with same-server and cross-computer mixed-harness E2E:
      Codex -> Claude Code, Claude Code -> Grok, and Grok -> Codex, including
      offline delivery, duplicate envelopes, restart recovery, busy targets,
      review/changes-requested cycles, cancellation races, and revoked access.
      Verified open 2026-08-20 — this is now the single largest unproven claim
      in the section, and nothing else on the list substitutes for it. No test
      boots a real harness session: `WorkjetDelegationExecutor.test.ts:290-341`
      drives a hand-rolled recording engine, and even
      `apps/server/src/workjet/WorkerDispatch.e2e.test.ts:36-38` states "No
      provider harness is booted… nothing spawns an LLM session". The
      mixed-harness dimension is not merely untested but currently untestable
      at this layer: the worker address deliberately carries no harness field,
      and grepping `codex|claude-code|grok` across
      `apps/server/src/workjet/` finds only fixture provider-instance ids.
      Cross-COMPUTER is not proven anywhere in this repo. Scenario coverage as
      of today, all in one process against doubles: duplicate envelopes YES;
      busy targets YES; review/changes-requested cycles YES (store and delivery
      level, plus the card tests); offline delivery PARTIAL (a fake daemon that
      refuses, never a second server that is down); restart recovery PARTIAL
      (rows seeded in the same in-memory database, no process killed);
      cancellation races NO — cancellation itself is covered but a grep for
      `race` across the mailbox tests returns zero hits and no concurrent
      cancel-versus-dispatch test exists (the only proven race is the handoff
      accept claim); revoked access NO at this layer — zero `revoke` hits in the
      mailbox tests, and device-scoped revocation lives in the CTOX daemon.
      NOTE, so this item is not confused with a neighbour:
      `WorkjetCrossModeProofMatrix.test.ts` is NOT this proof — it proves the
      Cross-mode workflow bridge item in an earlier section and touches no
      delegation.

Abuse and reliability tests must cover duplicate dispatch, stale parent,
deleted worker, server restart, network loss, cancellation race, terminal
failure, remote version skew, and unauthorized cross-environment control.

## 9. Wave 6 — CTOX Desktop App identity

- [~] Change the user-facing desktop name, About panel, package metadata,
  installer names, app icons, update channel, and release filenames to
  `CTOX Desktop App` without renaming internal packages, storage keys,
  bundle IDs, or protocol schemes in the same change.
  Audited 2026-08-20: name/metadata/installer/icons/filenames done —
  `apps/desktop/src/app/DesktopEnvironment.ts:86` (`APP_BASE_NAME =
  "CTOX Desktop App"`, displayName `CTOX Desktop App (Alpha|Nightly)`),
  `scripts/build-desktop-artifact.ts:2181-2183` (`productName`,
  `artifactName: "CTOX-Desktop-App-${version}-${arch}.${ext}"`),
  `assets/ctox/*` icons, `resolveDesktopWebAssetBrand` → `"ctox"`.
  Remaining: the About-panel/update-channel audit sub-item below.
  - [x] Rebrand the current macOS arm64 package, executable, title, release
        filenames, and app icon to CTOX. The 17 August packaged Electron QA
        proves `CTOX Desktop App (Alpha)`, no rendered T3 wordmark, a CTOX
        `icon.icns`, and the final DMG/ZIP names.
  - [~] Finish the About-panel and update-channel identity audit on every
    supported platform before closing the parent identity task.
    Audited 2026-08-20. What exists: `apps/desktop/src/app/
DesktopAppIdentity.ts:99-103` sets `setAboutPanelOptions`
    (applicationName = `environment.displayName`, version = commit hash),
    covered by `DesktopAppIdentity.test.ts:169`; the update channel
    derives from the version (`scripts/build-desktop-artifact.ts:2115
resolveDesktopUpdateChannel`) and is surfaced in
    `apps/web/src/components/settings/SettingsPanels.tsx:221-445`
    (`AboutVersionSection`, Stable/Nightly) over
    `apps/desktop/src/updates/DesktopUpdates.ts`.
    EXACT REMAINING GAP: (a) the native About panel is reachable only on
    macOS — `apps/desktop/src/window/DesktopApplicationMenu.ts:146`
    (`{ role: "about" }`) sits inside the `platform === "darwin"` branch
    and no Windows/Linux Help→About entry exists, so the CTOX identity is
    unproven on those platforms; (b) the publish/update feed identity is
    environment-derived only (`resolveGitHubPublishConfig`,
    `T3CODE_DESKTOP_UPDATE_REPOSITORY` / `GITHUB_REPOSITORY` at
    `scripts/build-desktop-artifact.ts:2090-2113`) with no test or
    packaged check that a released CTOX build points at the CTOX feed.
- [x] Introduce `ctox-desktop:` and `ctox-desktop-dev:` protocol schemes while
      keeping CTOX instance/invite protocols distinct. Done 2026-08-20
      (commits `f4d40317d`…`7914623a6`): registered at all four points
      (registerSchemesAsPrivileged, setAsDefaultProtocolClient guarded by
      isPackaged, generated electron-builder protocols in
      scripts/build-desktop-artifact.ts, dev-launcher CFBundleURLSchemes +
      Linux desktop-entry MimeType), plus a NEW deep-link parser (none
      existed) accepting ctox-desktop/t3code schemes and normalizing to one
      canonical form; `ctox:` is asserted untouched. The renderer still
      SERVES from t3code://app deliberately (flipping the origin would break
      DESKTOP_RENDERER_ORIGINS and every persisted partition).
- [x] Keep safe one-time migration support for existing T3 Code desktop links
      and user data where useful. Verified 2026-08-20. Links: `t3code` (and
      `t3code-dev`) stay in `getDesktopDeepLinkSchemes`
      (`apps/desktop/src/electron/desktopSchemes.ts:34`), are claimed
      alongside the CTOX schemes in `DesktopAppIdentity.ts:116` and written
      into the Linux handler entry for both families
      (`DesktopLinuxUrlHandler.ts:100-120`); `DesktopDeepLink.ts:10` tags the
      `legacy` family and `DesktopDeepLink.test.ts:22,39,111` proves a
      `t3code://` link still parses and — because the renderer is served from
      `t3code://app` — needs no redirect. User data: the one-time offer is
      `apps/desktop/src/app/DesktopUserDataMigration.ts` +
      `DesktopUserDataMigration.test.ts` with the first-launch dialog at
      `apps/web/src/components/desktop/UserDataMigrationDialog.tsx`.
- [x] Use a distinct CTOX Desktop App user-data directory; import legacy
      T3 Code/Workjet settings only
      through an explicit, tested migration. Done 2026-08-20: user-data dir
      is now "CTOX Desktop App" (dev variant separate); legacy t3code dirs
      are migration SOURCES only. Explicit one-time offer (pure decision
      matrix + durable marker incl. "declined"; accept → relaunch → copy runs
      before the Chromium profile opens; COPY, legacy untouched) with a
      deliberate allowlist — Partitions included on purpose (dropping them
      would sign the user out of every paired CTOX instance), caches denied
      at every depth. Keychain finding: safeStorage is keyed by app NAME, not
      dir — nothing orphans now, but changing displayName later would and
      needs its own migration. First-launch renderer dialog mounted at the
      app root (import and restart / start fresh). VERIFIED LIVE 2026-08-20
      on the real profile: dialog → import → relaunch → marker `migrated`,
      Partitions carried over, the paired CTOX instance intact, legacy dir
      untouched, dialog never reappears. One packaged-only regression was
      found and fixed in the process (commit on branch): the migration's
      async FS construction let Electron's `ready` fire before the Clerk
      bridge registered privileged schemes — the construction path now uses
      a synchronous FileSystem (`syncFileSystemLayer`) so it is macrotask-
      free pre-ready. LESSON: desktop main-process slices need a packaged
      launch smoke; fake-FS tests cannot catch pre-ready ordering.
- [x] Keep internal `@t3tools/*` package names where changing them adds only
      upstream merge cost. Verified 2026-08-20: the root is still
      `@t3tools/monorepo` and all 12 `@t3tools/*` workspace packages keep
      their names (`apps/{desktop,web,marketing,mobile}/package.json`,
      `packages/{client-runtime,contracts,shared,ssh,tailscale}/package.json`,
      and the three mobile native packages); nothing was renamed. The only
      non-`@t3tools` workspace names are the deliberately new
      `@metric-space-ai/workjet-capabilities` and the upstream-derived
      `effect-acp` / `effect-codex-app-server`.
- [~] Update visible copy without rewriting unrelated historical comments,
  storage keys, or contracts. Audited 2026-08-20: the shell chrome is
  rebranded (window title from `environment.displayName`,
  `DesktopWindow.ts:557,631`), but 76 `T3 Code` occurrences remain under
  `apps/web/src`, of which these are user-visible in the packaged app:
  `apps/web/src/components/SplashScreen.tsx:4-5` (splash aria-label and
  image alt), `apps/web/src/components/RightPanelTabs.tsx:88`
  ("only available in the T3 Code desktop app"),
  `apps/web/src/components/desktop/SshPasswordPromptDialog.tsx:164`,
  `apps/web/src/components/cloud/RelayClientInstallDialog.tsx:72-73`,
  `apps/web/src/components/clerk/MobileClientsUserProfilePage.tsx:97`,
  `apps/web/src/components/ChatView.tsx:6575`. The migration dialog's
  "previous T3 Code profile" copy is a deliberate legacy reference.
- [x] Add CTOX Desktop App brand assets only after the shell and behavior are
      stable. Verified 2026-08-20: `assets/ctox/` carries
      `ctox-app-icon.icns`, `ctox-app-icon.png`, `ctox-windows.ico`, and the
      web favicon/apple-touch set; they are consumed by
      `scripts/export-brand-icons.ts`, `scripts/apply-web-brand-assets.ts`,
      and `DesktopAssets.ts` (`DesktopAssets.test.ts`), and the 17 August
      packaged QA proved the CTOX `icon.icns` in the built app.
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

- [x] Port the instance model, registry normalization, and source merge/sort.
      Verified 2026-08-20: all three sub-items are satisfied by the single
      `apps/desktop/src/ctox/CtoxInstanceRegistry.ts` (1423 lines, one merge
      over all four sources at `:678-700`), covered by
      `CtoxInstanceRegistry.test.ts` (1072 lines).
  - [x] Add renderer-safe typed managed-instance contracts, bounded metadata,
        duplicate rejection, and deterministic ctox.dev sorting.
  - [x] Merge managed discovery with persisted invite and manual-pairing
        entries through one deterministic renderer-safe registry result; retain
        paired entries when the ctox.dev account is signed out or unavailable.
  - [x] Add local-daemon and SSH-managed entries to the same registry result;
        do not introduce a second renderer-side registry or discovery store.
        Verified 2026-08-20: `CtoxInstanceRegistry.ts:34-51` imports both
        sources, `:678-700` merges local daemons and SSH-managed instances
        into the one deterministic registry result alongside managed and
        paired entries, and `:660-662` extends the stable-identity switch with
        `local_daemon` / `ssh_managed`. The renderer holds no registry of its
        own: `apps/web/src/components/ctox/CtoxModeShell.tsx:185
groupCtoxInstances` only buckets the one result by source
        (`CtoxModeShell.test.tsx:115,182,280`).
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
- [~] Port local-daemon, SSH-managed, invite, and manual-pairing sources.
  Audited 2026-08-20: invite/manual-pairing complete; local-daemon and
  SSH-managed discovery plus launch exist. Remaining for the parent:
  local-daemon lifecycle/ownership and SSH
  attach/install/rotate/revoke (see the two sub-items).
  - [x] Port bounded invite and manual-pairing import, deterministic identity,
        expiry handling, duplicate updates, removal, and strict rejection of
        HTTP bridges or unsafe signaling URLs.
  - [x] Accept the canonical invite JSON and
        `ctox-business-os-desktop://pair?payload=...` shape emitted by the CTOX
        Rust service without widening the accepted schema to arbitrary links.
  - [x] Bind paired entries to the verified bundled Business OS shell and its
        native WebRTC launch context; registry presence alone is not a launch
        or data-plane claim.
  - [~] Port local-daemon discovery, ownership, lifecycle, and launch.
    Audited 2026-08-20. DONE — discovery:
    `apps/desktop/src/ctox/CtoxLocalDaemonSource.ts` (read-only bounded
    `instance.json` decode with `onExcessProperty: "error"`, loopback-only
    health probe, instance cap, stale `running` claim downgraded to
    `unknown`), 11 cases in `CtoxLocalDaemonSource.test.ts`. Stable
    identity: `ctoxLocalDaemonInstanceId` derived from the descriptor path
    below the state root (`CTOX_LOCAL_DAEMON_ID_PATTERN`), tested at
    `CtoxLocalDaemonSource.test.ts:344`. LAUNCH:
    `CtoxLocalDaemonLaunch.ts` mints a per-activation invite by running
    `ctox business-os desktop invite` (`CTOX_BIN` then PATH), decodes it
    with the registry's one invite decoder, and packs it into the shared
    launch config with bounded reason codes and no CLI output logged;
    7 cases in `CtoxLocalDaemonLaunch.test.ts` including binary
    resolution, identity mismatch on a multi-daemon host, and a
    `TestClock` timeout. Renderer path: launchable only while the daemon
    answers (`CtoxModeShell.tsx:163-165`,
    `CtoxModeShell.test.tsx:280,311`).
    EXACT REMAINING GAP: (a) no daemon LIFECYCLE — nothing starts, stops,
    installs, or restarts a local daemon; `CtoxLocalDaemonSource.ts:14`
    states discovery "never spawns, installs, or mutates anything" and the
    only spawn in the local path is `CTOX_INVITE_ARGUMENTS`
    (`CtoxLocalDaemonLaunch.ts:105`). There is no local-daemon lifecycle
    IPC in `apps/desktop/src/ipc/methods/ctox.ts`. (b) no OWNERSHIP check
    — the descriptor is trusted from the state root with no file
    owner/uid/permission verification (`grep -i owner` over
    `CtoxLocalDaemonSource.ts` returns nothing).
  - [~] Port SSH-managed discovery, attach/install/rotate/revoke, and launch.
    Progress 2026-08-19 (commits `45e1129b9` and parent): discovery,
    credential-free configuration (`ssh-instances.json`), add/remove IPC,
    and the sidebar SSH add-surface tab are done over the EXISTING
    `runSshCommand`/`discoverSshHosts` infra (no second SSH stack; OpenSSH
    host-key pinning via `known_hosts` with `BatchMode=yes` aborting on
    unknown/changed keys; argv-not-shell exec with schema+single-quote
    guarding of host/state-root; remote output capped at 64 KiB). The
    descriptor decoder is shared with the local-daemon source. LAUNCH is
    deliberately fail-closed: the remote invite's signaling URLs are
    `ws://127.0.0.1:PORT` on the remote host and the SSH package exposes no
    reusable server-agnostic local-forward primitive, so SSH rows stay
    non-launchable with an honest "SSH tunnel support pending" hint.
    Launch enabled 2026-08-19 (commits `212ce172a`, `577c5467c`): exported
    scoped `openSshLocalForward` (argv `ssh -n -N -L`,
    `ExitOnForwardFailure=yes`, host-key semantics untouched, TCP-connect
    readiness, idempotent scope-owned teardown — `startSshTunnel` refactored
    onto the shared internals); the launch mints the invite over SSH (stderr
    failure marker instead of a remote temp file), extracts remote-loopback
    ws ports from `signaling_urls` (any non-loopback URL rejects the whole
    invite as `unsupported_signaling`), rewrites them to the forwarded local
    ports, and reuses the pairing import/activate path; forwards close on
    guest teardown via `destroyGuest`. Real bug found: the spawner does NOT
    kill children on scope close — the primitive owns that finalizer now.
    Still open: attach/install/rotate/revoke, and a live end-to-end run
    against a real remote host.
    RE-AUDITED 2026-08-20 — the main-process launch is real and wired
    (`CtoxSshManagedLaunch.ts`, 400 lines; `openSshLocalForward` in
    `packages/ssh/src/localForward.ts`; consumed by
    `CtoxGuestManager.ts:26,601,740`; 17 cases in
    `CtoxSshManagedLaunch.test.ts` covering port extraction, rewrite,
    `unsupported_signaling`, `forward_failed`, and forward teardown on a later
    failure), and `CtoxElectronSessions.test.ts:147` gives a launchable
    SSH-managed instance its own isolated partition. Renderer unblocked
    2026-08-20 (commit `8752fc9ae`): `canActivateCtoxInstance` now launches a
    reachable `ssh_managed` row (offline stays inert with an honest hint);
    the "pending" hint is gone from row and add-form.
    Also still absent: attach/install/rotate/revoke in any layer — the only
    SSH IPC is `addSshManagedInstance` / `removeSshManagedInstance`
    (`apps/desktop/src/ipc/methods/ctox.ts:233,260`).
- [~] Reuse Workjet's Electron safe storage where possible; preserve platform
  keychain guarantees for room, capability, sudo, and SSH secrets.
  Audited 2026-08-20: room/capability secrets are done (sub-item below);
  the sudo/SSH/keychain-smoke sub-item is the only remaining work.
  - [x] Store pairing room/capability secrets separately from public instance
        metadata using Electron Safe Storage; fail closed for unavailable,
        Linux `basic_text`, and unknown Linux storage backends.
  - [~] Port the equivalent sudo and SSH credential handling and platform
    keychain runtime smokes before claiming complete secret-storage parity.
    Audited 2026-08-20. WHAT EXISTS: SSH credential handling is
    deliberately credential-free for CTOX — `ssh-instances.json` stores no
    secret and authentication stays with the user's own OpenSSH setup
    (`apps/desktop/src/ctox/CtoxSshManagedSource.ts:34-36`,
    `packages/contracts/src/ctox.ts:220`); the separate interactive
    password path is `apps/desktop/src/ssh/DesktopSshPasswordPrompts.ts`
    (+ test) and is per-attempt, never persisted
    (`apps/web/src/components/desktop/SshPasswordPromptDialog.tsx:164`).
    The safe-storage layer is `apps/desktop/src/electron/
ElectronSafeStorage.ts` with the Linux backend guard in
    `apps/desktop/src/linuxSecretStorage.ts` (+ test).
    EXACT REMAINING GAP: (a) NO sudo credential handling for CTOX at all —
    the only `sudo` in the desktop tree is
    `apps/desktop/src/wsl/DesktopWslEnvironment.ts`, unrelated to CTOX
    instances; (b) NO platform-keychain runtime smoke — nothing under
    `scripts/` or `apps/desktop/src` exercises a real OS keychain
    (`grep -rl keychain` over `scripts` + `apps/desktop/src` matches only
    the comment in `app/DesktopUserDataMigration.ts`), so the plan's
    "platform-keychain runtime smoke" parity-gate line is unmet.
- [x] Port host-key pinning and strict SSH command handling. Verified
      2026-08-20: pinning is OpenSSH's own `known_hosts` — `StrictHostKeyChecking`
      is never weakened anywhere in the tree and `BatchMode=yes` aborts on an
      unknown or changed key (`packages/ssh/src/command.ts:108`,
      `packages/ssh/src/config.ts:232 readKnownHostsHostnames`,
      `packages/ssh/src/localForward.ts:40-42`,
      `apps/desktop/src/ctox/CtoxSshManagedSource.ts:34-36,274`,
      `CtoxSshManagedLaunch.ts:33`). Strict command handling is argv-not-shell
      with schema and POSIX single-quote guarding of host and state root,
      remote output capped at 64 KiB; covered by
      `CtoxSshManagedLaunch.test.ts:226` ("is a fixed script that bounds its
      own output and honours CTOX_BIN") and `:238` ("POSIX-quotes a configured
      state root so it cannot escape its argument"), plus
      `CtoxSshManagedSource.test.ts`.
- [~] Port deep-link parsing with explicit user confirmation. Audited
  2026-08-20. PARSING EXISTS: `apps/desktop/src/app/DesktopDeepLink.ts`
  (`parseDesktopDeepLink`, `isDesktopDeepLinkScheme`,
  `resolveDesktopDeepLinkRedirect`) with 10 cases in
  `DesktopDeepLink.test.ts`, including scheme-case normalization and the
  assertion that `ctox://` is NOT a desktop deep link.
  EXACT REMAINING GAP — two distinct deltas from the plan wording:
  (a) NO USER CONFIRMATION. The one consumer is
  `apps/desktop/src/window/DesktopWindow.ts:532-535`, which on
  `will-navigate` silently calls `window.webContents.loadURL(redirect)`.
  No dialog, no allowlist prompt, no per-link approval anywhere.
  (b) NO OS-LEVEL INTAKE. `grep -rn "open-url" apps/desktop/src` returns
  nothing, so a `ctox-desktop://` link opened from Finder/Explorer/a
  browser never reaches the parser; the cold-start argv and macOS
  `open-url` paths are unimplemented (`DesktopClerk.ts:142` handles
  `second-instance` for Clerk only). Confirmation is therefore not merely
  missing UI — the OS-originated link path it would guard does not exist.
- [x] Port support-bundle redaction and crash-report metadata without secrets.
      Done 2026-08-20 (commits `726decaeb`…`7999e8986`): a single JSON support
      bundle with a DECLARED 59-field inventory that the builder test asserts
      by set equality in both directions — an undeclared field fails, and so
      does a declared field that stopped being emitted. One deny-biased
      redaction gate (admission → substitution → residue check → bound); an
      over-long value is OMITTED, never truncated, because a truncated secret
      is a leaked prefix. The load-bearing decision: a log line is never
      carried as free text but projected onto four named fields, so
      `annotations.text` — where backend stdout could hold a prompt or a
      provider payload — is dropped BY CONSTRUCTION. Crash metadata is
      local-only: `uploadToServer: false` and NO `submitURL` at all, so no
      later edit can quietly enable uploading, with exactly six gated keys and
      no `addExtraParameter` path. Reachable from Help and from Diagnostics
      settings; the bundle lands at a stated path and nothing is ever sent.
      Canaries cover nine secret shapes plus six planted in a real temp state
      directory, each asserted absent from the written file.
- [x] Port permission denial, safe external navigation, launch-origin checks,
      secret scrubbing, and HTTP data/resource guards. Verified 2026-08-20,
      all five in place with tests. Permission denial: default-deny
      `setPermissionRequestHandler` / `setPermissionCheckHandler` in
      `apps/desktop/src/ctox/CtoxElectronSessions.ts:71-80`, covered by
      `CtoxElectronSessions.test.ts:222` ("denies account permissions and
      grants only exact instance permissions"). Safe external navigation:
      `isSafeCtoxExternalUrl` (`CtoxGuestManager.ts:334`) gates both
      `setWindowOpenHandler` (always `action: "deny"`) and `will-navigate`
      (`:798-806`); `CtoxGuestManager.test.ts:1166-1167` rejects `file://` and
      accepts `https://docs.ctox.dev/`. Launch-origin checks:
      `isAllowedCtoxTopFrameNavigation` (`:342`) used at `:557` and `:803`,
      tested at `CtoxGuestManager.test.ts:1158-1164`. Secret scrubbing:
      `scrubSensitiveCtoxUrl` (`:398`) rewrites the guest history on
      `did-finish-load` (`:815-825`). HTTP data/resource guards:
      `installRequestGuard` (`:438`) + `isForbiddenCtoxDataRequest` (`:352`)
      cancel `/api/business-os/*` outside the control allowlist, `/rxdb/*`
      outside `/rxdb/dist/`, `/commands*`, and any cross-origin data resource;
      8 assertions at `CtoxGuestManager.test.ts:1087-1145`.
- [x] Use Electron `WebContentsView`, matching Workjet's current guest-view
      architecture, rather than the deprecated CTOX `BrowserView` API.
      Verified 2026-08-20: `grep -rn "BrowserView" apps/desktop/src` returns
      no matches; the single sandboxed `createGuestView`
      (`CtoxGuestManager.ts:461`) constructs a `WebContentsView` and is the
      only guest path for managed, paired, local-daemon, and SSH-managed
      instances.
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
- [x] Never implement Business OS collection, command, file, or status reads
      over the Code/T3 HTTP server. Verified 2026-08-20 from both directions:
      (a) `apps/server/src` contains no Business OS route — the 9
      case-insensitive `business.os` hits are all Workjet-mailbox comments and
      the `business_os` CTOX secret scope
      (`workjet/mailbox/WorkjetMailboxTransport.ts:209,668-677`,
      `WorkjetMeshIdentity.ts:245-253`), which is the CTOX daemon's own MCP
      channel, not an HTTP data bridge; (b) the guest session actively cancels
      such reads even if a shell attempted them
      (`isForbiddenCtoxDataRequest`, `CtoxGuestManager.ts:352-395`, 8
      assertions at `CtoxGuestManager.test.ts:1087-1145`); (c) the renderer
      opens no alternate surface —
      `CtoxModeShell.test.tsx:711` ("introduces no iframe, webview, or
      alternate HTTP data surface").

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
      packaged app remain open. Verified open 2026-08-20: the pin has since
      moved to rc.11 (`apps/desktop/resources/ctox/
business-os-shell.manifest.json`, commit `1bdcbe311`), but the
      light-scheme and three/two/one-pane packaged proofs are manual QA runs
      with no artifact in this repo, so this stays open. KORREKTUR to the line
      above: the pinned shell is now `v0.1.0-rc.12`
      (`apps/desktop/resources/ctox/business-os-shell.manifest.json`,
      sourceCommit `478883dfb`), not rc.10.

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
- [x] Render CTOX instance groups, status, role, source, and last-used state in
      Business OS mode. Verified 2026-08-20: all four source groups are
      rendered from the one registry result by `groupCtoxInstances`
      (`apps/web/src/components/ctox/CtoxModeShell.tsx:88-99,178-200`) with
      exhaustive `SOURCE_LABELS` and `STATUS_LABELS` records typed over the
      contract unions (`:94-110`); covered by `CtoxModeShell.test.tsx:115`
      ("renders deterministic source groups and renderer-safe bounded
      metadata"), `:182` (SSH), `:280` (local).
  - [x] Render the managed ctox.dev group with bounded status, role, source, and
        last-used metadata.
  - [x] Render separate deterministic Managed and Paired groups, including
        invite/manual source, role, expiry, removal, and non-launchable state.
  - [x] Render populated Local and SSH groups after their main-process sources
        exist. Verified 2026-08-20: `SOURCE_GROUP_DEFINITIONS`
        (`CtoxModeShell.tsx:90-91`) adds the `Local` and `SSH` groups and
        `sourceGroupKey` (`:178-184`) routes `local_daemon` / `ssh_managed`
        into them; `CtoxModeShell.test.tsx:280` proves running local daemons
        render launchable and stopped ones inert, `:182` proves SSH rows
        render reachable-but-not-launchable. NOTE (not a defect of this item,
        but of the SSH launch item above): the SSH rows still carry
        `CTOX_SSH_LAUNCH_PENDING_HINT` even though `CtoxSshManagedLaunch`
        landed in the main process.
- [x] Selecting a managed ctox.dev instance activates its native guest surface
      in the main region.
- [x] Selecting a valid invite/manual-pairing instance activates the same guest
      surface through the local verified shell; expired, local, SSH, and forged
      entries remain non-launchable.
- [x] Show signed-out, needs-auth, unavailable, connecting, ready, and revoked
      states explicitly. Verified 2026-08-20 in
      `apps/web/src/components/ctox/CtoxModeShell.tsx`: the two state unions
      are `CtoxManagedState` (`:36` loading | ready | signed_out | failed) and
      `CtoxConnectionState` (`:37` idle | connecting | ready | error |
      revoked), rendered as explicit copy at `:1926-1929` (connecting / ready
      / revoked), `:1551` and `:1669-1676` (signed-out sign-in surface),
      `:1651` ("CTOX desktop services are unavailable.") and `:1042
unavailableHint` for per-instance unavailability; `needs_auth` is an
      exhaustive `STATUS_LABELS` entry (`:104`, typed
      `Record<CtoxManagedInstance["status"], string>` so the compiler forbids
      dropping a state). Tests: `CtoxModeShell.test.tsx:332` (sign-in beside
      paired results), `:362` (managed discovery failure), `:392` (legacy
      managed-only inference), `:400` (only available/paired rows enabled),
      `:504` (pending connecting activation), `:601` (activation to ready).
- [x] Keep CTOX Business OS chat inside the Business OS surface; do not convert
      it into a T3 thread. Verified 2026-08-20 structurally: the Business OS
      surface is a single sandboxed guest `WebContentsView`
      (`CtoxGuestManager.ts:461`) whose content is the pinned CTOX shell, and
      no code path lifts guest chat into a Workjet thread — there is no
      chat/thread bridge in `apps/desktop/src/ctox/` (the only guest→host IPC
      channels are `REFRESH_MANAGED_LAUNCH_CHANNEL` and
      `CTOX_APPLY_HOST_THEME_CHANNEL`), and the renderer opens no alternate
      surface at all (`CtoxModeShell.test.tsx:711`: "introduces no iframe,
      webview, or alternate HTTP data surface").
- [~] Provide instance management and refresh actions without exposing secrets.
  Audited 2026-08-20: the managed and paired sub-items are done; the
  local-daemon/SSH lifecycle sub-item below is the remaining work.
  - [x] Provide managed login, logout, and refresh actions through typed IPC
        without exposing tenant IDs, partitions, cookies, or launch tokens.
  - [x] Provide invite/manual-pairing add and paired-instance removal through
        typed IPC; keep room/capability values out of discovery responses,
        renderer persistence, feedback copy, and launch URLs.
  - [~] Provide local-daemon and SSH-managed lifecycle actions with the same
    renderer-secret boundary. Audited 2026-08-20. DONE: SSH configure and
    remove over typed IPC with a credential-free stored document —
    `apps/desktop/src/ipc/methods/ctox.ts:233 addSshManagedInstance`,
    `:260 removeSshManagedInstance`, renderer wrappers at
    `CtoxModeShell.tsx:278-316,459-471`, tested by
    `CtoxModeShell.test.tsx:226` ("offers an SSH tab in the add surface
    that stores no credential").
    EXACT REMAINING GAP: no local-daemon lifecycle action exists in any
    layer (the IPC surface in `apps/desktop/src/ipc/methods/ctox.ts` is
    refresh / login / logout / importInvite / importManualPairing /
    removePairedInstance / addSshManagedInstance /
    removeSshManagedInstance / activate / enterBusinessOsMode /
    exitBusinessOsMode / deactivate / setGuestBounds / listApps / openApp
    / setAppDocked / setHostTheme — no start, stop, install, attach,
    rotate, or revoke), and no SSH attach/install/rotate/revoke action.
- [~] Ensure keyboard shortcuts and zoom target the active desktop surface
  intentionally. Audited 2026-08-20. WHAT EXISTS: zoom is a deliberate,
  documented choice to always target the main window's own `webContents`
  rather than a focused child view —
  `apps/desktop/src/window/DesktopWindow.ts:93-98` (the comment states the
  Electron `zoomIn`/`zoomOut` roles would zoom the focused embedded
  `WebContentsView` instead) and `:858-866 zoomMain`, driven by the View
  menu accelerators at
  `apps/desktop/src/window/DesktopApplicationMenu.ts:200-208`; the
  Cmd/Ctrl+W auto-repeat guard is `DesktopWindow.ts:547-553`.
  EXACT REMAINING GAP: nothing is CTOX-surface aware. The zoom comment
  reasons only about the preview view, no accelerator or shortcut is
  routed to or suppressed for the active CTOX Business OS guest, and no
  test asserts shortcut/zoom targeting while a guest is active.

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
        `CTOX_STATE_ROOT`, or `CTOX_INSTALL_ROOT` to a synthetic empty instance.
        Verified open 2026-08-20: `scripts/ctox-packaged-smoke.ts` exists but
        this is an operator-run packaged smoke with no recorded run artifact.
  - [x] Add the macOS-first packaged smoke runner and focused tests. It uses
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
        gate. Verified open 2026-08-20: operator-run packaged smoke, no
        artifact in this repo. The mode lease itself is implemented and tested
        (`CtoxGuestManager.ts`, `CtoxGuestManager.test.ts`, 1169 lines) and
        the pinned shell has since moved to `v0.1.0-rc.12`, so the run must be
        redone against rc.12, not RC6.
  - [~] Capture the browser peer ID only from the live WebRTC signaling
    handshake or another non-persistent runtime diagnostic, keep it out of
    logs/artifacts, and guarantee `peer unrevoke` before any later cleanup.
    Audited 2026-08-20: both sub-items landed, but they landed in the CTOX
    repository (commits `1e2808814`, `71b80c625`) and the parent still
    requires the Workjet-side packaged smoke to consume that field. Out of
    Workjet scope except for `scripts/ctox-packaged-smoke.ts`.
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
          drift. Verified open 2026-08-20 — CTOX repo (Rust
          `WebRTCPeerSessionValidator`); nothing in Workjet can advance it.
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
          Electron partition deletion. Verified open 2026-08-20: the Workjet
          side is ready — guest detach/destroy on removal and the
          instance-scoped partition wipe are implemented and unit-tested
          (`apps/desktop/src/ctox/CtoxGuestManager.ts`,
          `CtoxElectronSessions.test.ts:255` "clears storage and cache only in
          the selected instance partition") and the driver exists
          (`scripts/ctox-packaged-smoke.ts` + `.test.ts`) — but the run is
          blocked on the CTOX-side validator item above.
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

### Wave 6/7 gap list (reconciliation audit, 2026-08-20)

The true remaining Wave 6/7 implementation work, after ticking everything the
code already satisfies. "CTOX?" marks work that needs the separate CTOX
repository and is therefore out of Workjet scope.

| #   | Gap                                                                                                                                                      | Scope (files)                                                                                                                                                                                                                                                                                                              | CTOX?                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1   | Support-bundle redaction + crash-report metadata — nothing exists at all                                                                                 | new `apps/desktop/src/app/DesktopSupportBundle.ts` (+ test), a `crashReporter` call in `apps/desktop/src/main.ts`, an IPC method in `apps/desktop/src/ipc/methods/`, and a renderer entry point in `apps/web/src/components/settings/SettingsPanels.tsx` (there is already a `/settings/diagnostics` route to hang it off) | no                                              |
| 2   | Deep-link user confirmation + OS-originated link intake                                                                                                  | `apps/desktop/src/window/DesktopWindow.ts:532-535` (add a confirmation gate), a new macOS `open-url` / cold-start-argv handler beside `apps/desktop/src/app/DesktopAppIdentity.ts`, plus renderer confirmation UI                                                                                                          | no                                              |
| 3   | SSH launch is implemented in main but unreachable from the UI                                                                                            | `apps/web/src/components/ctox/CtoxModeShell.tsx:77-82,166-168` (drop `CTOX_SSH_LAUNCH_PENDING_HINT`, allow `ssh_managed`) and `CtoxModeShell.test.tsx:182-218,275`                                                                                                                                                         | no                                              |
| 4   | SSH attach / install / rotate / revoke                                                                                                                   | `apps/desktop/src/ctox/CtoxSshManagedSource.ts`, a new `CtoxSshManagedLifecycle.ts`, `apps/desktop/src/ipc/methods/ctox.ts`, `packages/contracts/src/ctox.ts`, `CtoxModeShell.tsx`                                                                                                                                         | partly — needs matching remote `ctox` CLI verbs |
| 5   | Local-daemon lifecycle (start/stop/install) and descriptor ownership check                                                                               | `apps/desktop/src/ctox/CtoxLocalDaemonSource.ts` (owner/uid check), a new lifecycle service, `apps/desktop/src/ipc/methods/ctox.ts`, `CtoxModeShell.tsx`                                                                                                                                                                   | partly — needs `ctox` daemon CLI verbs          |
| 6   | Platform-keychain runtime smoke (parity-gate line, unmet)                                                                                                | new script under `scripts/`, exercising `apps/desktop/src/electron/ElectronSafeStorage.ts` and `apps/desktop/src/linuxSecretStorage.ts` on a real OS keychain                                                                                                                                                              | no                                              |
| 7   | Sudo credential handling for CTOX instances                                                                                                              | none exists; decide whether CTOX Desktop App needs it at all before building it                                                                                                                                                                                                                                            | no (decision first)                             |
| 8   | Keyboard/zoom targeting of the active CTOX guest surface                                                                                                 | `apps/desktop/src/window/DesktopWindow.ts:858-866`, `apps/desktop/src/window/DesktopApplicationMenu.ts:200-208`, needs guest-awareness from `apps/desktop/src/ctox/CtoxGuestManager.ts`                                                                                                                                    | no                                              |
| 9   | About panel on Windows/Linux + a check that the release feed carries CTOX identity                                                                       | `apps/desktop/src/window/DesktopApplicationMenu.ts:146` (Help→About outside the darwin branch), `scripts/build-desktop-artifact.ts:2090-2113` (+ test)                                                                                                                                                                     | no                                              |
| 10  | 76 remaining `T3 Code` strings in the renderer, incl. the splash screen                                                                                  | `apps/web/src/components/SplashScreen.tsx:4-5`, `RightPanelTabs.tsx:88`, `desktop/SshPasswordPromptDialog.tsx:164`, `cloud/RelayClientInstallDialog.tsx:72-73`, `clerk/MobileClientsUserProfilePage.tsx:97`, `ChatView.tsx:6575`                                                                                           | no                                              |
| 11  | Packaged proofs: light scheme + three/two/one-pane layouts; paired smoke against a real instance; the healthy→revoke→unhealthy→unrevoke→healthy sequence | `scripts/ctox-packaged-smoke.ts` (driver exists); these are operator runs                                                                                                                                                                                                                                                  | blocked on CTOX item 12                         |
| 12  | Rust `WebRTCPeerSessionValidator` still does not keep the packaged guest unhealthy after a durable revoke                                                | —                                                                                                                                                                                                                                                                                                                          | yes, CTOX only                                  |

All of Wave 8 is CTOX-repository work: the legacy `src/apps/business-os-desktop`
wrapper does not exist in Workjet and CTOX is not vendored here.

## 11. Wave 8 — retire the legacy CTOX Electron wrapper

This wave happens in the separate CTOX repository and only after the CTOX
Desktop App parity gate is green. It removes only the legacy desktop wrapper;
CTOX continues to run as an independent backend/harness without any desktop
application.

- [x] Start from a clean CTOX branch; do not mix or overwrite unrelated current
      CTOX working-tree changes.
      AUDIT NOTE 2026-08-20 — scope check for this whole wave: the legacy wrapper is
      NOT present in the Workjet repository and is not vendored here. There is no
      `src/apps/business-os-desktop` tree (the only `business-os-desktop` strings in
      Workjet are the `ctox-business-os-desktop://pair` URL scheme and the
      `x-ctox-desktop-client` header value in
      `apps/desktop/src/ctox/{CtoxInstanceRegistry.ts:520,CtoxDevAuth.ts:23,
CtoxManagedDiscovery.ts:12}`, all of which are wire contracts that must stay),
      and `scripts/lib/reference-repos.ts` pins only `effect-smol` and
      `alchemy-effect` — CTOX is not a reference repo. Every unchecked item below is
      therefore CTOX-repository work that cannot be done or verified from Workjet.

- [ ] Remove `src/apps/business-os-desktop`. Verified open 2026-08-20 — CTOX
      repo only; the path does not exist in Workjet.
- [ ] Remove its separate packaging/release workflow and download links.
      Verified open 2026-08-20 — CTOX repo only.
- [ ] Point optional desktop-client documentation to CTOX Desktop App without
      presenting it as a CTOX runtime prerequisite. Verified open 2026-08-20 —
      CTOX repo only.
- [x] Keep the CTOX Business OS shell build and versioned shell artifact.
      Still true 2026-08-20: Workjet consumes it as a pinned detached release
      (`apps/desktop/resources/ctox/business-os-shell.manifest.json`,
      `v0.1.0-rc.12`, sourceCommit `478883dfb`) through
      `scripts/prepare-ctox-business-os-shell.ts` and
      `scripts/lib/ctox-business-os-shell.ts` (+ test).
- [ ] Keep CTOX daemon, Sync Engine, Business OS, MCP channel, provider adapter,
      and Web Stack adapter. Verified open 2026-08-20 — CTOX repo only
      (a "keep" assertion Workjet cannot verify).
- [ ] Update release smoke tests so CTOX validates the artifacts consumed by
      CTOX Desktop App instead of building another Electron application.
      Verified open 2026-08-20 — CTOX repo only.
- [ ] Verify local, managed, SSH, and invite workflows from CTOX Desktop App
      against the new CTOX commit before merging the deletion. Verified open
      2026-08-20 — blocked on the Workjet side too: the SSH workflow is not
      reachable from the UI (`CtoxModeShell.tsx:166-168`) and no local-daemon
      lifecycle exists, so this cannot pass yet regardless of the CTOX commit.

## 12. Security invariants

An item here is ticked only when A TEST EXISTS THAT FAILS IF THE INVARIANT IS
VIOLATED. Reading the code and concluding "looks right" does not qualify:
several of these were already true in code but unguarded, and an unguarded
invariant regresses silently. Every guard named below was mutation-verified —
the property was inverted, the guard was observed to fail, and the inversion
was reverted. Audited 2026-08-20.

- [x] No Business OS HTTP data bridge or fallback. Four independent guards:
      the contract's `httpDataProxy` is a `Schema.Literal(false)`, so "the
      proxy is on" is not a representable state
      (`packages/contracts/src/ctox.test.ts:97`, and
      `WorkjetCrossModeProofMatrix.test.ts` → `invariant B no http data bridge`);
      that same test source-scans the cross-mode server path for a second data
      route; the Electron guest cancels Business OS data requests at the
      `webRequest` layer (`CtoxGuestManager.test.ts` → "allows shell/control
      resources but blocks Business OS HTTP data routes"); and the managed
      launch refuses a config advertising the bridge
      (`CtoxManagedLaunch.test.ts` → "rejects non-WebRTC and HTTP-bridge launch
      configurations"). SCOPE NOTE: the source scan covers
      `apps/server/src/workjet/crossmode/` only — it guards the cross-mode path,
      not every module in the repository. The pairing FALLBACK path is guarded
      by two independent defences (a deep key scan and the schema literal),
      both now exercised through the real `http_bridge_available` field in
      `CtoxInstanceRegistry.test.ts` → "rejects expired, bridged, oversized,
      malformed-room, and dangerous URL inputs"; previously only a synthetic
      nested `http_bridge` key was covered.
- [ ] No raw provider, pairing, capability, sudo, or SSH secrets in Git,
      browser storage, thread events, instance registries, logs, crash reports, or
      support bundles.
      KORREKTUR 2026-08-20 — this was VIOLATED, not merely unguarded, and is
      now partly fixed. The support-bundle gate recognized provider and pairing
      secrets but leaked three of the five kinds this line names: an OpenSSH
      private key passed through verbatim with or without its PEM markers
      (a key body is mostly letters and `A` padding, so its digit density falls
      BELOW the generic entropy threshold — the heuristic that catches an
      opaque token is anti-correlated with real key material); a sudo password
      answered at a `[sudo] password for <user>:` prompt missed the assignment
      rule; and every camel-cased secret name (`capabilityToken`) escaped the
      word-boundary anchor. Fixed in `SupportBundleRedaction.ts` with canaries
      for all three plus a set-equality check tying the canary table to the
      kinds this line declares (`SupportBundleRedaction.test.ts`).
      Still unticked because two named sinks have no test: GIT (no
      secret-scanning gate over tracked files) and BROWSER STORAGE. The other
      sinks are guarded — logs and support bundles by the canary table and the
      log projection, crash reports by `DesktopCrashReporting.test.ts`
      ("attaches exactly the declared metadata keys", "gates every metadata
      value, so no secret can reach extra"), the bundle's field surface by the
      `SUPPORT_BUNDLE_FIELD_INVENTORY` set equality in
      `DesktopSupportBundle.test.ts`, and instance registries by
      `CtoxInstanceRegistry.test.ts`, which asserts the room secret and
      capability token appear in neither the public document nor the persisted
      file.
- [x] Separate Electron session partitions for CTOX instances.
      `CtoxElectronSessions.test.ts` proves deterministic per-instance
      partitions for managed, invited, manually paired, and SSH-managed
      sources, that each differs from the control plane and from the others,
      that mismatched or forged descriptors are refused before Electron is
      reached, and that clearing storage touches only the selected partition.
- [x] Default-deny guest permissions; explicitly allow only required safe
      capabilities. NEWLY GUARDED. The existing test enumerated four
      permissions it expected to be denied, which left the ALLOW-LIST ITSELF
      unguarded: adding `media` or `usb` to `ALLOWED_INSTANCE_PERMISSIONS` kept
      every assertion green. `CtoxElectronSessions.test.ts` → "grants exactly
      the declared permissions and denies the rest of the surface" now drives
      Electron's whole permission surface plus unknown strings through both
      handlers, holds the grant set to an exact declared value, requires the
      two handlers to agree, and proves the control plane grants nothing.
- [x] Deny untrusted guest navigation and window creation; open validated
      external URLs through the OS. NEWLY GUARDED. The predicates were tested;
      the WIRING was not — deleting the `setWindowOpenHandler` call or the
      `will-navigate` `preventDefault` left every predicate assertion green
      while the guest gained popups and free navigation. `CtoxGuestManager.test.ts`
      → "denies every guest-opened window and routes only safe URLs to the OS"
      drives the handlers the guest actually installed: every window is denied
      including same-origin, same-origin navigation proceeds, foreign
      navigation is prevented, and `file:`/`javascript:` are neither loaded nor
      handed to the shell.
- [x] Pin managed launch-config requests to the authenticated ctox.dev origin.
      `CtoxManagedLaunch.test.ts` → "pins the credential-bearing launch config
      POST to the exact control-plane origin": a `launchConfigUrl` naming a
      foreign origin fails the launch, and the credential-bearing POST is never
      sent (exactly one fetch happened).
      CORRECTION — the line is accurate but INCOMPLETE, and reads as a stronger
      claim than what holds. Two different URLs are bounded differently. The
      launch-CONFIG request is pinned to the exact control origin
      (`CtoxManagedLaunch.ts:258-264`). The launch TARGET the guest then loads
      is only bounded to the control host or a subdomain of it
      (`isTrustedManagedLaunchTarget`, `CtoxManagedLaunch.ts:169-179`), because
      the server names its own tenant URL and forcing a desktop-chosen path
      broke every managed activation when the deploy retired `/business-os/`.
      That weaker bound is itself guarded — `CtoxManagedLaunch.test.ts` →
      "refuses a launch URL outside the control plane's own domain", which also
      covers the `ctox.dev.attacker.example` suffix-confusion case.
- [x] Require confirmation for external pairing and instance-switch links.
      `DesktopDeepLinkRouter` never acts on an OS link: it parses, queues
      (capped, malformed dropped, foreign schemes left to their owners) and
      offers it to the renderer, and `DeepLinkConfirmationDialog.test.tsx` →
      "navigates through the supplied callback only when the user confirms" is
      the gate that turns one into a navigation.
      CORRECTION — the line names a surface that only partly exists. Pairing is
      NOT reachable through an OS deep link: the `ctox-business-os-desktop://pair`
      invite format is not among the schemes this app claims
      (`desktopSchemes.ts:39-44`), and `importInvite` is reached only by
      explicit entry in `CtoxModeShell`. No instance-switch deep-link route
      exists at all. Rewrite the line to describe OS-delivered links generally
      when this section is next revised.
- [ ] Preserve Web Stack SSRF, redirect, content-size, and untrusted-content
      defenses.
      Untrusted-content and content-size are guarded:
      `web_search.rs` → `model_facing_context_fences_untrusted_page_content`
      drives adversarial fixtures and asserts hostile strings land inside the
      fence while trusted framing stays outside;
      `local_fixture_rejects_over_limit_body_without_truncation` and the
      capability response budget (`capability_contract.rs` →
      `public_search_projection_is_exact_and_honors_both_host_budgets`) cover
      size.
      Unticked for one remaining reason. Two of the three reasons found on
      2026-08-20 were CLOSED the same day:
      (1) CLOSED 2026-08-20. SSRF was INCOMPLETE, not merely untested: three
      production `ureq` agents in `native/web-stack/src/scholarly_search.rs`
      (`annas_archive_search`, `augment_results_with_open_access_pdfs`,
      `fetch_json`) did not install `SsrfResolver`, and `fetch_json` fetches a
      caller-assembled URL. All three now install
      `SsrfResolver::new(crate::egress::allow_hosts_from_context(context))`,
      and `fetch_json` additionally runs `assert_fetchable_url` before any I/O.
      HOST-REACHABILITY DECISION: the public Anna's Archive, Unpaywall,
      Crossref, OpenAlex, and Semantic Scholar defaults are all public
      addresses and are unaffected; an operator who points a base URL at an
      internally hosted mirror must now also name that host in
      `CTOX_WEB_EGRESS_ALLOW` — the same exemption `web_search.rs` grants a
      self-hosted SearXNG base. `KNOWN_UNRESOLVED_AGENTS` in
      `WebStackEgressWiring.test.ts` is consequently EMPTY, and
      `scholarly_search.rs` joined that test's by-name must-resolve list.
      Guarded by four new `scholarly_search.rs` tests
      (`annas_archive_refuses_loopback_link_local_and_private_bases`,
      `annas_archive_refuses_non_http_bases_before_any_io`,
      `unpaywall_agent_refuses_loopback_link_local_and_private_hosts`,
      `open_access_augmentation_never_opens_a_connection_to_unlisted_loopback`,
      `fetch_json_refuses_loopback_link_local_private_and_non_http_urls`) that
      cover loopback, `169.254.169.254`, and each RFC1918 block; the
      augmentation one asserts the mock listener's accept backlog is EMPTY, so
      it fails on a connection being opened at all rather than on an error
      string. All mutation-verified.
      (2) CLOSED 2026-08-20, with a KORREKTUR to the original wording. "There is
      NO max-redirect limit anywhere in the crate" was imprecise: the crate sets
      no explicit `.redirects(n)`, but every `ureq` agent inherits ureq's
      default cap of 5 (`ureq-2.12.1/src/agent.rs:262`, and `unit.rs:168` errors
      once `history.len() + 1 >= redirects`). The real hole was the stated one —
      nothing proved it, so a dependency bump could change it unnoticed. Pinned
      by `egress.rs` →
      `crate_shaped_agents_bound_the_redirect_chain_at_five_requests`, which
      drives a self-redirecting loopback fixture through a crate-shaped agent
      and asserts exactly five requests plus `reached max redirects (5)`.
      Behaviour deliberately UNCHANGED. FOLLOW-UP (optional, not done): making
      the cap explicit rather than inherited means adding `.redirects(n)` to
      every builder — `web_search.rs` `build_agent_with_timeout`,
      `deep_research.rs` `fetch_text`, `scholarly_search.rs`
      `annas_archive_search` / `build_unpaywall_agent` / `fetch_json`, and the
      six `sources/*.rs` `build_agent()` fns. Skipped here as behaviour-neutral
      churn across nine call sites.
      (3) STILL OPEN: the TypeScript stdout byte budget (`WebStackSearch.ts:90`,
      `WebStackBrowser.ts:275`, `WebStackResearch.ts:421`) has no test. This is
      the only reason the box is still unticked.
      NEWLY GUARDED in the meantime: that the SSRF policy is INSTALLED at all.
      `egress.rs` proved the policy correct, but every HTTP fixture test
      allow-lists `127.0.0.1`, so deleting `.resolver(...)` from an agent left
      the entire Rust suite green. `WebStackEgressWiring.test.ts` now holds
      every production agent to installing it.
- [x] Scope T3 MCP tools to the current session/thread and capability grants.
      Behaviour is covered (`McpInvocationContext.test.ts`,
      `WorkerTool.test.ts` and `MailboxTool.test.ts` → "denies direct calls for
      standard, worker, and missing roles", `McpHttpServer.test.ts` → tools/list
      filtered by the authoritative bearer scope). NEWLY GUARDED: every one of
      those tests names a tool that exists TODAY, so a new `addTool` whose
      handler never checks scope was reachable with the whole suite green.
      `WorkjetToolScopeGate.test.ts` scans the registrations per-registration
      (so one guarded tool cannot vouch for four unguarded siblings), holds
      them to a declared inventory, and pins that the enforcers still refuse and
      that the scope still carries `threadId` and `providerSessionId`.
      RESIDUAL: no confused-deputy test exists — nothing proves a valid
      credential for thread A cannot act on thread B's resources. The property
      holds structurally (tools take the thread from the invocation scope, never
      from the payload — `WorkerDispatch.ts:139`), but that is unproven.
- [ ] Authenticate remote worker dispatch and prevent cross-environment
      authority escalation. Require signed, end-to-end encrypted delegation
      envelopes, target-side capability checks, bounded payloads, expiry, and
      revocable environment credentials.
      Re-audited 2026-08-20 after the first audit; A REAL HOLE WAS FOUND AND
      FIXED and four properties are newly guarded. Remote work reaches a machine
      through ONE door — `ingest` in `WorkjetMailboxTransport.ts` — and the three
      questions that door has to answer now each have a test that fails if the
      answer changes:
      • CAN AN ENVELOPE NAMING ANOTHER ENVIRONMENT HAVE AN EFFECT HERE? No, at
      two independent layers. Ingest refuses a `targetEnvironmentId` that is not
      this machine before anything durable happens and before the sender is even
      pinned (`WorkjetMailboxTransport.ts:1371-1376`); CTOX does not read the
      envelope at all, so this is the only place that check exists on the wire
      path. The executor refuses again at run time
      (`WorkjetDelegationExecutor.ts:825-830`). Guarded by
      `WorkjetMailboxTransport.test.ts` → "refuses a correctly signed envelope
      that names another environment" and, for the executor, "skips a delegation
      whose target thread lives in another environment".
      • CAN A PEER ESCALATE BY CLAIMING AN ENVIRONMENT ID IT DOES NOT OWN? Only
      at FIRST CONTACT, and that limit is now exactly as narrow as it was
      described. Trust-on-first-use pins `(workspaceId, environmentId) → both
  public keys` on the first envelope that verifies, and any later different
      key is refused, audited, and consumed
      (`acceptPeerKey`, `WorkjetMailboxTransport.ts:907-918`;
      `WorkjetMailboxTransport.test.ts` → "audits a conflicting re-pin attempt
      instead of only counting it", "refuses to downgrade a self-signed peer
      back to bare first-use trust"). What the impersonator cannot do is choose
      capabilities: a remote delegation targets an EXISTING local thread and
      runs under that thread's own role and grants — the delegation contract
      (`packages/contracts/src/workjetMailbox.ts:467-486`) carries no capability
      field at all, which is why the missing parent-superset check on the remote
      path is a missing defence in depth rather than an escalation vector.
      • CAN A REMOTE MESSAGE REACH A THREAD WITHOUT SIGNATURE VERIFICATION? No,
      and this is now structural rather than incidental.
      `WorkjetRemoteDispatchWiring.test.ts` holds every declaration that calls
      `recordInboundEnvelope` — the one durable write that turns wire bytes into
      an accepted envelope — to also verifying the routing envelope, and pins the
      call-site inventory (3 sites) plus the inventories of the two thread-visible
      effects, so a NEW writer fails the gate instead of inheriting the guarantee
      by proximity. Deleting either the remote or the local-fast-path check fails
      it. Note the local fast path verifies too, even for an envelope this
      process signed a moment earlier (`WorkjetMailboxDelivery.ts:608`, `:1303`).
      HOLE FOUND AND FIXED — PAYLOAD ADDRESSES WERE UNAUTHENTICATED. The Ed25519
      signature covers the routing envelope and the AES-GCM seal binds the
      ciphertext to the envelope id, but NOTHING compared the addresses the
      payload claims for itself with the ones the signature authenticates. A
      pinned, perfectly authenticated peer could therefore deliver a delegation
      whose `source` named a third environment — making this machine sign and
      relay an unsolicited `result` envelope to it, a confused deputy under its
      own trusted identity — or whose `source` named THIS environment, sending
      the executor down its same-environment result path
      (`WorkjetDelegationExecutor.ts:1043-1053`) to append an activity onto a
      local thread the remote peer picked. `payloadMatchesEnvelope`
      (`WorkjetMailboxTransport.ts`) now compares every address each payload
      variant carries, plus the envelope id, and ingest refuses a mismatch as the
      bounded `addressMismatch` rejection before the first durable write.
      Guarded by four tests in `WorkjetMailboxTransport.test.ts` (claimed source
      is a third environment; claimed source is this environment; a handoff
      claiming a foreign target; a payload lifted onto another envelope id).
      NEWLY GUARDED, from the first audit's list: EXPIRY now has its own test
      plus the `<=` boundary ("refuses a validly signed but expired envelope
      before it opens the seal", which also asserts the seal was never opened and
      no pin was created; "treats the expiry instant itself as expired and one
      millisecond later as live"). INBOUND BOUNDED PAYLOADS now have one: the
      wrapper's sealed-field ceiling is enforced AND the constant itself is
      pinned at 1 MiB ("refuses a sealed field beyond the wrapper's
      one-mebibyte ceiling"), because the 200 000-byte wire ceiling is an
      OUTBOUND check and buys the receiver nothing.
      STILL OPEN, and why this stays unticked:
      • REVOCABLE ENVIRONMENT CREDENTIALS do not exist in this repository.
      There is no `revokePeer`, `forgetPeer`, or `rotateMeshKey`; key rotation
      is treated as a rejection, not a supported revocation path. Revocation
      is explicitly deferred to the CTOX daemon, outside this repo.
      • TARGET-SIDE CAPABILITY CHECKS still do not exist; only the target ROLE
      check does (`WorkjetDelegationExecutor.ts:857`). See above for why this is
      defence in depth and not a live escalation.
      • The first-contact impersonation window is inherent to TOFU and is not
      closed by anything in this repository.
- [ ] Redact provider traffic metadata and never log request bodies by default.
      Re-audited 2026-08-20. THREE TYPESCRIPT LEAKS WERE FOUND AND FIXED; the
      Rust half is an owner decision recorded below.
      Bodies are captured only on the error path (`response_writer_test.rs` →
      `error_only_success_does_not_call_disabled_logger`), management routes are
      never request-logged, and the ACP native logging layer logs structure only
      (`AcpNativeLogging.test.ts` → "records bounded request and protocol
      diagnostics without raw payloads").
      FIXED — THE DEFAULT PROTOCOL LOGGERS LOGGED THE WHOLE WIRE MESSAGE. Both
      `packages/effect-acp/src/protocol.ts` and
      `packages/effect-codex-app-server/src/protocol.ts` fell back to
      `Effect.logDebug(...).pipe(Effect.annotateLogs({ event }))` when a caller
      turned protocol logging on without supplying its own logger — and that
      `event.payload` is the raw stdio line or the decoded RPC message, a
      `session/prompt`'s params included. `AcpNativeLogging` always supplies a
      logger, so nothing was leaking in production today, but the DEFAULT is
      precisely what this invariant line names. Both now emit a structural
      summary (type, size, allow-listed tag/method) that cannot carry content
      whatever the peer sends. Guarded by "emits no payload content from the
      default protocol logger" in each protocol suite: one sentinel is driven
      through every stage in both directions and must appear nowhere, while the
      structural fields must still be present, so emitting nothing does not pass.
      FIXED — OPERATOR LAUNCH FLAGS IN A SPAN. `claude.query.extra_args_json`
      serialized the whole `launchArgs` record, names AND values, into a span
      attribute; every span attribute lands verbatim in
      `<stateDir>/logs/server.trace.ndjson`, whose only bound is
      `truncateTraceAttributes`, a 500-character CLAMP that redacts nothing. It
      is now `claude.query.extra_arg_names`.
      NEWLY GUARDED: `apps/server/src/provider/ProviderTraceRedaction.test.ts`
      inventories every provider span attribute both ways, in the style of
      `SUPPORT_BUNDLE_FIELD_INVENTORY` — an undeclared attribute fails, and a
      declaration for an attribute that no longer exists fails too. It also
      refuses any attribute named after request content or a credential (with an
      explicit, justified exemption list rather than a weakened pattern) and any
      attribute that serializes a structure without a declared justification.
      OWNER DECISION — THE HOME SINK SHIPS A RAW BEARER TOKEN OFF-BOX.
      `HomeRequestLogPayload::new`
      (`native/provider-gateway/internal/logging/request_logger_home.rs:35-42`)
      builds its `headers` map with `clone_headers`
      (`request_logger_home.rs:55-61`), which filters only empty names and
      applies NO masking. The `request_log` blob it ships alongside is redacted;
      the sibling `headers` field is not, so a raw
      `Authorization: Bearer …` leaves the machine for the home sink.
      This behaviour is deliberately PINNED by a counter-test:
      `native/provider-gateway/internal/logging/request_logger_home_test.rs:48`
      → `bound_home_sink_replaces_local_request_log_output`, whose line 61
      asserts `pushed[0].headers["Authorization"][0] == "Bearer secret"`. Any fix
      breaks that test, which is why this is a decision and not a bug fix.
      THE DECISION: is the home sink a trusted destination that may receive
      unmasked provider credentials, or is this a leak to close? If it is a leak,
      closing it means masking in `clone_headers` (or dropping the `headers`
      field) AND rewriting the counter-test to assert the mask — the counter-test
      is the record of the current answer, not an obstacle to be deleted quietly.
      Deliberately not changed on 2026-08-20: `native/**` was out of scope and
      flipping a pinned behaviour needs the owner first.
      ALSO STILL UNTESTED (Rust side, unchanged): that the host never selects
      `RequestLoggingPolicy::full` (all seven call sites use `error_only_scoped`;
      switching one breaks no test), that `sdk_config.request_log` defaults to
      `false`, and that `commercial_mode` suppresses upstream capture.
      RESIDUAL (TypeScript side, recorded not fixed): the provider event NDJSON
      at `<stateDir>/logs/provider/events.*.log` stores raw provider payloads by
      design (`EventNdjsonLogger.ts:557-593`), and `server.trace.ndjson` records
      `Cause.pretty` of every failed span (`packages/shared/src/observability.ts`
      → `formatTraceExit`), which is how an error `detail` such as
      `opencodeRuntime.ts:69-83`'s serialized HTTP error body reaches disk. Both
      are local files rather than off-box traffic, and both are larger decisions
      than this line's wording.

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
- [x] Preserve the T3 MIT copyright and license notices. The root `LICENSE`
      keeps the unmodified T3 Tools notice, and `stageLegalNotices` in
      `scripts/build-desktop-artifact.ts` ships `LICENSE`, `LICENSE_POLICY.md`,
      and `NOTICE.md` as the packaged `Resources/legal/**` extra resource. The
      build fails closed when any of the three is missing.
- [x] Preserve CLIProxyAPI upstream MIT provenance and the license applicable to
      the Rust-port modifications.
- [x] Preserve Greppy Apache-2.0 notices. Verified outcome: no Greppy source is
      vendored and no Greppy binary is packaged. Workjet pins the upstream
      Apache-2.0 source archive in
      `packages/workjet-capabilities/src/greppyRuntime.ts` and builds it on the
      user's machine on opt-in, so this artifact performs no Apache-2.0
      redistribution. `NOTICE.md` section 3 records that boundary and the
      separate model-asset terms.
- [x] Generate a release NOTICE/source-offer inventory.
      `scripts/generate-release-notice.ts` derives the production dependency
      closure of `apps/desktop`, `apps/server`, and `apps/web` from
      `pnpm-lock.yaml`, reads license metadata from installed manifests, and
      emits the committed `NOTICE.md` offline, deterministically, and without a
      timestamp. `pnpm run notice:check` fails when the committed file is stale.
- [x] Review Electron guest-shell packaging and network-use obligations before
      the first public binary. Recorded in
      `docs/workjet-electron-guest-shell-license-review.md`; six items remain
      for legal sign-off, chiefly the ownership of the packaged CTOX Business OS
      shell archive.

The license choice is closed. Completing file-level provenance, headers, and
generated notices remains a release gate.

## 14. Upstream maintenance strategy

- [x] Keep `upstream/main` configured and fetch it regularly.
- [~] Maintain a short, ordered Workjet patch stack: contracts, orchestration,
  capabilities, provider integration, CTOX services, shell UI, branding.
  **Measured false, 2026-08-20; recommended for removal.** The stack is 485 commits (348
  first-parent) and fully interleaved: every theme spans nearly the whole
  chain (contracts #6→#305, capabilities #14→#322, provider #3→#332, CTOX
  #5→#315, shell UI #35→#284 of 348). There is no ordered stack to rebase
  and reordering 485 commits does not pay for itself against 43 conflict
  hunks per upstream cycle. The additive-file shape below already delivers
  what the ordering was meant to buy.
- [x] Prefer additive files and adapters over invasive rewrites of T3 core.
      **Verified 2026-08-20**: 1900 added / 206 modified / 1 deleted / 0 renamed
      across 2107 changed paths (90.2% additive). Of the 206 modified T3 core
      files only 25 conflict against 172 upstream commits — a 12% collision
      rate, and zero conflicts on Workjet-added files.
- [x] Avoid changing internal T3 identifiers that are not user-visible.
      **Verified 2026-08-20**: zero removals or renames across 78 desktop IPC
      channel literals, 228 `Schema.Literal` values, 13 `Schema.TaggedStruct`
      tags, 11 `_tag` literals, 18 `CREATE TABLE` names, 2 `localStorage` keys,
      5 `@t3tools/*` package names, and the `com.t3tools.t3code` bundle id. The
      copy sweep only added identifiers; the CTOX URL scheme is registered
      alongside the legacy `t3code` scheme, not in place of it.
- [ ] Rebase or merge upstream at the end of every completed wave and run the
      affected regression suite.
- [x] Track conflicts and recurring upstream hot spots in this document.
  - [x] **Reconnect technique chosen and proven on a scratch branch,
        2026-08-20**; execution on the real branch is still pending an owner
        decision. Premise re-verified: `39d3a27d3` and `6ae44b418` are
        tree-identical (both `7a67bc947…`, `git diff` empty) with no ancestry
        (`git merge-base` rc 1) and disjoint roots; the sanitized side is a full
        2516-commit parallel rewrite, not a truncated import. **KORREKTUR:** the
        downstream stack is **485** commits, not the 225 this plan claimed.
        Technique: re-parent replay (`git commit-tree` over
        `39d3a27d3..tip` with `39d3a27d3` → `6ae44b418`), preserving every tree.
        Proven as `scratch/ancestry-probe` `98cd9ef0f`: `git diff` against
        today's tip empty, ancestry rc 0, and a PR to `origin/main` would list
        **485** commits instead of today's **3001**. `git replace --graft` was
        rejected (local-only; GitHub never honours replace refs — the probe ref
        was created and deleted in the same run) and a tip-level `-s ours` merge
        was rejected (works, but still lists 3002 commits).
        Cost to accept: all 485 commit ids change; re-point every agent branch
        in the same pass.
  - [x] **First replay against refreshed upstream recorded, 2026-08-20.**
        **KORREKTUR:** `upstream/main` is now `beab6886f`, not `d484735c6`
        (which remains an ancestor, 62 commits back; 172 commits past
        `6ae44b418`). Once ancestry exists the reconciliation is an ordinary
        three-way merge: **25 conflicted files, 43 hunks, 1 modify/delete** —
        13 files / 27 hunks structural, 11 files / 16 hunks incidental,
        independently reproduced with `git merge-tree`. Full map, per-file
        recurrence counts, mitigations and environment traps:
        `docs/workjet-upstream-conflict-map.md`.
  - [ ] OWNER: decide whether to execute the reconnect (rewrites the 485 commit
        ids once) or keep the fork permanently unmergeable to upstream.
  - [ ] OWNER: confirm dropping the "short, ordered patch stack" goal above, or
        fund rebuilding 485 interleaved commits into ordered theme branches.
  - [ ] OWNER: `apps/web/src/orchestrationEventEffects.test.ts` — upstream
        deleted it in `277322933` "test: remove redundant and stale tests
        (#6267)"; Workjet still edits it. Keep the Workjet copy or drop it.
  - [ ] Land the three cheap conflict mitigations from the map: a single
        trailing `workjet*` barrel import in `ChatView.tsx`, `ChatComposer.tsx`,
        `SidebarChrome.tsx` and `packages/contracts/src/settings.ts`; a marked
        Workjet section at the end of `apps/desktop/src/ipc/channels.ts`; and
        extraction of the Workjet turn-option threading out of
        `CodexSessionRuntime.ts` (5 of 43 hunks, guaranteed to repeat).
- [ ] Contribute generally useful, non-Workjet-specific fixes upstream where
      practical.
- [ ] Never commit `.deps`, build output, local databases, credentials, or
      generated agent worktrees.

### Upstream conflict hot spots (measured 2026-08-20, `beab6886f`)

Structural — Workjet owns the behaviour, expect these every cycle:
`CodexSessionRuntime.ts` (5 hunks, worst offender),
`apps/desktop/scripts/electron-launcher.mjs` (4),
`scripts/build-desktop-artifact.ts` (4), `SidebarChrome.tsx` (3),
`ProviderService.ts` (2), `build-desktop-artifact.test.ts` (2), plus one hunk
each in `DesktopEnvironment.ts`, `DesktopAppIdentity.test.ts`,
`DesktopLifecycle.test.ts`, `DesktopApplicationMenu.test.ts`,
`electron-launcher.test.mjs`, `DiagnosticsSettings.tsx`, `scripts/package.json`.

Incidental — both sides appended to the same import block or constant list,
resolution is "keep both": `ChatComposer.tsx` (3), `ChatView.tsx` (2),
`threadSidebarWidth.test.ts` (2), `pnpm-lock.yaml` (2, regenerate with
`pnpm install --lockfile-only`, never hand-merge), and one hunk each in
`apps/desktop/src/ipc/channels.ts`, `packages/contracts/src/settings.ts`,
`CodexDeveloperInstructions.ts`, `ProviderInstanceRegistryLive.ts`,
`ProviderService.test.ts`, `MessagesTimeline.tsx`, `desktopUpdate.logic.ts`.

Traps: `origin/main` of the fork is the public T3 commit `6ae44b418`, so any
`origin/main..` count above 3000 is the missing-ancestry problem, not a real
diff. macOS BSD `grep` treats several of these `.tsx` files as binary — count
conflict hunks with `grep -a` or the map undercounts (39 vs the true 43). The
stack has 4 root commits (T3 plus three imported repositories), which breaks
`git rebase` and `git filter-branch` but not the re-parent replay.

## 15. Test and release matrix

Every wave uses targeted tests while developing. Before a public Workjet beta:

MEASURED 2026-08-20 at `f60f69674` (clean tree, so every failure below is
PRE-EXISTING and none of it was caused by the measurement). Host: macOS
Darwin 25.2.0 / Apple Silicon, Node v26.6.0, cargo 1.97.0, pnpm 11.10.0,
checkout on `/Volumes/tmp`. Every verdict below is backed by a log under
`/Volumes/tmp/workjet/logs/gate-<name>.log`; the mechanically re-runnable
command list lives in `docs/workjet-release-gate-status.md`. Disk on
`/Volumes/tmp`: 84 GiB free before, 74 GiB after (two macOS packages plus
three cargo target dirs). `vp` is not on PATH — use `./node_modules/.bin/vp`.

- [~] Full contracts, server, client-runtime, web, and desktop typecheck.
  `./node_modules/.bin/vp run --filter <pkg> typecheck` per package:
  contracts PASS (exit 0), client-runtime PASS, web PASS, desktop PASS,
  server (`--filter t3`) FAIL exit 1 with exactly **57** `error TS` — the
  documented pre-existing baseline, unchanged. The repo-wide CI form
  `vp run -r --concurrency-limit 2 typecheck` FAILS (exit 1, 2:29) on two
  tasks: `t3` (57) and `@t3tools/mobile` (**8** errors, all
  "`workjetConfig` is missing" on `EnvironmentThreadShell` fixtures — the
  contract made the field required without updating the mobile fixtures).
  Mobile is not named in this gate line but is what makes CI's
  `vpr typecheck` red. Logs: `gate-typecheck-contracts.log`,
  `gate-typecheck-client-runtime.log`, `gate-typecheck-web.log`,
  `gate-typecheck-desktop.log`, `gate-typecheck-server-cli.log`,
  `gate-typecheck-mobile.log`, `gate-typecheck-all.log`.
- [x] Full relevant T3 test suites. `./node_modules/.bin/vp run -r test` →
      exit 0, 15/15 tasks, **950 test files (+2 skipped), 9 605 tests passed
      (+7 skipped)**, 5:41. Log `gate-t3-full-test-rerun.log`. Caveat: the
      same command run while a cargo build competed for CPU failed (exit 1) —
      `scripts/lib/cli-external-packages.test.ts` hit its 60 000 ms timeout and
      aborted web/mobile/desktop (`gate-t3-full-test.log`). Run it unloaded.
- [~] Provider-gateway Rust test, clippy, fmt, differential, and real-account
  opt-in gates. **test PASS**, run in `native/provider-gateway` with
  `CARGO_TARGET_DIR=/Volumes/tmp/workjet/cargo-target-rg`:
  `cargo test -p workjet-provider-gateway --no-fail-fast -- --test-threads=1`
  → exit 0,
  **2 553 passed, 0 failed, 3 ignored**. **clippy FAIL** (pre-existing):
  `cargo clippy -p workjet-provider-gateway --all-targets -- -D warnings`
  → exit 101, 1 error, `unnecessary_get_then_check` at
  `internal/auth/codex/openai_auth_test.rs:121`. **fmt FAIL**
  (pre-existing):
  `cargo fmt --check --manifest-path native/provider-gateway/Cargo.toml`
  → exit 1, 16 hunks in 4 files, all
  introduced by `e9028a3ae`. **differential NOT-RUNNABLE-HERE**: the 26
  `scripts/run_*_differential.sh` need the Go CLIProxyAPI upstream at
  `$repo_dir/runtime/cliproxyapi-upstream`, and their `repo_dir` is
  computed as `$crate_dir/../../../..` — two levels ABOVE the Workjet repo
  root; neither that path nor `<repo>/runtime/` exists (Go itself is
  installed). **real-account NOT-RUNNABLE-HERE**: needs live subscription
  logins; no opt-in runner exists in the repo. Logs:
  `gate-provider-gateway-test-serial.log`, `gate-provider-gateway-clippy.log`,
  `gate-provider-gateway-fmt.log`. NOTE: under load
  the four `--test plugin_supervisor` tests fail with `Err(Handshake)`
  (child Unix-socket callback times out); green serially
  (`gate-provider-gateway-plugin-supervisor-retry.log`).
- [~] Web Stack Rust, fixture, SSRF, search, browser, and E2E gates.
  **Rust/fixture/SSRF PASS**, run in `native/web-stack` with
  `CARGO_TARGET_DIR=/Volumes/tmp/workjet/cargo-target-webstack`:
  `cargo test --all-features --no-fail-fast -- --test-threads=1` → exit 0,
  **463 passed, 0 failed, 23 ignored** (lib 454, `capability_contract` 2,
  `scrape_target_fixtures` 6, one long integration test). SSRF is the 7
  `src/egress.rs` tests plus `apps/server/.../WebStackEgressWiring.test.ts`.
  UPDATED 2026-08-20 after the scholarly-agent SSRF fix: `cargo test
--all-features` (default threads, `CARGO_TARGET_DIR=/Volumes/tmp/workjet/
cargo-target-ss`) → exit 0, **469 passed, 0 failed, 23 ignored** (lib 460,
  `capability_contract` 2, `scrape_target_fixtures` 6, one long integration
  test). SSRF is now 8 `src/egress.rs` tests (the eighth pins the redirect hop
  cap) plus 5 new `src/scholarly_search.rs` egress tests plus the TS wiring
  gate, whose `KNOWN_UNRESOLVED_AGENTS` list is empty.
  `cargo fmt --check` and
  `cargo clippy --all-targets --all-features -- -D warnings`
  both PASS. **search/browser/E2E NOT-RUNNABLE-HERE**:
  `scripts/test_web_search_e2e.sh` and `scripts/test_web_unlock_e2e.sh`
  both require a built **`ctox`** binary at
  `$ROOT/runtime/build/cargo-target/{debug,release}/ctox` (CTOX repo, not
  vendored here), live network, and a patchright + Chromium runtime. Logs:
  `gate-web-stack-test-serial.log`, `gate-web-stack-clippy-fmt.log`,
  `gate-web-stack-test-retry3.log`. Three lib
  tests are load-flaky (loopback fixture servers); green serially.
- [x] Workjet orchestration restart, cancellation, duplicate, and remote tests.
      `cd apps/server && ../../node_modules/.bin/vp test run src/workjet/` →
      exit 0, **20 files, 384 tests**, 119.6 s.
      Log `gate-workjet-orchestration.log`. (Supersedes the "32 files, 489
      tests" figure recorded in section 8 — that count does not reproduce.)
- [x] CTOX WebRTC data-plane guard and Business OS launch tests.
      In `apps/desktop`:
      `../../node_modules/.bin/vp test run src/ctox/ src/ipc/methods/ctox.test.ts`
      → exit 0, **14 files, 195 tests**.
      Log `gate-ctox-webrtc-businessos.log`.
- [x] Desktop managed/local/SSH/invite/session/keychain parity matrix.
      `./node_modules/.bin/vp run --filter @t3tools/desktop test` → exit 0,
      **83 files, 816 tests**, 85.7 s. Log `gate-desktop-parity.log`.
- [ ] Real end-to-end user stories for Code mode and CTOX mode.
      **NO RUNNABLE GATE EXISTS.** `apps/web` declares a single vitest project
      (`unit`); there is no Playwright/WebDriver harness and no scripted
      version of either story below. Closest artefacts:
      `apps/server/integration/OrchestrationEngineHarness.integration.ts`
      (in-process, no UI) and `apps/desktop/scripts/smoke-test.mjs` (an 8 s
      launch-and-grep). What must be built: a driver that boots the app
      against a disposable state directory and asserts delivery receipts,
      durable status, result return, cancellation, and restart recovery.
- [~] Packaged macOS arm64 and x64 tests first; then Linux and Windows targets.
  **macOS arm64 PASS**: `./node_modules/.bin/vp run dist:desktop:dmg:arm64`
  → exit 0, 4:29, `release/CTOX-Desktop-App-0.0.33-arm64.dmg`
  (282 703 523 B) + `.zip` (273 376 002 B) + blockmaps.
  **macOS x64 PASS**: `dist:desktop:dmg:x64` → exit 0, 3:18, matching
  `-x64` artifacts. Both UNSIGNED (no credentials here) and neither emits
  a `latest-mac*.yml` update manifest locally — CI's "Collect release
  assets" step does that. Prerequisite CI steps also PASS:
  `vp run build:desktop` (exit 0, 28 s) plus the preload contract greps,
  and `vp run --filter @t3tools/desktop smoke-test` (Electron launches,
  "Desktop smoke test passed."). **Linux NOT-RUNNABLE-HERE**:
  `dist:desktop:linux` AppImage from macOS needs a Linux container
  toolchain that is not installed. **Windows NOT-RUNNABLE-HERE**:
  `dist:desktop:win` needs NSIS plus the `wsl-prebuild/pty.node` artifact
  from the release workflow's `build_wsl_node_pty` job. Logs
  `gate-package-mac-{arm64,x64}.log`, `gate-desktop-build-smoke.log`.
- [~] Signing, notarization, update, checksum, and provenance verification.
  **Signing / notarization NOT-RUNNABLE-HERE**: no `CSC_LINK`,
  `CSC_KEY_PASSWORD`, `APPLE_TEAM_ID`, `MACOS_PROVISIONING_PROFILE`, or
  App Store Connect key locally. Proven on the artifact built above:
  `codesign -dv` → "code object is not signed at all" (exit 1),
  `spctl -a` → "rejected" (exit 3), `xcrun stapler validate` → "does not
  have a ticket stapled to it" (`gate-signing-check.log`).
  **Update/checksum FAIL — GATE-RUNNER BUG, not a product defect**:
  `node scripts/release-smoke.ts` exits 1. Its fixed `workspaceFiles`
  list omits `packages/workjet-capabilities/package.json`, so the temp-root
  `vp install --lockfile-only` dies with
  `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` — "In apps/server:
  @metric-space-ai/workjet-capabilities@workspace:\* is in the dependencies but
  no package named @metric-space-ai/workjet-capabilities is present in the
  workspace". Reproduced by hand; the one-line fix is to add that
  path. Underlying unit coverage is green:
  `vp run --filter @t3tools/scripts test` → exit 0, 23 files, 304 tests,
  including `merge-update-manifests.test.ts` and
  `mock-update-server.test.ts`. **Provenance NOT-RUNNABLE-HERE**:
  `apps/desktop/resources/provider-gateway/host-release.pin.json` is
  `"status": "unreleased"`, so
  `node scripts/provider-gateway-host-artifacts.ts verify --dir <dir>` has
  nothing to verify. Logs: `gate-release-smoke.log`,
  `gate-test-scripts.log`, `gate-gateway-host-artifact-verify.log`.
- [~] Fresh-install, upgrade, rollback, and legacy-settings import tests.
  **Legacy-settings import PASS**: the four
  `apps/server/src/workjet/legacy/*.test.ts` files are green inside the
  20-file/384-test run above. **Fresh-install / upgrade / rollback: NO
  RUNNABLE GATE EXISTS.** Update _logic_ is unit-tested
  (`apps/desktop/src/updates/*`, `ElectronUpdater.test.ts`,
  `apps/web/src/components/desktopUpdate.*`) and
  `scripts/mock-update-server.ts` exists, but nothing installs a packaged
  build into a clean prefix, upgrades it, forces a rollback, and asserts
  the settings store survives.
- [x] No tracked dependency/build/runtime artifacts.
      `git ls-files` filtered for `node_modules/`, `dist/`, `dist-electron/`,
      `out/`, `target/`, `.vite-plus/`, `.venv/` → 0 hits; filtered for
      `^runtime/` → 0 hits. Seven tracked binaries remain, all inherited from
      upstream T3 mobile vendoring (`ab63ef1cd`): one `.tgz`, two
      `libghostty-fat.a`, four `libghostty-vt.so`. Log
      `gate-no-tracked-artifacts.log`.

Adjacent gates measured at the same time, because CI runs them on the same
commit:

- [ ] CI `Check` step — `./node_modules/.bin/vp check` → FAIL exit 1,
      **143 tracked files** unformatted (82 `native/web-stack`, 35
      `native/provider-gateway`, 13 `experiments/kundenpipeline-module`, 5
      `native/pdf-parse`, 5 `apps/server`, 2 `apps/web`, 1
      `docs/kundenpipeline-board.md`). Fixable with `vp check --fix`.
      Log `gate-vp-check.log`.
- [x] resource-monitor —
      `cargo fmt --manifest-path native/resource-monitor/Cargo.toml -- --check`
      and
      `cargo test --locked --manifest-path native/resource-monitor/Cargo.toml`
      → both exit 0, 15 tests. Log `gate-resource-monitor.log`.
- [x] Licensing release gate (section 13) —
      `node scripts/generate-release-notice.ts --check` and
      `node scripts/check-capability-version-lock.ts --check` → both exit 0.
      Log `gate-notice-capabilities.log`.
- [x] `node --test .github/scripts/thread-transfer-report.test.cjs` → exit 0,
      6/6 tests. **KORREKTUR**: this suite was believed broken since
      2026-08-07; it is green at `f60f69674`.
      Log `gate-thread-transfer-report.log`.

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
15. [x] Add the configurable per-environment temporary worktree storage root,
        prove new Code and orchestrated worker worktrees land on an operator-
        selected `/Volumes/tmp` root, and prove existing active worktrees plus
        durable state remain untouched when the setting changes.
        CLOSED 2026-08-19: all three remaining gaps are shut. The real-stack
        end-to-end proof is `WorkerDispatch.e2e.test.ts` (see below); commit
        `066ba076a` adds the durable cleanup at the `thread.deleted` boundary
        via `ThreadDeletionReactor` + `WorkerWorktreeCleanup` (role guard,
        trusted-root containment, exact-ref guard, never fatal for the
        deletion, idempotent) plus `GitVcsDriverCore.deleteBranch` and
        worker-branch-ref deletion on the dispatch rollback path.
        Interpretation note: cleanup binds to DELETION, deliberately not to
        completion or archiving — a completed worker's worktree holds its
        results until integration, and archiving is reversible.
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
