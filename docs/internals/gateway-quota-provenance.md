# Quota source metadata

This host-only change preserves a whitelist of provider quota evidence in
`quota[].source`: raw percent field/name/value, optional duration in seconds,
MiniMax status, and Z.ai unit/number. It keeps `remainingPercent` for older
clients and accepts older cached windows without `source`. No credentials,
counts with ambiguous direction or complete upstream bodies are exported.

Claude `utilization`, Codex `used_percent` and Z.ai `percentage` are consumed.
MiniMax `*_remaining_percent` is remaining; its documented status 2 is
exhausted. Codex `limit_window_seconds` and MiniMax start/end timestamps retain
duration. Z.ai unit/number are passed through unchanged for client qualification;
`nextResetTime` is retained as an epoch-millisecond reset.

Display normalization, 20%/5% warnings, window labels and unknown reasons belong
to the Desktop/Web renderer PR, not this host. Existing account selection and
compatibility percentages remain intact. This PR takes effect only after a
host release and a separate Desktop pin update; it does not publish either.

Evidence:

- `account_health.rs::parse_api_quota` and `parse_usage` select the raw fields.
- [MiniMax quota contract](https://github.com/MiniMax-AI/cli/blob/main/src/types/api.ts)
- [MiniMax count ambiguity](https://github.com/MiniMax-AI/cli/blob/main/src/utils/quota.ts)
- [Provider-owned Z.ai usage interpretation](https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs)
- [First-hand qualified Z.ai response](https://github.com/steipete/CodexBar/issues/2522)

Focused `api_quotas` tests use JSON fixtures only. They exercise all six
providers, serialization, duration/status preservation, reversed Z.ai window
order, unknown encodings, MiniMax's contradictory exhausted reading, and old
cache compatibility. They never open installed state or a real secret store.
