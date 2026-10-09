# Harness compendium — 9 October 2026

Owner: Michael. Commission: Workjet supervisor. Research checkout: `harness-compendium`, base `e15cb09d9`. [PR #298](https://github.com/metric-space-ai/workjet/pull/298) is for the Harness parent to review; this thread must not merge it. The first matrix was pushed in WIP commit `baf5301fc`; the receipts carry measured timestamps, including probes after midnight Berlin on 10 October.

The organisational principle, thread-move concept and three role drafts were read first. Workjet owns the canonical transcript, goal, schedule, thread ID and workspace. A native harness session is replaceable execution state. An ordinary turn ending does not establish goal completion.

The live work proved native Codex goal completion, four harnesses executing injected tools, three distinct-model switches, native history operations, and a **Pi ↔ OpenCode exchange through two persisted Workjet threads**. Claude's model-backed checks require login; MiniMax's agent CLI is absent. Those results are explicit gaps, not passes. This research does not implement or accept the installed three-role product.

## Evidence and installed inventory

**PASS** means the specific request and relevant result were measured. **DISCOVERY** means installed help/protocol advertised a mechanism. **LIMIT** means a request failed, was a no-op, or proved only part of the capability. **MISSING** means there was no executable. A rejected guessed RPC method says nothing about differently named native commands.

[JSON receipts](harness-probe-evidence-20261009/) contain time, executable, requests, results and owned-process cleanup. [Probe scripts and invocation guide](../../scripts/harness-probes/README.md) make the checks repeatable. Publication omits credentials, reasoning, unrelated file-read output and unvalidated model menus. Sanitized responses are evidence, not executable request templates. No guessed model IDs are defined in the probes: GLM selections come from authenticated `/models` responses and the observed CTOX catalog. Bundled menus and model aliases are not account-entitlement evidence.

| Harness | Installed version | Finding |
|---|---|---|
| Claude Code | 2.1.296 | `claude`, native binary in the global npm package. Both default and Workjet's configured profile reported no login. |
| Codex CLI | 0.162.0-alpha.2 | Settings' executable exists at `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`. PATH `codex` points to a missing older resource. |
| Grok CLI / Grok Build | 1.0.50, c58f321264ba | `~/.grok/bin/grok` identifies as Grok Build TUI. This is one installed harness; unrelated Grok CLI implementations are not interchangeable. |
| OpenCode | 1.18.35 | `opencode`, native binary in the global npm package. |
| MiniMax Code | Agent CLI missing | `mcode`: ENOENT. MiniMax Code.app exists; its `mcode-tools/cli.mjs` is a connector utility, not the agent. |
| Greppy | 0.4.1 | Local development/recovery binary; `greppy agent stdio` speaks ACP. |
| Pi | 0.80.2 | `@earendil-works/pi-coding-agent`, RPC and native extensions. |

## Capability matrix

Mechanisms, commands, measured outputs, limits and implementation choices are expanded in the seven adapter specifications below.

| Harness | 1. Goal / loop | 2. System extension | 3. Tool injection | 4. Thread communication | 5. History / compact / export | 6. Running-session model |
|---|---|---|---|---|---|---|
| Claude | DISCOVERY: native `/goal`, `/loop`; completion blocked by login. Workjet controller until validated. | CLI append/file flags; SDK preset + append. Snapshot on resume; priority unproved without model. | PASS discovery: stdio MCP connected, `mcp__workjet_probe__probe_echo`; execution blocked by login. | Scoped MCP mailbox adapter specified; Claude exchange unproved. | Stream user-context conversion; `/compact` says too few messages. Native resume/export formats; foreign recall unproved. | SDK `set_model(null)` ACK; distinct switch unproved. |
| Codex | PASS: `thread/goal/set/get/clear`, active → complete; paused persistence. | PASS: `developerInstructions` beat conflicting `AGENTS.md` in the probe. | PASS: `dynamicTools` → `item/tool/call` → successful receipt. | Dynamic tools can wrap the same mailbox facade; native echo proved, cross-exchange used Pi/OpenCode. | PASS: Responses-item injection; `contextCompaction` completion; `thread/read` export. | Next-turn `turn/start.model` in installed schema. Distinct-model execution not proved with a validated second account model. |
| Grok Build | Native `/goal`; LIMIT: answer produced, then `InfraPaused`, no plan. `/loop` advertised. | PASS: `session/new._meta.rules` and `.systemPromptOverride`; root CLI override was ineffective on tested ACP path. | PASS actual MCP call: `workjet_probe__probe_echo`; legacy probe then performed unwanted reads and timed out. | Session MCP mailbox adapter specified; local injected tool proved. | Foreign readable context recalled; native compact event was a no-op for small history; Markdown export passed. | Same-model `session/set_model` ACK. Native live config switch exists; distinct model awaits validated xAI list. |
| OpenCode | No advertised goal lifecycle; guessed getter rejected. Workjet owns continuation/condition. | PASS: primary agent `prompt`, selected through ACP mode; conflicting `AGENTS.md` did not win the probe. | PASS: ACP stdio MCP, `workjet_probe_probe_echo`. | PASS: MCP tools read Pi's envelope and sent a durable reply. | PASS: context conversion + native `/compact`; JSON export/import roundtrip. | PASS: `session/set_config_option`, two live-listed GLM models, same session, marker retained. |
| MiniMax Code | MISSING; bounded ACP turn/Workjet-loop specification only. | Existing adapter's managed context; native priority unknown. | Existing adapter configures ACP HTTP MCP; no installed proof. | MCP facade specification only. | Native load/config described by adapter; import/compact/export unproved. | No installed proof. Discover live config options after install. |
| Greppy | Bounded tool loop; Workjet persistent goal controller. No native durable goal state advertised. | Managed user context fallback; no advertised system setter. Do not call it system-level priority. | LIMIT: ACP rejects nonempty `mcpServers`; native tool bridge still required. | No arbitrary injected function/MCP proof; bounded terminal facade possible, production bridge unfinished. | PASS: `_workjet/import_history` ACK + recall/replay. ACP `/compact` is ordinary model text, not native compaction. | PASS: `session/set_model`, two live-listed GLM models, same session, marker retained. |
| Pi | No `get_goal` RPC; Workjet controller using follow-up and final `agent_end`. | PASS: `before_agent_start` appended role after loaded project context. | PASS: native extension `registerTool`, unprefixed `probe_echo`. | PASS: native `thread_send`, then `thread_read` of OpenCode's reply. | PASS: converted v3 JSONL import, native `compact`, marker recall, messages/HTML export. | PASS: RPC `set_model`, distinct live-listed Z.ai models, same session. Setter also updates profile default. |

## Claude Code adapter specification

**Evidence:** [claude-live.json](harness-probe-evidence-20261009/claude-live.json), [help](harness-probe-evidence-20261009/claude-help.json), [gateway validation failure](harness-probe-evidence-20261009/claude-gateway-validated.json). Command: `claude --print --input-format stream-json --output-format stream-json --verbose …`; probe: `claude_probe.py`. Initialization advertised built-in `goal` (“keep working until the condition is met”), `loop`, and `compact`. This installed release has native goal/interval concepts; the earlier assumption that Claude has only turns is incorrect. Their persisted statuses, recovery and successful completion remain unproved because the model result was `Not logged in · Please run /login`. The alternate gateway route rejected the validated custom model with `auth_failed`/`unrecognized_model`; it is not an authenticated Claude pass.

Use the SDK's default `claude_code` preset plus `append`, or CLI `--append-system-prompt` / `--append-system-prompt-file`, preserving its ordinary tools and project context. Installed help says prompt snapshots are enabled by default: resumed sessions reuse the recorded prompt until compaction. `--system-prompt-snapshot off` rerenders per request. A changed role must therefore deliberately refresh the snapshot or rebuild/resume the executor. Flag acceptance does not prove priority over `CLAUDE.md`; that check still needs an authenticated model turn.

Configure a session-scoped MCP server. The initialization result showed `workjet_probe` **connected**, source `dynamic`, and exposed `mcp__workjet_probe__probe_echo`. Model execution did not reach the tool. Bind mailbox credentials and source identity outside model arguments; permit only the role's actual actions.

Foreign history should initially be readable user context through stream JSON, with foreign tool records attributed and flattened. Preserve the complete transcript in Workjet; use native resume only for Claude's own session data. `/compact` was handled but returned `Not enough messages to compact`; no native summary or recall was established. Export the SDK event stream/native JSONL as execution evidence, not the portable canonical transcript. SDK `set_model(null)` succeeded as a reset/no-op; distinct-model control and history persistence need login and a live account list.

**Implement:** retain the existing SDK adapter, add version-gated native goal support only after the completion/recovery probe passes, otherwise let Workjet own the loop. Treat `result.is_error`/`terminal_reason` separately from end-of-turn. Owner action: log into the configured Claude profile, then rerun goal completion, role priority, tool execution, history compaction/recall and a second valid model.

## Codex CLI adapter specification

**Evidence:** [codex-goal.json](harness-probe-evidence-20261009/codex-goal.json), [codex-priority.json](harness-probe-evidence-20261009/codex-priority.json), [codex-live.json](harness-probe-evidence-20261009/codex-live.json). Command: Settings' binary `app-server --listen stdio://`; scripts: `codex_goal_probe.py`, `codex_probe.py`. Initialize with `experimentalApi: true` and generate the exact installed JSON schema when upgrading.

`thread/goal/set` accepted an objective with no token budget. Paused state survived `get`; `clear` acknowledged removal. The active probe reached native **complete**, confirmed by `thread/goal/get`; the isolated goal was cleared and its thread archived. Installed statuses include `active`, `paused`, `blocked`, `usageLimited`, `budgetLimited`, `complete`; origins include user/automatic. Native accounting is useful, but Workjet must verify its own condition receipt before closing a project goal. Avoid a second Workjet continuation loop while Codex's native goal loop owns execution. Owner pause and stop controls must map explicitly; resource admission waits must not silently pause the durable goal.

`thread/start.developerInstructions` accepted the role. With a conflicting scratch `AGENTS.md`, the completed reply was `ROLE_PROBE_OK`. This proves the tested conflict, not universal obedience. `dynamicTools` declared `probe_echo`; the child sent `item/tool/call`, the client returned typed content and success, and `dynamicToolCall.success` became true. Native dynamic tools are the preferred local Workjet binding; retain MCP for shared/remote integrations.

`thread/inject_items` accepted a Responses-format user message carrying `HISTORY_PROBE_42`. It is experimental, not a generic provider-transcript import. Convert foreign signatures/tool turns into supported readable items. `thread/compact/start` returned an ACK; actual completion arrived as **`item/completed` with `item.type: contextCompaction`**, not an ordinary `turn/completed`. `thread/read(includeTurns: true)` exported the resulting transcript.

Installed `turn/start.model` can select a model for this and subsequent turns; switch at a turn boundary without changing thread ID. No distinct-model execution was attempted because a second model in this Codex account was not validated against a live entitlement source. Static `model/list` entries alone must not become Workjet suggestions. Separate schema support from an executed switch.

**Implement:** app-server adapter with developer role, dynamic mailbox tools, native goal lifecycle and compaction-event drain. Preserve Workjet ID when replacing a Codex executor or moving computers; native goal ID/state is an execution projection. Resolve the Settings binary directly; repairing the broken PATH symlink is optional environment maintenance.

## Grok Build adapter specification

**Evidence:** [grok-goal.json](harness-probe-evidence-20261009/grok-goal.json), [grok-priority-meta.json](harness-probe-evidence-20261009/grok-priority-meta.json), [grok-tools.json](harness-probe-evidence-20261009/grok-tools.json), [grok-history.json](harness-probe-evidence-20261009/grok-history.json). Command: `grok --no-auto-update agent --no-leader stdio`; scripts: `grok_goal_probe.py`, `grok_prompt_probe.py`, `acp_tools_probe.py`, `grok_history_probe.py`. `--no-leader` isolates the probe from shared clients; suppress background update checks in production integrations too.

ACP advertised native `/goal` and `/loop`, and stop-hook fields `continue`, `stopReason`, `additionalContext`. `/goal` produced `GOAL_PROBE_COMPLETE` but the following status was **`InfraPaused | Phase: Executing`**, with “No plan was produced.” The probe cleared its goal. Text was not completion. The guessed `session/goal/get` RPC rejected with -32601 while the native slash command worked. Preserve that distinction; native goal recovery is not yet a dependable Workjet completion path.

Use **`session/new._meta.rules`** to append role instructions while retaining the default prompt. `_meta.systemPromptOverride` replaces it; both mechanisms yielded `ROLE_PROBE_OK` against conflicting scratch `AGENTS.md`. There is no demonstrated per-turn prompt setter: change roles by loading/starting an executor with current metadata at a safe boundary. The first root `--system-prompt-override … agent stdio` probe did not establish priority and performed unwanted built-in reads. This is why CLI flag presence is not a passing ACP integration. Prompt instructions do not sandbox built-in tools.

ACP `mcpServers` advertised stdio/HTTP/SSE support. A real stdio MCP call used **`workjet_probe__probe_echo`** and returned `PROBE_TOOL_RECEIPT`. The same legacy run subsequently performed unrelated reads and exceeded its prompt deadline; only the local tool invocation is a pass. Native permission behavior and read-tool confinement need integration coverage. Use per-session MCP plus discovered names; do not assume Claude's prefix.

Readable foreign history supplied in a user prompt was recalled on the next turn. `/compact` emitted `_x.ai/session_notification` with `auto_compact_completed`, but `tokens_before == tokens_after == 19350`, `summary_preview: null`: **native command completion, no reduction for this small history**. `grok export <owned-session-id>` exited 0 with Markdown. Arbitrary native foreign-transcript import was not established. `session/set_model` accepted the existing selection; installed ACP live config supports model changes, but a distinct switch needs a second live-listed xAI model. Workjet must not persist the static advertised model menu as recommendations.

**Implement:** ACP metadata role extension, session MCP mailbox, native update/permission drain, Workjet goal controller until native goal completion/recovery is proven. Prefer advertised `session/set_config_option` for live selections, retain legacy `session/set_model` compatibility. Keep the Workjet controller as the only continuation owner when using native stop hooks.

## OpenCode adapter specification

**Evidence:** [opencode-tools-validated.json](harness-probe-evidence-20261009/opencode-tools-validated.json), [opencode-history.json](harness-probe-evidence-20261009/opencode-history.json), [cross-harness-summary.json](harness-probe-evidence-20261009/cross-harness-summary.json). Command: `opencode --pure acp`; scripts: `acp_tools_probe.py`, `opencode_history_probe.py`, mailbox scripts. No native durable goal lifecycle was advertised; a guessed getter rejected. The successful prompt result is a turn, not a goal.

For installed 1.18.35, a process-local `OPENCODE_CONFIG_CONTENT` primary agent used **`prompt`**, then ACP `session/set_mode` selected it. The role/tool probe returned `ROLE_PROBE_OK` against conflicting `AGENTS.md`. Current v2 documentation may describe a different config shape; do not substitute it without version discovery. Agent prompt and project context coexist; their measured conflict result is not a separate enforcement tier. Use tool authorization for organizational rights. A role revision requires selecting/rebuilding the primary agent deliberately; no generic `session/set_system_prompt` exists in the probe.

A session stdio MCP server exposed **`workjet_probe_probe_echo`** and actually executed it. The mailbox exchange exposed `workjet_probe_thread_read` and `workjet_probe_thread_send`; OpenCode read the exact Pi envelope and sent an acknowledged reply. The probe custom provider existed only in process environment and used models returned by the authenticated gateway and observed CTOX catalog.

Convert foreign history into attributed readable user context, then send native `/compact …` through `session/prompt`. The probe produced a native summary, loaded/replayed it, and recalled the marker afterward. `opencode export <id>` returned JSON with **`info` and `messages`**; `opencode import <owned-export.json>` exited 0, preserving that owned session ID. This proves the native format/roundtrip, not a universal importer for Claude/Codex JSONL. A converter still has to preserve OpenCode's IDs, parts and message schema or use the readable-context route.

`session/set_config_option` with `configId: model` changed between two live-listed GLM models. Subsequent inference and `session/load` retained the same native session and `HISTORY_PROBE_42`. The model option's provider-qualified value is an OpenCode routing key; validate the underlying model ID against the holding account, then construct that key.

**Implement:** ACP role/mode + MCP adapter; Workjet owns the durable goal, checks conditions after each completed prompt, and queues at most one follow-up. Prefer the existing native server adapter if already selected by Workjet; expose the same semantics rather than adding a parallel loop. Await compaction's summary/update and persist the canonical history independently.

## MiniMax Code adapter specification

**Evidence:** [minimax-version.json](harness-probe-evidence-20261009/minimax-version.json), [minimax-help.json](harness-probe-evidence-20261009/minimax-help.json), [existing release pin](../../apps/server/src/provider/minimax/MiniMaxProtocol.ts), [driver](../../apps/server/src/provider/Drivers/MiniMaxDriver.ts). `mcode` failed with ENOENT. The installed desktop connector utility's auth/upload commands do not prove any of the six harness capabilities.

The current Workjet integration pins **`@minimax-ai/code@0.6.2`**, runs `mcode acp`, and configures HTTP MCP through session setup. It provides managed-instruction/imported-history context and advertised native load/model configuration handling. These are source findings, not live MiniMax results. No native goal lifecycle, higher-priority system extension, foreign import, compaction/export or distinct switch can be accepted from this Mac yet.

**Implement after install:** initialize/version-gate ACP, test the exact prompt-extension mechanism and tool names, bind scoped mailbox tools, and let Workjet own persistent goals unless an actual native lifecycle is discovered. Import readable foreign context only as a fallback explicitly labeled user context; wait for advertised native compaction or report unsupported. Use live account model choices, not provider defaults guessed from product names.

**Owner action:** Settings → Harnesses / the pinned MiniMax driver installation, under the shared admission gate; authenticate the agent CLI's own profile if requested. The [official MiniMax repository](https://github.com/MiniMax-AI/minimax-code) identifies the agent separately from the desktop connector. No dependency installation or secret migration was performed for this research.

## Greppy adapter specification

**Evidence:** [greppy-live.json](harness-probe-evidence-20261009/greppy-live.json), [greppy-switch.json](harness-probe-evidence-20261009/greppy-switch.json), [installed help](harness-probe-evidence-20261009/greppy-help.json), [current ACP support](../../apps/server/src/provider/acp/GreppyAcpSupport.ts). Command: `greppy agent stdio --max-turns 4`; script: `greppy_probe.py`. Authentication stayed in `GREPPY_ENDPOINT`, `GREPPY_API_KEY`, `GREPPY_MODEL`; ACP itself does not accept the secret.

The agent has a bounded assistant/tool loop (turn/deadline limits), persistence and resume. That is not a durable Workjet goal lifecycle. Its one-shot proposal is a Git ref, not an automatically opened PR. Workjet must continue the goal, verify conditions, create the one PR and archive the worker. No system-level setter was advertised or proved: managed role text remains user context, with no guaranteed priority over project instructions. Do not advertise it as a high-priority system extension.

Initialize advertised `_meta.workjetImportHistory.version: 1`, load/resume/list/close and **MCP HTTP/SSE false**. A nonempty stdio `mcpServers` request failed -32602: `MCP servers are not supported; send an empty mcpServers array`. The existing adapter's empty array is intentional. Arbitrary injected Workjet function tools need a Greppy bridge; ACP transport alone does not supply it. A constrained terminal wrapper can prove transport, but is not equivalent to native tool injection and must not widen source identity or grant arbitrary mailbox access.

`_workjet/import_history` accepted `{id, role, text}` user/assistant records and returned the exact `acceptedMessageIds`. The model recalled `HISTORY_PROBE_42`, and `session/load` replayed the imported records. Sending `/compact` through ACP **invoked the model as ordinary text**; original history remained. A generated summary is not native compaction. Interactive `/compact` may exist, but a successful ACP compaction route/export API was not proved. Export the canonical/replayed records through Workjet; retain the native session only as executor evidence. Don't invent a numeric import-size limit: large-history admission/chunking still needs a dedicated bounded test.

`session/set_model` changed between two authenticated, live-observed GLM selections in the same session; load returned the new selection and a subsequent answer retained the marker. This proves local-gateway switching, not secret transfer or cross-provider entitlement.

**Implement:** existing ACP import/resume/model adapter, Workjet-owned loop, explicit managed-context limitation, and a new scoped native function-tool bridge. Until that bridge and native compact support exist, surface the missing capabilities rather than silently treating text summaries or built-in shell access as passes.

## Pi adapter specification

**Evidence:** [pi-live.json](harness-probe-evidence-20261009/pi-live.json), [pi-history-isolated.json](harness-probe-evidence-20261009/pi-history-isolated.json), [initial timeout](harness-probe-evidence-20261009/pi-history.json), [cross-harness-summary.json](harness-probe-evidence-20261009/cross-harness-summary.json). Commands: `pi --mode rpc` with explicit probe extension, or `--session <converted.jsonl>`; scripts: `pi_probe.py`, `pi_history_probe.py`, `pi-mailbox-extension.ts`. Installed package docs are version-matched: `docs/rpc.md`, `extensions.md`, `session-format.md`, `settings.md`, `usage.md`.

`get_goal` returned unknown command. RPC `follow_up` and extension turn/end hooks are suitable for a Workjet-owned condition loop; this probe does not claim a Pi-native durable goal. **`agent_end` with `willRetry: true` is not final completion**. Drain retries/tools and check the condition before continuing. Do not start both an extension continuation and a Workjet continuation for the same thread.

The extension's `before_agent_start` appended the role to the existing system text per turn. Its hook recorded that conflicting project instructions were loaded; the actual tool/reply result was `ROLE_PROBE_OK`. This is later text in the same system prompt, not a separate higher-priority channel. `--append-system-prompt` and replacement flags are also exposed; preserve the default prompt for ordinary roles.

Native `registerTool` accepts schema/function bindings; `probe_echo` executed without MCP or a prefix. The mailbox extension registered unprefixed `thread_send`/`thread_read`, sent a production-acknowledged envelope and read OpenCode's matching reply. Core Pi MCP support is not assumed: reuse a native extension bridge.

Readable foreign records were converted into **v3 session JSONL**: session header, linked `type: message` entries (`id`, `parentId`, timestamp), user-context text with source attribution. This avoids forged foreign assistant signatures/tool calls. Pi loaded five imported records. With probe-only `keepRecentTokens: 128` and `reserveTokens: 1024`, native `compact` returned a summary/first-kept entry; `get_messages` showed `compactionSummary`, the switched model recalled the marker, and `export_html` succeeded. Default settings keep substantially more recent context, so the original tiny session returned `Nothing to compact`; a separate attempt timed out. These limits remain in the receipts. Numerical context/token estimates are harness estimates, not Workjet acceptance metrics.

`set_model` selected a second model present in authenticated Z.ai `/models`; `get_state` kept the same session ID and inference retained the marker. **The setter also persists the default model in the profile.** An early probe changed the global default; it was conditionally restored to the initial measured setting. The final probe uses a disposable `PI_CODING_AGENT_DIR`, and verified that the real profile stayed at its original default. Workjet must isolate this profile for per-thread switching.

**Implement:** native RPC plus one Workjet extension for role compilation, scoped tools and events. Workjet owns the loop, canonical transcript and authority. Use per-executor profile isolation, converted JSONL plus native compact, and safe-boundary model changes. Pi is not an installed Workjet provider adapter in this proof; the exchange's Pi executor was externally bound to its persisted Workjet thread.

## Cross-harness communication and deep links

[Derived proof](harness-probe-evidence-20261009/cross-harness-summary.json) has `pass: true` from matching native tool receipts and envelope IDs, not assistant claims. Server: installed Workjet **0.0.70**, disposable loopback profile. Thread A `febaac4c-27d6-49ca-8897-82be01a2a7cb` ran Pi 0.80.2; thread B `2c46b7cd-520f-4d1e-9edb-7301ecc91373` ran OpenCode 1.18.35. Both were created through normal orchestration API commands. The source-bound facade allowed only these two IDs.

1. Pi `thread_send` sent `MAILBOX_NATIVE_A`; `workjet.mailbox.sendMessage` returned acknowledged envelope `wjm-4da6fd9e-481b-4a79-b406-117fac27c2ee`.
2. OpenCode `workjet_probe_thread_read` read that same envelope/body, then `workjet_probe_thread_send` replied with `MAILBOX_NATIVE_B`, acknowledged as `wjm-0c056aa4-e903-45f6-baaa-819f46a6bdca`.
3. Pi `thread_read` read that exact reply envelope/body and ended with `RECEIVED_B`.

**Scope:** sends use production authenticated WebSocket RPC; native session/tool injection is real. The read side is a **probe-only, source-filtered read-only query of the disposable inbox database**, because the existing transcript HTTP endpoint exposes redacted activity, not message bodies. This is not a production `thread.read` endpoint, an installed Pi adapter, cross-machine routing, UI acceptance or a migrated three-role authorization policy. The first attempt's Pi timeout and disposable-server bootstrap error are retained as failures.

The production facade should use `thread.send`/`thread.read` semantics, backed by existing durable mailbox envelopes and authorized server reads. Source workspace/environment/thread identity must derive from the invocation; the model supplies only the target and bounded body. Current mailbox rights are orchestrator-scoped; replace that policy deliberately for supervisor/persistent/one-shot roles, with parent/commissioning and read-scope checks. Inline messages are bounded to 4096 characters; do not put whole transcripts into mailbox messages. Remote transport must retain its sealed payload, delivery and permission semantics.

| Binding | Measured exposed name | Consequence |
|---|---|---|
| Claude stdio MCP | `mcp__workjet_probe__probe_echo` | SDK tools include server prefix; discover per session. |
| Grok ACP MCP | `workjet_probe__probe_echo` | Double underscore, no Claude `mcp__` prefix. |
| OpenCode ACP MCP | `workjet_probe_probe_echo` | Single underscore; mailbox names use the same mapping. |
| Codex dynamic tool | `probe_echo` | Client handles native function invocation directly. |
| Pi extension | `probe_echo`, `thread_send`, `thread_read` | Registered names remain native names. |
| OAuth connector gateway | `mcp__<connector-id>__<tool>` (commissioned gateway convention) | Connector IDs/remaps can differ from local server IDs; production OAuth remap was not exercised here. |

Discover and map names from the actual tool catalog/initialization; retain canonical capability IDs separately. Never infer authority from a prefix or trust a caller-supplied source ID.

The [current desktop parser](../../apps/desktop/src/app/DesktopDeepLink.ts) accepts the app host and normalizes **`workjet://app/threads/<environment-id>/<thread-id>`** to the renderer's `/<environment-id>/<thread-id>` route. **`workjet://thread/<id>` is not that route:** its host is `thread`, which the parser rejects. Implement the proposed compact link as an explicit stable-ID resolver with environment lookup, or emit the current fully addressed route. Preserve the OS-link confirmation behavior in [DesktopDeepLinkRouter](../../apps/desktop/src/app/DesktopDeepLinkRouter.ts). A direct source-module execution lacked this clone's `effect` dependency; no dependency install or UI link click was performed, so this route finding is source evidence, not live UI acceptance.

## Common execution contract for the Harness parent

Store objective, role, author/revision, condition, state and last verified receipt durably in Workjet. A native end-turn, assistant “done”, summary, goal-state claim or transport ACK is insufficient alone to verify a product objective. One driver owns continuation: after tools and final events drain, check the condition, then enqueue at most one next turn if still active. Stop on verified completion, explicit owner stop/pause or permanent failure; owned dependencies have one wake-up. Resource waits retain the goal. Fixed-interval supervisors use durable schedules; one-shot workers additionally own worktree → exactly one PR → terminal disposition → archive.

Compile the role using each harness's proven mechanism, fingerprint it and reapply it after compaction/resume/executor replacement. Keep project context; report when a harness only supports user-context instructions. Enforce actual rights at the tool boundary, including merge/commissioning rules. A prompt's apparent priority is not a permission system.

For harness/model/computer moves, checkpoint the canonical transcript and goal at a safe boundary, drain tools, convert bounded foreign context, invoke supported native compaction and wait for the real completion event, then resume work under the same Workjet thread ID. Never fabricate native signed assistant data. Keep full history in Workjet; provider context is replaceable. Large-history and computer-move stress limits were not tested by these small probes.

Live model choices require a fresh account list on the holding node. Filter CLI menus against that list; verify the chosen model after the switch and classify model-specific errors without poisoning the whole provider account. This research proved local same-session changes for OpenCode, Greppy and Pi; it did not prove credential federation or active-stream mid-token swaps. “At any time” should enqueue a switch safely, not mutate an in-flight tool/stream without a checkpoint.

## Follow-up acceptance and lifecycle

The Harness parent can implement the specifications above without treating this research as another release gate. Outstanding acceptance: Claude login-dependent checks; MiniMax installation and all six probes; Codex/Grok distinct switches after live entitlement validation; Greppy native system/tool/compaction bridges; production authorized `thread.read`, three-role policy, compact deep-link resolver and installed UI/computer-move acceptance. These gaps are owned integration work, not fabricated passes.

No build, dependency install, browser or computer-use session was launched. Initial capacity was system 21.47 GiB free, tmp 31.81 GiB, load 75.31 on ten cores; another task held the heavy lease. Greppy graph indexing explicitly deferred with exit 75 and recommended bounded `read-file`/text recovery, which was used; this is an admission limitation, not a functional Greppy failure. Inference probes ran sequentially with bounded deadlines. The installed server used only disposable state, never the live Workjet database for writing.

All captured native children and disposable servers exited. Probe artifacts/private bootstrap credentials live only under the task's tmp directory and are removed at handoff. The real Pi model default was restored and verified; final Pi history testing used a disposable profile. Own tiny native session records may remain as inactive research history; native Codex goals were cleared. Source stays in this checkout and the accessible PR; **no merge or installed-product modification is authorized by this deliverable**.

## Primary references

- [Codex goals](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex) and [app-server](https://learn.chatgpt.com/docs/app-server), with the installed schema governing exact experimental fields.
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), supplemented by installed initialization/help.
- [Grok headless/ACP](https://docs.x.ai/build/cli/headless-scripting) and [official ACP source guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md), including session metadata and live config options.
- [OpenCode ACP](https://opencode.ai/v2/docs/cli/acp/); installed 1.18.35 probes take precedence over version-2 config examples.
- [MiniMax Code](https://github.com/MiniMax-AI/minimax-code); Workjet's source pin determines its install route.
- Pi's installed 0.80.2 package documentation listed in its adapter specification; Greppy's installed help/ACP responses and Workjet source.
