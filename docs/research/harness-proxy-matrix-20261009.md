# Harness × model through the Rust CLI proxy, 2026-10-09

## Scope and acceptance

Requested by Michael: every harness uses Workjet's Rust CLIProxyAPI gateway, with protocol translation and twenty successive successful tool calls per harness/model cell. Required minimum: Claude Code, Codex CLI, Grok CLI and OpenCode × Claude Opus 5.5, GPT Sol and Grok 4.7. A mocked transport regression is not a live harness/model acceptance result.

Work is in the durable clone `~/.local/state/workjet-launchpads/harness-proxy-fix`, based on Workjet `519aaba16528e4534dd948ac3e3cd184c099083b`. Branch: `codex/harness-proxy-fix-20261009`. The supervisor owns merges.

## Reproduced cause

At **2026-10-09 21:02:51 UTC**, the running **Workjet 0.0.69** gateway (`workjet-provider-gateway-host` PID 13131, provider listener `127.0.0.1:59770`) received a streaming `/v1/messages` request selecting the observed account model `claude-opus-5-5` and declaring the `Bash` tool. It returned HTTP 200 with tool name **`mcp__hfhpawo4h27q__an76t6lbpdjj_Bash`**, exactly matching the supervisor's installed-app failure. No tool was executed by this HTTP reproduction.

`native/provider-gateway/internal/runtime/executor/claude_executor_execute.rs:1127` drains **complete SSE frames**, including `event:` and `data:` lines, then passes the frame to `restore_claude_oauth_tool_names_from_stream_line`. The original `claude_executor_request.rs:854` implementation parses that argument as a single JSON/data line. An `event:` frame fails JSON parsing and is returned unchanged, so the OAuth-only alias leaks to the harness. A data-only frame loses its blank separator when a name is rewritten. Buffered Responses-to-Claude execution likewise receives SSE and previously used a JSON-only restoration function (`claude_executor_execute.rs:648`).

The generated server ID is derived from the upstream account's OAuth credential in `native/provider-gateway/internal/runtime/executor/helps/claude_mcp_alias.rs:28`; sharing the account explains the shared ID across harnesses. It is not a Workjet MCP server that needs registration.

## Repair and regression coverage

The repair rewrites individual data lines within complete frames, preserves LF/CRLF event delimiters and metadata lines, and restores buffered SSE before protocol translation. Existing JSON responses and request-local reverse mappings retain their behavior. No account settings, credentials, model defaults or supervisor execution configuration are changed by this repair.

Focused Rust regressions cover event-prefixed frames, data-only frames, LF/CRLF separators, unchanged non-tool events and opaque arguments, plus the actual account pool/provider executor with upstream fragments of seven bytes and twenty successive calls for each of `Bash`, `Read` and `exec_command`. The transport echoes the actual outbound alias. These are deterministic bridge tests, not real-model acceptance.

A further account-pinned HTTP probe found that Claude's adaptive `output_config.effort:"max"` is forwarded unchanged as Responses `reasoning.effort:"max"`. The actual Grok account rejects it with upstream HTTP 400; the converter's default `xhigh` and explicit `high` are accepted. The repair maps Claude `max` to Responses `xhigh` in `codex_claude_request.rs:438`, with a focused converter regression. [Sanitized HTTP evidence](harness-proxy-evidence/xai-protocol-probes-20261009.json) also records successful function-result string/array replay and ordinary streaming tool declarations. These probes execute no local tools and do not count as native matrix passes; the native Claude/Grok failure still needs a retest.

## Routing inventory

