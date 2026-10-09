# Harness compendium — 9 October 2026

Owner: Michael. Commission: Workjet supervisor. Research checkout: `harness-compendium`, base `e15cb09d9`.
Initial matrix recorded at 21:51 UTC. This is an evidence ledger and adapter proposal, not installed-product acceptance.

The organisational principle, thread-move concept and three role drafts were read before probing. Workjet owns the transcript, goal, loop, identity and workspace. A native harness session is replaceable execution state. A normal turn ending is **not** goal completion.

## Evidence notation and inventory

**LIVE** means a request reached the installed CLI and a response was measured. **HELP** means a flag or command exists in installed CLI help, without an execution claim. **DOC** means upstream documents it. **OPEN** means the next probe is still required. **MISSING** means the required executable is absent. A rejected guessed extension is not proof that no equivalent feature exists.

Receipts are in [harness-probe-evidence-20261009](harness-probe-evidence-20261009/). Scripts are in [scripts/harness-probes](../../scripts/harness-probes/). Each receipt records command, time, response/error and owned-process cleanup. Probe credentials are inherited privately; no login, global configuration edit, update or install is performed. All inference probes are tiny and run sequentially. Scratch data lives on `/Volumes/tmp`; no server opens live Workjet state for writing.

| Harness | Installed version | Executable / inventory finding |
|---|---|---|
| Claude Code | 2.1.296 | `claude` resolves to the native executable in the global npm package. |
| Codex CLI | 0.162.0-alpha.2 | Settings names `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`; executable exists. PATH `codex` is a broken symlink to an older app resource. |
| Grok CLI / Grok Build | 1.0.50, c58f321264ba | `grok` identifies itself as **Grok Build TUI**. Treat this as one installed harness; an unrelated npm Grok CLI is not interchangeable. |
| OpenCode | 1.18.35 | `opencode`, native executable in the global npm package. |
| MiniMax Code | CLI missing | `mcode` returns ENOENT. MiniMax Code.app is installed, but its `mcode-tools/cli.mjs` is a connector utility, not the coding-agent CLI. |
| Greppy | 0.4.1 | `greppy`, local development/recovery binary. |
| Pi | 0.80.2 | `pi`, `@earendil-works/pi-coding-agent/dist/cli.js`. |

## Capability matrix, first version

Each cell names the mechanism, measured evidence or its current limit, and the intended adapter direction. The numbered sections below will contain the refined probe results.

| Harness | 1. Goal / loop | 2. System prompt | 3. Tools | 4. Communication / link | 5. History / compaction / export | 6. Session model switch |
|---|---|---|---|---|---|---|
| Claude | HELP: print/stream turn engine, no native goal claimed. Workjet must own condition checks and retrigger after result. | HELP: `--append-system-prompt`, file variant; default prompt snapshots on resume. Probe priority and refresh. | HELP: `--mcp-config`, `--strict-mcp-config`; SDK tools. Probe local echo and actual names. | Existing Workjet mailbox contract; live exchange OPEN. `workjet://thread/<id>` remains a proposal. | HELP: resume, stream JSON; `/compact` DOC. Foreign-history user-context fallback; native import OPEN. | SDK `set_model` / `/model` DOC; live switch OPEN. |
| Codex | LIVE: `thread/goal/set/get/clear`; paused objective returned with no token budget. Active continuation OPEN. | LIVE: `thread/start.developerInstructions` accepted. Role/tool result pending receipt refinement. | LIVE: `dynamicTools` accepted; `item/tool/call` client handler. MCP config also available. | Dynamic mailbox bridge recommended; real Workjet exchange OPEN. | LIVE: `thread/inject_items` and `thread/compact/start` accepted. Completion observation/export being refined. | `turn/start.model` schema supports next-turn switch; distinct-model proof OPEN. |
| Grok Build | LIVE: `session/goal/get` rejected (-32601). ACP exposes stop-hook signals; Workjet goal controller recommended. | HELP: `--system-prompt-override`; LIVE: guessed `session/set_system_prompt` rejected. Current adapter uses managed prompt context. | LIVE: ACP advertises HTTP/SSE MCP. Local call OPEN. | ACP MCP mailbox bridge; real exchange OPEN. | LIVE: session/new → prompt → session/load; guessed `session/compact` rejected. `/compact` and export need probing. | LIVE: `session/set_model` accepts current advertised model. This is a no-op, not distinct-model proof. |
| OpenCode | LIVE: guessed `session/goal/get` rejected (-32601), successful single turn. Durable Workjet loop recommended. | DOC: primary-agent prompt/config instructions; LIVE: guessed setter rejected. Actual prompt priority OPEN. | LIVE: ACP advertises HTTP/SSE MCP. Local tool call OPEN; use SDK server adapter. | Session-scoped MCP mailbox; real exchange OPEN. | LIVE: prompt and load. CLI HELP: JSON import/export; guessed compact method rejected. Server summarize proof OPEN. | ACP config model option advertised; live config change OPEN. |
| MiniMax Code | MISSING: `mcode`; do not claim the app or connector utility proves an agent loop. | DOC-only until CLI installed. Use ACP/agent configuration if advertised; otherwise managed context fallback. | Repository adapter already passes HTTP MCP in ACP session setup; installed CLI proof MISSING. | ACP mailbox spec; live proof MISSING. | Native load/config options described by existing adapter; import/compact/export unproved here. | Advertised model config route required; no guessed IDs; installed CLI proof MISSING. |
| Greppy | HELP: bounded assistant/tool loop, max turns/deadline, resume. Goal semantics require Workjet condition controller. | No system override in installed agent help. ACP discovery/probe OPEN; managed turn context fallback. | Existing Workjet adapter explicitly passes `mcpServers: []`; injection must be implemented, not assumed. | Tools bridge OPEN; do not treat ACP transport as MCP support. | HELP: resume and `/compact`; persistent ACP proof OPEN. One-shot proposal is a Git ref, not a Workjet PR. | HELP/adapter: `/model` and `session/set_model`; live proof OPEN. |
| Pi | No native goal mode claimed. RPC follow-up + `agent_end`/extension loop recommended. Probe OPEN. | HELP: append/replace system prompt; native extension `before_agent_start` can change it per turn. Probe OPEN. | HELP/DOC: explicit extension with `registerTool`; no core MCP claim. Extension echo probe running. | Native tools wrapping Workjet mailbox; live exchange OPEN. | HELP: JSONL resume/fork, HTML export; native RPC compact; foreign history conversion OPEN. | Native RPC `set_model`, same session; proof OPEN. |

