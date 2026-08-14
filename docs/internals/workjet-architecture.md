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

| Capability                                                                     | Canonical owner          | Runtime boundary                                           |
| ------------------------------------------------------------------------------ | ------------------------ | ---------------------------------------------------------- |
| Desktop window, release, updates, settings, and product-mode navigation        | Workjet                  | Electron main process and Workjet renderer                 |
| T3 projects, threads, turns, workspaces, and remote environments               | Workjet T3 server        | Typed Effect RPC                                           |
| Orchestrator/worker roles and parent-child thread relationships                | Workjet T3 server        | Event-sourced command/event/projection flow                |
| Shared skill and tool manifests                                                | Workjet                  | Versioned registry with harness and CTOX adapters          |
| Provider protocol translation, subscriptions, account pools, and cooldowns     | Workjet provider gateway | Rust library/binary with authenticated loopback management |
| CTOX instance discovery, login, pairing, and shell launch                      | Workjet                  | Electron session, keychain, and isolated guest views       |
| CTOX Business OS records, commands, files, policies, and durable orchestration | CTOX                     | CTOX Sync Engine over WebRTC                               |
| External agent control of CTOX Business OS                                     | CTOX                     | Typed Business OS MCP channel                              |

The two modes share desktop infrastructure, skills, tools, and provider
profiles. They do not share a state machine: a T3 thread remains a T3 thread,
and a CTOX thread or command remains authoritative in CTOX.

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

One registry describes a capability independently from its execution host:

- stable ID and version;
- human-facing metadata;
- required permissions and secrets;
- prompt contribution;
- MCP/tool schema;
- supported execution adapters (`t3`, `ctox`, or both).

The T3 adapter publishes enabled tools through the existing per-session T3 MCP
server. The CTOX adapter installs or invokes the corresponding capability
through CTOX's typed Business OS MCP/control channel. Business OS application
data still uses WebRTC; MCP is a control surface, not a replacement data plane.

Greppy remains a managed external engine behind one registry entry. Web search
is another independently switchable entry. Thread configuration stores enabled
skill IDs, while the registry resolves those IDs to the current implementation.

## Provider gateway

The portable CLIProxyAPI Rust port currently maintained in CTOX becomes
Workjet's canonical provider-gateway package. Its provider-neutral Track A is
moved first; CTOX-specific persistence and Business OS projection code stays in
CTOX or is replaced by Workjet adapters.

The gateway exposes OpenAI-, Anthropic-, Gemini-, and provider-specific
compatibility surfaces plus a separate authenticated management interface. It
owns subscription authentication, model discovery, account selection, weights,
cooldowns, refresh, translation, streaming, and redaction.

Every execution host runs the gateway next to the harness that consumes it:

- Workjet Desktop bundles it for local T3 environments.
- Remote T3 servers run the same version beside their provider drivers.
- CTOX consumes the versioned Workjet Rust crate and runs it beside its own
  coding runtime.

Credentials remain local to each execution host and are referenced through its
secret store. Provider profiles may be managed from one Workjet UI, but raw
subscription tokens are never copied through thread events or browser storage.

## Migration order

1. Add backward-compatible Workjet thread roles and skill configuration to the
   T3 event model.
2. Introduce the shared skill/tool registry and adapters without changing
   existing T3 provider selection.
3. Move and rename the portable Rust provider gateway, preserving its complete
   conformance gate before changing host integration.
4. Port CTOX Desktop instance/session capabilities into typed Workjet Electron
   services and add the Code/CTOX mode switch.
5. Run managed, local, SSH, invite, WebRTC-only, keychain, and packaged-app
   parity tests in Workjet.
6. Change CTOX to consume the versioned Workjet gateway package.
7. Remove `src/apps/business-os-desktop` from CTOX only after the Workjet
   replacement passes the same release evidence.

## Open release gate

T3 Code is MIT-licensed. CTOX and the current Rust port mark CTOX modifications
as AGPL-3.0-only. Before distributing the combined application, choose and
document either an AGPL Workjet distribution or an additional license grant for
the CTOX-owned components while retaining all upstream MIT notices. No license
headers are changed implicitly during the port.
