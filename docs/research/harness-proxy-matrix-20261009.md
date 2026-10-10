# Harness × model through the Rust CLI proxy, 2026-10-09

## Result and scope

**9/12 minimum live cells pass** as of 2026-10-10 02:45 UTC. Claude Code, Codex CLI and Grok CLI / Grok Build each execute twenty strictly sequential native tools with Claude Opus, GPT Sol and Grok. OpenCode's three cells are running next. Additional Greppy, MiniMax Code, Pi and universal remote worker acceptance remain open.

Michael requested every harness through Workjet's existing Rust CLIProxyAPI, using models from real connected accounts. Work is confined to the durable `~/.local/state/workjet-launchpads/harness-proxy-fix` clone, based on `519aaba16528e4534dd948ac3e3cd184c099083b`. The supervisor merges; this thread has made no merge or installed-app replacement.

## Causes and repairs

At 2026-10-09 21:02:51 UTC, installed Workjet 0.0.69 returned HTTP 200 from its real gateway with tool name `mcp__hfhpawo4h27q__an76t6lbpdjj_Bash`, exactly reproducing the observed failure without executing a tool.

`native/provider-gateway/internal/runtime/executor/claude_executor_execute.rs:1127` drains complete SSE frames, then calls a helper whose original implementation in `claude_executor_request.rs:854` expects one JSON/data line. An event-prefixed frame is returned unchanged; the OAuth alias leaks to the harness. Rewriting a data-only frame also loses its event separator. The account-derived server ID in `helps/claude_mcp_alias.rs:28` explains its recurrence across harnesses. It is not a missing Workjet MCP server registration.