- Workjet's portable Rust gateway is `native/provider-gateway`; its environment host is `native/provider-gateway-workjet-host`. Desktop packaging pins host **0.1.1** at source `9b2c23c2d000c5f50715b3e0bb6ff9e4bf500dba`. A source fix requires a newly published host artifact and updated pin before a desktop release can contain it.
- CTOX uses the same CLIProxyAPI Rust port through `src/core/execution/cliproxyapi_host.rs`; this task makes no CTOX source changes.
- Claude Code and Codex already route inference through the Rust host using verified launch configuration and `X-CTOX-Provider`.
- Grok CLI, OpenCode and Greppy have gateway base-URL injection. PR #288 resolves headerless requests from the real account catalog, retains existing explicit routing, exposes original model IDs alongside existing reversible aliases, and adds the missing `/v1/chat/completions` bridge through the Rust protocol translators. Its final checks and live retests are pending.
- MiniMax Code originally rejects gateway routing explicitly. PR #296 supplies the native `mcode` custom-provider profile, verified against the published 0.6.2 package/help. Twenty profile/adapter tests pass; the final typecheck and native execution remain pending.
- Pi originally has no registered driver. PR #301 adds its native RPC driver, private catalog-backed gateway profiles, MCP tool bridge and UI registration. The bridge preserves the protocol version negotiated during MCP initialization. Final checks and native execution remain pending.
- OpenCode's generic base URL alone does not select its native provider/model configuration. PR #299 supplies a catalog-backed `@ai-sdk/openai` Responses provider through `OPENCODE_CONFIG_CONTENT`; final checks and live acceptance remain pending.
- PR #308 routes newly created supported harness instances through the gateway by default and exposes Greppy in provider settings. Existing saved instances retain their configuration.
- Remote worker dispatch is still Codex-only (`WorkerDispatch.ts`, `RemoteWorkerSourceOperationsLive.ts`, `RemoteWorkerReceiver.ts`). Additive [draft PR #318](https://github.com/metric-space-ai/workjet/pull/318) prepares source-authorized Messages and Chat Completions relay with unchanged legacy Responses behavior. Harness identity, remote adapters and native acceptance remain open; the dispatch guard has not been lifted.
- Keeping the model when switching a routed harness is intentional (`apps/web/src/modelSelection.ts:254`); correctness requires validating against the connected gateway catalog, not clamping to the harness vendor's model list.
- `per_turn_effort_changed` currently reaches ClaudeAdapter's unknown-system-subtype warning. This informational notice is separate from tool execution failure.

## Model observations

`GET http://127.0.0.1:59770/v1/models` exposed `claude-opus-5-5` and reversible protocol aliases whose display names include `gpt-6.1-sol`, `grok-4.7`, `glm-5.3-flash`, Kimi and MiniMax models. This endpoint is a configured gateway snapshot, not a fresh upstream model-list observation.

`GET https://llm.ctox.dev/catalog` succeeded with `checkedAt=2026-10-09T21:01:45.310Z`; its observed providers were Kimi, MiniMax and Z.ai. It did not include Anthropic/OpenAI/xAI. The account-backed live matrix must therefore discover or verify the three requested model IDs through their real connected accounts; public-catalog absence is not proof they are unavailable.

## Live acceptance matrix

**5 of 12 minimum cells accepted.** Counts below are real tool executions. Failed cells retain their observed errors; pending cells have not run.

| Harness               | claude-opus-5-5              | gpt-6.1-sol                | grok-4.7                   |
| --------------------- | ---------------------------- | -------------------------- | -------------------------- |
| Claude Code           | Pass, 20/20; continuation 20 | Pass, 20/20               | Pass, 20/20               |
| Codex CLI             | Pass, 20/20                  | Pass, 20/20                | Fail, 0/20; upstream 502   |
| Grok CLI / Grok Build | Fail, 4/20; dispatch timeout | Fail, 0/20; dispatch timeout | Fail, 0/20; dispatch timeout |
| OpenCode              | Pending, 0/20                | Pending, 0/20              | Pending, 0/20              |

The RC is an isolated Workjet 0.0.69 server running the locally compiled Rust host with the streaming repair and catalog-routing repair. It uses private copies of existing gateway credentials, separate native harness homes and an isolated database. The installed Workjet profile is not modified.

- Claude Code / Opus: Workjet thread `6de973a2-d74a-4615-9f92-a8887879abcc`; native session `b89c8298-142d-4344-aa04-cae5a118946d`. [Native proof](harness-proxy-evidence/claude-opus-20261009-native-tool-results.json) records all twenty ordered Bash results with `is_error:false`. Workjet's activity stream omitted the first completion receipt; native history supplies that result. Initial HTTP retries occurred before the first tool call.
- Codex / Opus: Workjet thread `24474850-7b7d-4cb8-97ce-480ac46a0756`; native session `01a122a3-a692-7ea0-aac2-d9ed99c6a534`. [Native proof](harness-proxy-evidence/codex-opus-20261009-native-tool-results.json) records twenty matching `exec_command` calls/results, ordered output markers and exit code zero for every command. Workjet emitted twenty completion receipts and returned to ready.

- Codex / GPT Sol: Workjet thread `a354b78d-18a7-4274-8a24-9a570e2eb747`; native session `01a122c5-609c-7ab1-87cd-e1f716fb5d3e`. [Native proof](harness-proxy-evidence/codex-gpt-sol-20261009-native-tool-results.json) records twenty sequential native `exec` calls, each invoking `exec_command` once, with matching results and exit code zero.
- Claude / GPT Sol: thread `a4232683-43e4-4123-bc96-0d55553ab491` completed one Bash call, then received `400 Codex upstream rejected the request`. The Anthropic-to-Responses translator (`codex_claude_request.rs:154`) replays `function_call.arguments` as a JSON object rather than JSON text. The proposed serialization repair adds a twenty-call history regression; live retest is pending.
- Codex / Grok: thread `7d6b8e01-943d-42cc-b932-96c757f00a09`; Claude / Grok: thread `3d25b692-8fd1-43d3-83e9-223d051eff37`. Both received `502 xAI upstream rejected the request` before a tool execution. A subsequent account-pinned live diagnostic returned 200 for minimal requests, Codex request fields and an ordinary function tool, but upstream 422 for a Responses custom tool. PR #307 supplies the missing custom-tool JSON wrapper, history conversion and stateful response restoration, including incremental SSE decoding. The healthy account does not require sign-in. Final regression and live retests remain pending.
- Grok / Opus: thread `0d25daec-61b6-407a-9ec7-8d129981dafe` returned ready without a tool execution. Grok / GPT Sol (`754f040f-525d-4a10-9c2b-0deea37bcf48`) and Grok / Grok (`fa31a656-26c6-43da-958d-c015006bc700`) fail session model selection with `Invalid params`. Grok's empty completion is consistent with the absent Chat Completions endpoint; its raw GPT/Grok model IDs were absent from the cloaked gateway catalog. PR #288 addresses both gaps; live retests remain pending.

On 2026-10-10 the native host was rebuilt from composed source `1be5e3a13` (SHA256 `f61b03f793f4bd512b50c8e11cadd01ec3f6d0deb255b066a5eb37c7c75e68be`). The isolated server still uses installed 0.0.69 JavaScript, whose source revision is unverified. The previously passing Opus native conversation resumed after normal server shutdown/restart and completed another [twenty matched Bash calls](harness-proxy-evidence/claude-opus-continuation-20261010-native-tool-results.json). Fresh Claude Code threads now pass [GPT Sol, twenty calls](harness-proxy-evidence/claude-gpt-sol-20261010-native-tool-results.json) and [Grok 4.7, twenty calls](harness-proxy-evidence/claude-grok-20261010-native-tool-results.json). Each proof checks twenty interleaved native calls/results, exact output markers and no tool errors. This confirms the argument serialization and effort repair in the real CLI. Other failed/pending cells retain their last measurements until rerun.

Additional required harnesses: MiniMax Code, Greppy and Pi remain open. The installed supervisor's measured failures are retained above; no matrix cell is inferred green from the bridge regressions.

The 2026-10-10 retest reproduced Grok's current failure as Workjet's 30-second `processTurnStartRequested` dispatch timeout: Opus executed four tools before cancellation, while the GPT and Grok turns timed out with none. [Draft PR #319](https://github.com/metric-space-ai/workjet/pull/319) makes routed ACP prompts return their dispatch receipt before the existing scoped turn task finishes. Its controlled approval-held regression and native retest await the new JavaScript bundle.

The actual Codex/Grok launch request contains standard functions and namespaces, rather than the custom tool used by the earlier HTTP probe. [Account-pinned ablation](harness-proxy-evidence/codex-xai-actual-tools-ablation-20261010.json) accepts its native shell function (HTTP 200) but rejects the complete declaration and online web-search option (upstream 400). The Workjet Collective guide declares an object-or-array parameter union; xAI requires an object envelope. A [second probe](harness-proxy-evidence/codex-xai-tool-shape-20261010.json) accepts the complete actual declaration after wrapping that schema and translating online web search to its native form. PR #307 now preserves original argument values across buffered/fragmented responses and history replay, and records namespace mappings from declarations instead of splitting names such as `mcp__workjet`. The translation is in `xai_executor_request.rs:422`, the declared namespace map in `xai_executor_request.rs:601`, and response decoding in `xai_custom_tools.rs:12`. Twenty-call regressions include array/object values and namespace restoration. HTTP probes execute no local tools; the Codex/Grok matrix cell remains failed pending a rebuilt-host retest.

## Verification and delivery record

- Installed gateway reproduction: exact leaked Bash alias, HTTP 200.
- Linux regression lane `workjet-harness-proxy-fix-20261009`: new complete-frame and buffered-SSE tests fail on the old implementation; the repaired implementation passes all 88 Claude executor tests. Catalog-routing tests pass 4/4. Managed two-job lane receipts are saved under `/Volumes/tmp/dev-artifacts/build-lane/`; key run IDs: `20261009T210127Z` (red), `20261009T212037Z` (88 executor tests pass, followed by a routing assertion failure; overall exit 101), `20261009T212343Z` (corrected routing, exit 0). The converter run `20261009T223041Z` passes 10/10, including the twenty-call argument-history regression; the later maximum-effort regression remains pending. Receipts and full logs are also preserved durably in `~/.codex/task-evidence/harness-proxy/receipts/`.
- Mac RC host: full TLS build passes through `dev-heavy-run.py`, task `harness-proxy-rc-20261009`. Live matrix cells likewise run through the shared Mac gate.
- Streaming repair: [PR #287](https://github.com/metric-space-ai/workjet/pull/287). Headerless catalog routing: [PR #288](https://github.com/metric-space-ai/workjet/pull/288). Informational effort notice: [PR #289](https://github.com/metric-space-ai/workjet/pull/289), 79 ClaudeAdapter tests plus targeted lint/format pass. MiniMax's isolated native gateway profile is in [draft PR #296](https://github.com/metric-space-ai/workjet/pull/296), with native validation still open. OpenCode catalog profiles are in [draft PR #299](https://github.com/metric-space-ai/workjet/pull/299), and Pi RPC/MCP support is in [draft PR #301](https://github.com/metric-space-ai/workjet/pull/301); both need final checks and native validation.
- xAI custom-tool translation: [draft PR #307](https://github.com/metric-space-ai/workjet/pull/307). New-instance gateway defaults and Greppy settings: [draft PR #308](https://github.com/metric-space-ai/workjet/pull/308). A composed RC branch contains the proposed changes; it is a test source, not a release.
- Final Linux checks are queued through the shared build lane. The next Mac RC build needs the shared lease; the first build of the combined routing changes found a private-constructor visibility error, now corrected in #288. No live cell is counted against that unbuilt revision.
- The standalone Mac CI job fails on the unchanged base release pipeline with `Mac packaging requires --gpu-build-owner <thread-id>`. Workjet Main has the exact run/job/source handoff. The guard has not been bypassed.
- MiniMax account health reports exhausted weekly quota. This is an owner action for MiniMax-provider acceptance, and does not prevent testing MiniMax Code with another connected provider.
- Source preserved on the pushed PR branches. No merge or live install is performed by this thread.
