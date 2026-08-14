# Workjet architecture

Workjet is the single desktop application for two product modes:

- **Code** runs T3-derived projects and threads with Codex, Claude Code, Grok,
  and other provider drivers. Workjet adds native orchestrator and worker roles.
- **CTOX** manages the CTOX instances available to the signed-in operator and
  presents the selected instance's Business OS in the main content area.

CTOX remains a separate server and Business OS project. Its standalone Electron
application is migrated into Workjet and retired only after feature and release
parity is proven.

## Ownership boundaries

| Capability                                                                     | Canonical owner             | Runtime boundary                                     |
| ------------------------------------------------------------------------------ | --------------------------- | ---------------------------------------------------- |
| Desktop window, release, updates, settings, and product-mode navigation        | Workjet                     | Electron main process and Workjet renderer           |
| T3 projects, threads, turns, workspaces, and remote environments               | Workjet T3 server           | Typed Effect RPC                                     |
| Orchestrator/worker roles and parent-child thread relationships                | Workjet T3 server           | Event-sourced command/event/projection flow          |
| Shared skill and tool implementations                                          | Workjet                     | Versioned registry with harness and CTOX adapters    |
| Provider protocol translation, subscriptions, account pools, and cooldowns     | Shared Workjet Rust package | One isolated gateway runtime per product authority   |
| CTOX instance discovery, login, pairing, and shell launch                      | Workjet                     | Electron session, keychain, and isolated guest views |
| CTOX Business OS records, commands, files, policies, and durable orchestration | CTOX                        | CTOX Sync Engine over WebRTC                         |
| External agent control of CTOX Business OS                                     | CTOX                        | Typed Business OS MCP channel                        |

The two modes share desktop infrastructure and the same source packages for
skills, tools, and provider integration. They do not share a runtime or state
machine: a T3 thread remains a T3 thread, and a CTOX thread or command remains
authoritative inside its closed CTOX instance.

## Desktop composition

The existing Workjet renderer remains the privileged application chrome. A
top-level product-mode switch selects one of two navigation models:

1. Code mode renders the existing T3 project/thread sidebar and chat workspace.
2. CTOX mode renders the CTOX instance sidebar. Selecting an instance attaches
   its Business OS guest surface inside the main content region.

The CTOX guest uses Electron `WebContentsView`, not a DOM iframe and not a
second `BrowserWindow`. Each instance receives a stable, isolated persistent
session partition. The port reuses the existing CTOX Desktop contracts for:

- ctox.dev authentication and `/api/desktop/session-package` discovery;
- short-lived managed launch tokens;
- local, SSH-managed, invite, and manual-pairing instance sources;
- platform-keychain storage for room, capability, and SSH secrets;
- the bundled, version-matched Business OS shell and packed launch context;
- permission denial, navigation restrictions, secret scrubbing, and the HTTP
  data-path guard.

Business OS data never traverses a new Workjet HTTP API. The embedded shell
continues to replicate directly with the selected CTOX daemon through the CTOX
Sync Engine WebRTC room. Workjet owns only control-plane bootstrap and view
lifecycle.

## Shared skills and tools

One registry and implementation package describes a capability independently
from its execution host:

- stable ID and version;
- human-facing metadata;
- required permissions and secrets;
- prompt contribution;
- MCP/tool schema;
- supported execution adapters (`t3`, `ctox`, or both).

The T3 adapter publishes enabled tools through the existing per-session T3 MCP
server. The CTOX adapter installs or invokes the same capability through CTOX's
typed Business OS MCP/control channel. Business OS application data still uses
WebRTC; MCP is a control surface, not a replacement data plane.

Greppy remains a managed external engine behind one registry entry. Web search
is another independently switchable entry. The CTOX Rust Web Stack moves into
Workjet as the canonical shared Web Stack package; CTOX and all T3 harnesses
consume that same versioned implementation. Thread or instance configuration
stores enabled capability IDs, while the registry resolves those IDs to the
current implementation.

## Shared provider-gateway code

The portable CLIProxyAPI Rust port currently maintained in CTOX becomes the
canonical shared Workjet provider-gateway package. Its provider-neutral Track A
is moved first; CTOX-specific persistence and Business OS projection code stays
in CTOX or is replaced by thin CTOX adapters.

Each gateway runtime exposes OpenAI-, Anthropic-, Gemini-, and provider-specific
compatibility surfaces plus a separate authenticated management interface. It
owns subscription authentication, model discovery, account selection, weights,
cooldowns, refresh, translation, streaming, redaction, and the local mapping
from a provider profile to allowed accounts and models.

Workjet/T3 runs one gateway for all Codex, Claude Code, Grok, and other harnesses
attached to that T3 runtime. Those harnesses do not persist provider OAuth
tokens and do not carry independent provider routing logic.

Every CTOX instance remains a closed product authority and runs its own gateway
runtime from the same shared Rust codebase. A CTOX instance is not another T3
harness and never forwards its provider traffic or credentials through the
Workjet/T3 gateway.

Provider credentials remain in the secret store of the owning runtime: the
Workjet/T3 gateway for T3 harnesses, or the individual CTOX instance gateway for
CTOX. Raw subscription tokens are never copied across these authorities or into
T3 thread events, browser storage, harness configuration, or desktop instance
registries.

## Migration order

1. Add backward-compatible Workjet thread roles and skill configuration to the
   T3 event model.
2. Move the CTOX Web Stack into the shared skill/tool registry and add T3 and
   CTOX adapters without duplicating its implementation.
3. Move and rename the portable Rust provider gateway, preserving its complete
   conformance gate before changing host integration.
4. Port CTOX Desktop instance/session capabilities into typed Workjet Electron
   services and add the Code/CTOX mode switch.
5. Run managed, local, SSH, invite, WebRTC-only, keychain, and packaged-app
   parity tests in Workjet.
6. Change CTOX and every T3 harness to consume the shared provider-gateway and
   Web Stack source packages while retaining separate runtime instances.
7. Remove `src/apps/business-os-desktop` from CTOX only after the Workjet
   replacement passes the same release evidence.

## License policy

T3 Code is MIT-licensed. CTOX and the current Rust port mark CTOX modifications
as AGPL-3.0-only. Metric Space AI has authorized CTOX-owned components shared
with Workjet under `MIT OR AGPL-3.0-only`. Workjet can therefore use the MIT
option while CTOX continues to be distributed under AGPL. Imported files must
receive the dual SPDX expression only when Metric Space AI owns or controls the
necessary copyright. T3, CLIProxyAPI, Greppy, and all other third-party notices
remain intact. The authoritative rules are in `LICENSE_POLICY.md`.
