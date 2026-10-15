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
Only TOKENS_LIMIT affects LLM selection. Raw unit/number and the qualified
nextResetTime epoch-millisecond reset are retained. The renderer owns window
qualification; unknown unit encodings stay unknown. CREDIT_LIMIT scope remains
unestablished, so unrecognized scopes do not block inference.

Kimi Code (coding plan) keys on `https://api.kimi.com/coding/v1` or
`https://api.kimi.ai/coding/v1` are read at `{base}/usages` with the bearer key
(MoonshotAI/kimi-code `packages/oauth/src/managed-usage.ts`). `usages.limit_5h`,
`limit_7d` and `limit_month_total` each become one window; `used_ratio` (0..1)
is the used share, `reset_time` the RFC 3339 reset. `limit_month_code` is a
sub-budget of the monthly total and not its own window. The older
`usage`/`limits[]` count shape (MoonshotAI/kimi-cli `ui/shell/usage.py`) is read
only when `usages` is absent. Moonshot platform keys keep their monetary
balance read and never yield a percentage. The balance/usage split follows the
probed URL, not the provider name.

SuperGrok subscription accounts on the default upstream are read at
`https://cli-chat-proxy.grok.com/v1/billing?format=credits` with the OAuth
access token, `X-XAI-Token-Auth` and `x-grok-client-version`, the same headers
the subscription chat proxy already receives (xai-org/grok-build
`xai-grok-shell/src/extensions/billing.rs` @2bdd1d6a). `config.creditUsagePercent`
is the used share of the one weekly or monthly pool, `config.currentPeriod.end`
(else `billingPeriodEnd`) the reset. A missing percentage stays unknown;
on-demand spend and prepaid balance never become a window. xAI API keys have no
quota read.

Probe and parse failures report quota errors without rejecting inference
authentication. Positive readings expire for display; known exhausted windows
remain exhausted until their actual reset. Unlimited windows never exhaust.

Primary contracts:

- https://platform.minimax.io/subscribe/token-plan
- https://github.com/MiniMax-AI/cli/blob/main/src/types/api.ts
- https://github.com/MiniMax-AI/cli/blob/main/src/utils/quota.ts
- https://github.com/MiniMax-AI/cli/blob/main/src/output/quota-table.ts
- https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs

## Z.ai reset unit evidence

The reset unit is qualified from a published dashboard response, not a
versioned provider specification. The captured `TOKENS_LIMIT.nextResetTime`
is `1784643970777` in [api-to-use.md:42](https://github.com/shafi-/ext-zai-reset-timer/blob/1e7c03d07305ba29baa745036012cfc26c809f0e/docs/api-to-use.md#L42).
The same capture has `TIME_LIMIT.nextResetTime = 1785166359997` on line 21.
The original dashboard extension compares that raw value with `Date.now()`
at [content.js:17](https://github.com/shafi-/ext-zai-reset-timer/blob/1e7c03d07305ba29baa745036012cfc26c809f0e/content.js#L17)
and passes it directly to `new Date(ts)` at [content.js:70](https://github.com/shafi-/ext-zai-reset-timer/blob/1e7c03d07305ba29baa745036012cfc26c809f0e/content.js#L70).
Both use epoch milliseconds. `1784643970777` therefore means
`2026-07-21T14:26:10.777Z`; the focused parser fixture preserves it unchanged.
This reset timestamp does not establish window duration or percent direction.