[PR #287](https://github.com/metric-space-ai/workjet/pull/287) rewrites individual data lines within complete frames, preserves LF/CRLF boundaries and restores buffered SSE before translation. It also serializes Responses function-call arguments as JSON text during Claude history replay and maps Claude adaptive `max` effort to Responses `xhigh`, accepted by the real Grok account. Deterministic executor tests exercise twenty fragmented calls each for Bash, Read and exec_command. These bridge tests are separate from live matrix acceptance.

The actual Codex/Grok request exposed further xAI incompatibilities. The Workjet guide uses an object-or-array schema; xAI requires an object envelope. Its native web-search declaration differs from Codex's online option. Replay contains optional `reasoning.content:null`, rejected with upstream 400. [PR #307](https://github.com/metric-space-ai/workjet/pull/307) supplies reversible tool argument wrapping, exact declared namespace restoration and omission of only that null field, preserving encrypted reasoning and IDs. Evidence: [actual declaration ablation](harness-proxy-evidence/codex-xai-actual-tools-ablation-20261010.json), [tool shape probe](harness-proxy-evidence/codex-xai-tool-shape-20261010.json), [replay ablation](harness-proxy-evidence/codex-xai-replay-ablation-20261010.json). The native twenty-call Codex/Grok retest passes.

Grok's ACP prompt returns when the whole turn finishes, while Workjet requires its dispatch receipt within thirty seconds. Routed Grok, Greppy and MiniMax now use an optional scoped background prompt path in [PR #319](https://github.com/metric-space-ai/workjet/pull/319). Cancellation, overlap protection and terminal events retain their behavior. The Grok path is loaded in the tested candidate; the newer Greppy/MiniMax changes await their bundle and final regressions.

Greppy's native second request contains an empty assistant text block. An account-pinned replay returns upstream 400, `messages: text content blocks must be non-empty`. Removing only that block returns 200: [sanitized ablation](harness-proxy-evidence/greppy-empty-text-ablation-20261010.json). [PR #325](https://github.com/metric-space-ai/workjet/pull/325) removes only empty text, including when a live model lacks static metadata, while preserving opaque thinking, tool inputs, IDs and results. Five regressions pass, including twenty growing histories through the actual preparation path with absent metadata. The [unchanged captured native request](harness-proxy-evidence/greppy-patched-replay-20261010.json) now returns upstream 200 and a complete correctly named tool stream. [PR #328](https://github.com/metric-space-ai/workjet/pull/328) preserves upstream rejection before committing SSE; its real TCP regression and a [live negative replay](harness-proxy-evidence/claude-stream-rejection-20261010.json) return the real 400 instead of HTTP 200 with an empty stream.

The Claude `per_turn_effort_changed` notice is informational. [PR #289](https://github.com/metric-space-ai/workjet/pull/289) handles it without a red unknown-system warning; it is separate from tool-name leakage.

## Configuration and delivery slices

Workjet uses `native/provider-gateway` and `native/provider-gateway-workjet-host`. CTOX uses the same Rust port through `src/core/execution/cliproxyapi_host.rs`; this task changes no CTOX source. Desktop's pinned host artifact must be republished and its pin updated before these Rust fixes can ship.

- [#288](https://github.com/metric-space-ai/workjet/pull/288): resolve headerless native requests from the connected catalog, expose original model IDs, bridge Chat Completions through existing translators.
- [#296](https://github.com/metric-space-ai/workjet/pull/296): isolated official MiniMax Code custom-provider profile. Actual `@minimax-ai/code@0.6.2` is installed for native acceptance.
- [#299](https://github.com/metric-space-ai/workjet/pull/299): catalog-backed OpenCode native provider/model profiles through `OPENCODE_CONFIG_CONTENT`.
- [#301](https://github.com/metric-space-ai/workjet/pull/301): Pi native RPC driver, private catalog-backed models and MCP extension.
- [#308](https://github.com/metric-space-ai/workjet/pull/308): gateway routing defaults for new supported instances and Greppy settings. Existing saved choices are preserved.
- [#313](https://github.com/metric-space-ai/workjet/pull/313): account-model read RPC authorization repair discovered in inherited CI.
- [#315](https://github.com/metric-space-ai/workjet/pull/315): route metadata generation through the selected gateway model.
- [#318](https://github.com/metric-space-ai/workjet/pull/318): additive source-authorized native protocol relay. Remote harness identity, target adapters and native acceptance remain open; Codex-only dispatch guards are retained.

Keeping a connected model when switching routed harnesses is intentional (`apps/web/src/modelSelection.ts:254`). The connected gateway catalog determines compatibility. The test profile explicitly enables gateway routing on each native instance; legacy saved choices do not change automatically.

## Live matrix and evidence

| Harness | claude-opus-5-5 | gpt-6.1-sol | grok-4.7 |
| --- | --- | --- | --- |
| Claude Code | Pass 20/20; restart continuation 20/20 | Pass 20/20 | Pass 20/20 |
| Codex CLI | Pass 20/20 | Pass 20/20 | Pass 20/20 |
| Grok CLI / Grok Build | Pass 20/20 | Pass 20/20 | Pass 20/20 |
| OpenCode | Pass 20/20 | Pass 20/20 | Running |

The evidence checks actual native calls and matching results, strict sequential execution, exact numbered printf output, success status and no tool errors. Every harness uses the real account-backed Rust host. No HTTP-only or mocked result counts as a live cell.

- Claude: [Opus](harness-proxy-evidence/claude-opus-20261009-native-tool-results.json), [restart continuation](harness-proxy-evidence/claude-opus-continuation-20261010-native-tool-results.json), [GPT](harness-proxy-evidence/claude-gpt-sol-20261010-native-tool-results.json), [Grok](harness-proxy-evidence/claude-grok-20261010-native-tool-results.json). The first Opus Workjet completion receipt was missing; its native history supplies that result.
- Codex: [Opus](harness-proxy-evidence/codex-opus-20261009-native-tool-results.json), [GPT](harness-proxy-evidence/codex-gpt-sol-20261009-native-tool-results.json), [Grok](harness-proxy-evidence/codex-grok-20261010-native-tool-results.json).
- Grok: [Opus](harness-proxy-evidence/grok-opus-20261010-native-tool-results.json), [GPT](harness-proxy-evidence/grok-gpt-sol-20261010-native-tool-results.json), [Grok](harness-proxy-evidence/grok-grok-20261010-native-tool-results.json). Each proof matches twenty native ACP calls/results to twenty Workjet receipts.

The isolated RC has its own database and native harness homes. Private credential copies remain within its disposable profile. The installed user profile is untouched. Each proof records actual Rust and JavaScript source heads separately. The latest Grok candidate uses Rust source `7b4415a00`, binary SHA256 `7bd4f46f7c62a4ce0150ffb542dc7744ccadf7c67d40d8d04d77ccc4ce674add`; JavaScript source `6b17cd3b3f6d354829db9cba7e890641c7b7bf88`, entry SHA256 `d45cc88e4bb796d232563c4a325c1d67864d9f8b022d6dcc26d8b6efa55fea7c`. Its macOS native runtime dependencies are reused read-only from installed 0.0.69.

## Checks and remaining owner actions

Linux checks run through the shared gpu3 build lane, two workers. The composed candidate passes server/web typechecks, forty focused tests and server/web bundles (run `20261010T021624Z`, clean `6b17cd3b3`). An earlier composed run passes 258 tests in 23 files. The original streaming repair passes 88 executor tests; routing passes 4/4; converter passes 10/10; informational effort handling passes 79 adapter tests plus targeted format/lint. The final native run (20261010T022110Z, clean 916102115) passes 100 xAI tests, six converter tests including maximum effort and twenty-call history, and ten Claude executor tests. New ACP, Pi, OpenCode child-environment and empty-text regressions remain queued. Receipts and logs are preserved durably in `~/.codex/task-evidence/harness-proxy/receipts/`.

The inherited Mac packaging CI failure is `Mac packaging requires --gpu-build-owner <thread-id>`; Workjet Main owns its repair. The guard is preserved. No PR is claimed CI-green while that required job fails.

Greppy 0.4.1's ACP agent rejects every nonempty `mcpServers` list with -32602, despite advertised stdio MCP support. Its upstream owner has the immutable report; Workjet's managed-MCP guard remains. Native Greppy tool-loop acceptance awaits the patched host. MiniMax Code and Pi native acceptance and the integrated UI pass remain open. A fresh [MiniMax probe](harness-proxy-evidence/minimax-live-capacity-20261010.json) returns 503, no API-key account currently available; it does not establish a current quota error. Its owner must restore account availability. Actual live-list models [GLM](harness-proxy-evidence/zai-live-capacity-20261010.json) and [Kimi](harness-proxy-evidence/kimi-live-capacity-20261010.json) both return upstream 200 with model output.

The supervisor owns merges and coordinated publication/pinning/installation. This task preserves the Monday supervisor execution path through optional/additive changes, private profiles and no installed-profile edits.
