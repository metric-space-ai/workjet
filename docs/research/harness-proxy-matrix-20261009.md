# Harness × model through the Rust CLI proxy, 2026-10-09

## Scope and acceptance

Requested by Michael: every harness uses Workjet's Rust CLIProxyAPI gateway, with protocol translation and twenty successive successful tool calls per harness/model cell. Required minimum: Claude Code, Codex CLI, Grok CLI and OpenCode × Claude Opus 5.5, GPT Sol and Grok 4.7. A mocked transport regression is not a live harness/model acceptance result.

Work is in the durable clone `~/.local/state/workjet-launchpads/harness-proxy-fix`, based on Workjet `519aaba16528e4534dd948ac3e3cd184c099083b`. Branch: `codex/harness-proxy-fix-20261009`. The supervisor owns merges.

## Reproduced cause

At **2026-10-09 21:02:51 UTC**, the running **Workjet 0.0.69** gateway (`workjet-provider-gateway-host` PID 13131, provider listener `127.0.0.1:59770`) received a streaming `/v1/messages` request selecting the observed account model `claude-opus-5-5` and declaring the `Bash` tool. It returned HTTP 200 with tool name **`mcp__hfhpawo4h27q__an76t6lbpdjj_Bash`**, exactly matching the supervisor's installed-app failure. No tool was executed by this HTTP reproduction.

`native/provider-gateway/internal/runtime/executor/claude_executor_execute.rs:1127` drains **complete SSE frames**, including `event:` and `data:` lines, then passes the frame to `restore_claude_oauth_tool_names_from_stream_line`. The original `claude_executor_request.rs:854` implementation parses that argument as a single JSON/data line. An `event:` frame fails JSON parsing and is returned unchanged, so the OAuth-only alias leaks to the harness. A data-only frame loses its blank separator when a name is rewritten. Buffered Responses-to-Claude execution likewise receives SSE and previously used a JSON-only restoration function (`claude_executor_execute.rs:648`).

The generated server ID is derived from the upstream account's OAuth credential in `helps/claude_mcp_alias.rs:28`; sharing the account explains the shared ID across harnesses. It is not a Workjet MCP server that needs registration.

## Repair and regression coverage

The repair rewrites individual data lines within complete frames, preserves LF/CRLF event delimiters and metadata lines, and restores buffered SSE before protocol translation. Existing JSON responses and request-local reverse mappings retain their behavior. No account settings, credentials, model defaults or supervisor execution configuration are changed by this repair.

Focused Rust regressions cover event-prefixed frames, data-only frames, LF/CRLF separators, unchanged non-tool events and opaque arguments, plus the actual account pool/provider executor with upstream fragments of seven bytes and twenty successive calls for each of `Bash`, `Read` and `exec_command`. The transport echoes the actual outbound alias. These are deterministic bridge tests, not real-model acceptance.

## Routing inventory

- Workjet's portable Rust gateway is `native/provider-gateway`; its environment host is `native/provider-gateway-workjet-host`. Desktop packaging pins host **0.1.1** at source `9b2c23c2d000c5f50715b3e0bb6ff9e4bf500dba`. A source fix requires a newly published host artifact and updated pin before a desktop release can contain it.
- CTOX uses the same CLIProxyAPI Rust port through `src/core/execution/cliproxyapi_host.rs`; this task makes no CTOX source changes.
- Claude Code and Codex already route inference through the Rust host using verified launch configuration and `X-CTOX-Provider`.
- Grok CLI, OpenCode and Greppy have verified gateway base-URL injection but no provider selector in the current overlay. The gateway defaults to one provider without that header. This is a separate cross-provider routing gap.
- MiniMax Code currently rejects gateway routing explicitly (`MiniMaxDriver.ts` / `MiniMaxProvider.ts`). It needs a verified native profile/config seam.
- Pi has no registered Workjet harness driver in this revision. Adding a Pi driver is distinct from repairing protocol translation.
- Keeping the model when switching a routed harness is intentional (`apps/web/src/modelSelection.ts:254`); correctness requires validating against the connected gateway catalog, not clamping to the harness vendor's model list.
- `per_turn_effort_changed` currently reaches ClaudeAdapter's unknown-system-subtype warning. This informational notice is separate from tool execution failure.

## Model observations

`GET http://127.0.0.1:59770/v1/models` exposed `claude-opus-5-5` and reversible protocol aliases whose display names include `gpt-6.1-sol`, `grok-4.7`, `glm-5.3-flash`, Kimi and MiniMax models. This endpoint is a configured gateway snapshot, not a fresh upstream model-list observation.

`GET https://llm.ctox.dev/catalog` succeeded with `checkedAt=2026-10-09T21:01:45.310Z`; its observed providers were Kimi, MiniMax and Z.ai. It did not include Anthropic/OpenAI/xAI. The account-backed live matrix must therefore discover or verify the three requested model IDs through their real connected accounts; public-catalog absence is not proof they are unavailable.

## Live acceptance matrix

**Not yet accepted.** Counts below are successful tool executions in a real Workjet installed/RC harness, not mocked requests. Zero means unrun, not a tested product failure.

| Harness | claude-opus-5-5 | gpt-6.1-sol | grok-4.7 |
| --- | --- | --- | --- |
| Claude Code | Pending, 0/20 | Pending, 0/20 | Pending, 0/20 |
| Codex CLI | Pending, 0/20 | Pending, 0/20 | Pending, 0/20 |
| Grok CLI / Grok Build | Pending, 0/20 | Pending, 0/20 | Pending, 0/20 |
| OpenCode | Pending, 0/20 | Pending, 0/20 | Pending, 0/20 |

Additional required harnesses: MiniMax Code, Greppy and Pi remain open. The installed supervisor's measured failures are retained above; no matrix cell is inferred green from the bridge regressions.

## Verification and delivery record

- Installed gateway reproduction: exact leaked Bash alias, HTTP 200.
- Linux regression lane: `workjet-harness-proxy-fix-20261009`, two jobs, managed by `gpu-build-run.sh`; red/green results to be recorded after completion.
- Source preserved on the pushed branch. No merge or live install is performed by this thread.