## Common adapter contract for the Harness parent

Keep a durable Workjet goal with objective, author/revision, condition and last verified evidence. Goal completion requires a condition receipt; an assistant saying “done” or a harness `end_turn` is insufficient. One loop driver owns each thread. On turn completion, drain tools/receipts, check the condition, then enqueue at most one continuation if still active. Stop on verified completion, explicit owner pause/stop, permanent failure or an owned dependency with one wake-up. Resource waits do not erase the goal. Fixed-interval supervisor checks are durable schedules, not a worker goal loop.

Compile role instructions separately from project instructions. Preserve the harness default prompt, attach the role at its actual native priority where supported, and fingerprint the admitted instruction version. At a safe turn boundary, update it using the native mechanism or resume/rebuild the executor. Never claim a prefixed user message is a system prompt. Enforce commissioning/merge rights at the Workjet tool boundary, independent of prompt priority.

Expose one scoped mailbox interface through MCP or native function tools. Prefer wrapping the existing `workjet_send_message` contract: target workspace, environment and thread IDs; source identity comes from the invocation, not caller arguments. The current source restricts mailbox visibility to orchestrator invocations; migrating the three-role policy is an implementation obligation. A proposed `thread.send/thread.read` facade must map to durable envelopes, delivery receipts and authorised transcript reads. Resolve `workjet://thread/<id>` to the stable Workjet ID, never a provider session ID; implement and test the desktop/UI route separately.

Retain the canonical transcript without provider-specific signatures. Convert foreign tool exchanges into readable records with source attribution, import using a supported API or the existing imported-history continuation, then invoke native compaction and wait for its actual completion event before the next turn. Preserve the full history in Workjet. Harness/model/computer switches retain the Workjet ID and goal. Distinct model selection must come from the account's live catalog; bundled model menus are not proof of entitlement.

## Missing installation / owner actions

MiniMax CLI: the existing Workjet driver pins `@minimax-ai/code@0.6.2` from the public npm registry and exposes `mcode acp`. The [official MiniMax repository](https://github.com/MiniMax-AI/minimax-code) documents the agent CLI separately from the desktop connector utility. Install through Settings → Harnesses / the pinned driver, under the shared admission gate, then authenticate the CLI's own profile if requested. No installation or secret migration was performed during inventory.

Codex can be probed through the valid Settings path. Repairing the PATH symlink is an owner/environment action; it does not block this research.

## Upstream references (supporting, not substitute evidence)

- [Official Codex goals](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex): persisted thread objectives and lifecycle; local protocol has additional statuses.
- [Codex app-server](https://learn.chatgpt.com/docs/app-server): integration surface; generated schema from the installed binary governs exact fields.
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference): system-prompt flags and session controls.
- [Grok Build](https://docs.x.ai/build/overview): installed CLI identity and ACP/headless entry points.
- [OpenCode ACP](https://opencode.ai/v2/docs/cli/acp/): capabilities and compaction extensions vary by version.
- Pi's installed package documentation, `docs/extensions.md`, `docs/rpc.md`: version-matched extension/RPC contract.

## Resource / lifecycle record

Initial host inventory: system 21.47 GiB free, tmp 31.81 GiB free; load 75.31 on 10 logical CPUs. Another task owns the heavy lease. No build, dependency install, browser or computer-use session was started. Greppy graph indexing returned exit 75 with explicit admission deferral and its bounded `read-file` recovery; navigation uses that recovery and Greppy text commands. This is an environment/admission limit, not evidence of a Greppy functional bug. Source and probe results are preserved in this PR; raw temporary data is disposable.
