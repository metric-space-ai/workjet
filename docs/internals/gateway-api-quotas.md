# API-key quota reads

The authenticated health path performs bounded, on-demand MiniMax M/Token Plan
and Z.ai Coding Plan quota reads. It reuses the five-minute success/failure cache,
three-second per-account bound, configured proxy and existing secret resolver.
Custom origins and unrecognized upstream paths are not probed.

MiniMax uses bearer subscription keys at `/v1/token_plan/remains`. Its vendor CLI
defines direct remaining percentages, millisecond end timestamps, optional weekly
boost permille and unlimited status. Counts have changed meaning between API
versions, so the host never derives percentages from counts. Unknown fields stay
unknown. Zero-total/no-plan buckets are not presented as unlimited. Only general
and MiniMax-M model buckets affect LLM selection; model-specific buckets affect
only matching models. Tool buckets remain in health data but are hidden from compact LLM limits.
An absent LLM subscription bucket has separate not-in-plan metadata and display;
it does not establish a pay-as-you-go inference failure.

Z.ai uses the raw key in Authorization at `/api/monitor/usage/quota/limit`.
TOKENS_LIMIT percentage is used percentage; TIME_LIMIT is MCP/tool quota.
Only TOKENS_LIMIT affects LLM selection. Reset semantics and CREDIT_LIMIT scope
are not established by the inspected vendor contract, so reset stays unknown
and unrecognized scopes do not block inference.

Probe and parse failures report quota errors without rejecting inference
authentication. Positive readings expire for display; known exhausted windows
remain exhausted until their actual reset. Unlimited windows never exhaust.

Primary contracts:

- https://platform.minimax.io/subscribe/token-plan
- https://github.com/MiniMax-AI/cli/blob/main/src/types/api.ts
- https://github.com/MiniMax-AI/cli/blob/main/src/utils/quota.ts
- https://github.com/MiniMax-AI/cli/blob/main/src/output/quota-table.ts
- https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs
