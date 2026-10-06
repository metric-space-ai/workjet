# Gateway account selection and health

Workjet uses one fixed cache-preserving account policy. A provider-scoped session identity comes from `prompt_cache_key`, `session_id`, or explicit session metadata and is hashed before persistence. Requests without an identity share a stable provider lane.

An eligible session retains its account across requests, new quota observations and restarts. Disabled, unsupported, cooling and genuinely exhausted accounts cannot serve it. Its replacement becomes the new durable affinity. Recovery of the previous account does not move it back. New sessions prefer usable observed quota with the earliest reset, then priority and stable account ID. Unknown quota uses deterministic fallback.

The authenticated runtime-status route publishes an optional account-health envelope projected into `gateway.health.accounts`. Empty windows and null values mean unknown. Each quota window carries its observation and reset time. Native generation cooldowns and typed HTTP failures are visible without returning upstream error messages or credentials.

A health read starts at most one owned quota refresh task. It makes sequential requests with a three-second bound per account, caches successes and failures for five minutes and aborts on source drop. A usage-endpoint 429 is a read failure and never a generation cooldown.

Codex subscription usage reads `https://chatgpt.com/backend-api/wham/usage` with OAuth access token and the ChatGPT account ID parsed from its ID token. The upstream shape is specified by [OpenAI's backend client](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client.rs) and [usage reader](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs). Claude reads `https://api.anthropic.com/api/oauth/usage` with its OAuth token and beta header. The endpoint is undocumented and may reject requests, as tracked in [Anthropic's usage API issue](https://github.com/anthropics/claude-code/issues/31021); failures remain explicit unknown quota. Unsupported providers do not infer percentages from token accounting.

Disabling the last account leaves management running without an inference default. When another provider remains enabled, configuration chooses a deterministic enabled default fallback.
