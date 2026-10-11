# Worker autonomy coverage — PR #423

This is source and focused-test evidence, not a claim that all native harness/model turns or macOS kernel boundaries have been accepted.

The common MCP tool set is `workjet_worker_kanban`, `workjet_update_goal`, `workjet_submit_worker`; Persistent Workers additionally receive `workjet_escalate`; Supervisors receive `workjet_escalate` and `workjet_answer_worker`. One-Shots never receive escalation or answer tools. Role scopes: apps/server/src/mcp/McpSessionRegistry.ts:178. Registration: apps/server/src/mcp/toolkits/workjet/WorkerAutonomyTool.ts:35. Tests call the real HTTP MCP endpoint for nine configured adapter identities (WorkerToolsAvailability.test.ts:1); these are not nine live provider turns.

All rows use the single role prompt source packages/workjet-capabilities/src/teamRolePrompt.ts:4, compiled by packages/workjet-capabilities/src/prompt.ts:52. Native role skills are a separate delivery still open; this PR delivers tools and common prompts first, as permitted by the assignment.

| Harness | Tools | Native role skill | Common role prompt delivery | Question / elicitation / approval fallback | Bypass default / One-Shot confinement |
| --- | --- | --- | --- | --- | --- |
| Claude Code | HTTP MCP, ClaudeAdapter.ts:4595 | Open | ClaudeAdapter.ts:4542 | AskUserQuestion/ExitPlanMode disallowed at :4544; native elicitation handler :4370; common routing below | bypassPermissions; oneShotClaudePolicy.ts:9 native sandbox + PreToolUse/CwdChanged; no extra writable directories |
| Codex | HTTP MCP, CodexAdapter.ts:1808 | Open | CodexAdapter.ts:1798 | Normalised provider requests use common routing; One-Shots force default collaboration mode, CodexSessionRuntime.ts:427 | approval never; One-Shots workspace-write, sole writable root and temporary roots excluded, CodexSessionRuntime.ts:289 and :342 |
| OpenCode | HTTP MCP, OpenCodeAdapter.ts:1362 | Open | OpenCodeAdapter.ts:1306 | Native questions :1084 / approvals :1044 use common routing; separate elicitation handler absent | Full-access; One-Shot start refused until native containment exists, executionPolicy.ts:42 |
| Grok CLI | HTTP MCP, GrokAdapter.ts:709 | Open | GrokAdapter.ts:675 | ACP approvals :793; native question/elicitation handler absent; completed-text fallback | Full-access permission acceptance :797; One-Shot start refused, executionPolicy.ts:42 |
| Pi | HTTP MCP bridge, pi/PiWorkjetExtension.ts:10 and :54 | Open | PiAdapter.ts:253 and :323 | Native input/elicitation callback absent; completed-text fallback | Full-access :239; One-Shot start refused, executionPolicy.ts:42 |
| MiniMax | HTTP MCP, MiniMaxAdapter.ts:340 | Open | MiniMaxAdapter.ts:531 | Native elicitation :427 and approvals :374 use common routing | Full-access :374; One-Shot start refused, executionPolicy.ts:42 |
| Cursor | HTTP MCP, CursorAdapter.ts:647 | Open | CursorAdapter.ts:621 | ACP approvals :769; separate question/elicitation handler absent; completed-text fallback | Full-access mode mapping :303; One-Shot start refused, executionPolicy.ts:42 |
| Greppy | HTTP MCP, GreppyAdapter.ts:253; ACP preserves servers, acp/GreppyAcpSupport.ts:90 | Open | GreppyAdapter.ts:386 and :582 | ACP approvals :286; question/elicitation handler absent; completed-text fallback | Full-access auto-accept :291; One-Shot start refused, executionPolicy.ts:42 |
| CTOX | Common MCP scope exists; native submitTurn payload does not carry its endpoint/credential: CtoxAdapter.ts:452. **Open native tool delivery gap** | Open | CtoxAdapter.ts:423 and :426 | Native waiting/unknown state :244 does not expose a decision callback; completed-text fallback only after completion | Full-access retained :373; One-Shot start refused, executionPolicy.ts:42 |

Paths abbreviated above are under apps/server/src/provider/Layers unless a different path is given.

Common routing is apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:2111 (question/approval recipient) and :1881 (completed terminal-question fallback), backed by apps/server/src/workjet/WorkerSupervisorDecisions.ts:54 (authenticated UI engagement), :66 (One-Shot automatic answer or termination), :109 (five-minute missing-Supervisor timeout), :143 (startup recovery), :441 (terminal questions) and :505 (durable answers). Its nine-identity tests exercise normalised question, elicitation and approval events; they do not imply an absent native adapter hook exists.

Missing-Supervisor state is exposed by ProjectionSnapshotQuery.ts:509 and web projectOverviewModel.ts:29; this exception is a project notice, not an Owner decision. UI ingress records engagement at apps/server/src/ws.ts:1442; UUID dispatch and remote-worker command IDs never create it.

Migration 082 records previous permission modes and migrates projections plus replay events (apps/server/src/persistence/Migrations/082_WorkerAutonomyDefaults.ts:7). Migration 083 owns decisions and UI engagement. The isolation-stack migration 081 and its fail-closed execution-policy admission are retained. No installed profile has been migrated by this task.

Open acceptance and delivery:
- Native role skills remain a follow-up PR; they must be emitted from one role source into each native mechanism.
- Native CTOX MCP delivery and native input hooks identified above remain open.
- Cross-server Supervisor forwarding is not implemented: the durable decision queue binds a Supervisor in the same server's project projections. An absent binding produces the visible notice and timeout.
- Codex/Claude containment configuration and hook tests pass; an actual macOS adversarial write/cwd run has not been performed. Other One-Shots fail closed rather than run without containment.
- Common MCP HTTP calls and mocked native adapter tests are not live model-turn acceptance.
