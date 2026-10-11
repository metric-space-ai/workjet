# Remaining model allowances

`normalizeModelsQuota` is the single display normalizer for Settings → Models
in Web and the Desktop renderer. Percentage and warning state use its result;
HTTP errors and gateway retry timestamps never establish a percentage.
No installed account data or credentials are needed for its fixtures.

| Provider | Raw field in provider response                                                           | Direction                               | Window evidence                                                                                                                              |
| -------- | ---------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | `five_hour.utilization`, `seven_day*.utilization`                                        | consumed; `100 − utilization`           | Provider keys identify 5 hours and 7 days; model scope goes in the tooltip.                                                                  |
| Codex    | `rate_limit.*_window.used_percent`                                                       | consumed; `100 − used_percent`          | `limit_window_seconds`; primary is Short-term, secondary without duration is unknown.                                                        |
| Z.ai     | `data.limits[].percentage` for `TOKENS_LIMIT`                                            | consumed; `100 − percentage`            | Raw `unit` / `number` pairs (3/5 = 5 h, 6/1 = 7 days, 5/1 = month); unqualified pairs stay unknown. Never list position or reset proximity.  |
| MiniMax  | `model_remains[].current_interval_remaining_percent`, `current_weekly_remaining_percent` | remaining; preserve, cap display at 100 | `start_time` / `end_time`, weekly counterparts, or the documented 5-hour/weekly bucket identity. Status 2 explicitly establishes exhaustion. |
| xAI      | no quota reading in the account-health source                                            | unavailable                             | Em dash, “Anbieter meldet kein Limit”.                                                                                                       |
| Kimi     | `data.available_balance` is money, no allowance percentage                               | unavailable                             | Em dash for no quota; a reported monetary balance remains separate.                                                                          |

Code evidence: `native/provider-gateway-workjet-host/src/account_health.rs`
(`parse_api_quota`, `parse_usage`, `api_quota_endpoint`, `parse_balance`), and
`account_policy.rs::QuotaWindow`. The Desktop pin is host v0.1.2 from
`b731a990ae960e56bbb33e83306aca51ef57f7bb`; its four supported quota parsers
already serialize **remaining** as `remainingPercent`. The renderer therefore
never subtracts this compatibility field from 100 again.

Primary provider contracts:

- [MiniMax quota fields and status](https://github.com/MiniMax-AI/cli/blob/main/src/types/api.ts)
- [MiniMax ambiguity in usage counts](https://github.com/MiniMax-AI/cli/blob/main/src/utils/quota.ts)
- [Z.ai provider-owned usage script](https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs)
- [First-hand Z.ai response/window qualification](https://github.com/steipete/CodexBar/issues/2522)

MiniMax's `*_usage_count` has meant both consumed and remaining in different
provider versions. Neither a count, its name, HTTP 429, nor a cooldown proves
that 100% means consumed. The explicit remaining field is authoritative;
without it or documented exhausted status, the display is unknown. A fixture
covers a 100/100 count with exhausted status and contradictory 100%: status 2
normalizes it to 0%, with “Limit reached” at that window only.

The optional, whitelisted `quota[].source` carries the actual percent field,
raw value, duration and status. New-host readings are normalized in the
renderer; old hosts continue to work immediately. The old host discarded
Codex duration and Z.ai duration/reset metadata, so missing periods display
“unbekannt” with a reason until the separate metadata-only host change is
released and pinned. A near reset does not reveal the period length.

100% is unused, 0% is exhausted. Yellow starts at 20% remaining, red at 5%.
Boosts do not extend the visual scale above 100%. No-plan, unlimited and
model-specific windows retain their scopes. Known zeros survive until reset;
other readings expire after five minutes and future timestamps are unknown.

Verification uses only synthetic account names and empty model lists, with
clean browser contexts at 1440 and 420 pixels. The component harness renders
the real provider table and normalizer; account mutations, authentication,
upstream calls and the installed product are outside this scoped UI check.
