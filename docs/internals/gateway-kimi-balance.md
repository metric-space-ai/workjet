# Moonshot API monetary balance

Kimi/Moonshot pay-as-you-go API keys use the configured regional destination.
Only exact `https://api.moonshot.ai/v1` and `https://api.moonshot.cn/v1`
origins/paths receive a bounded bearer-authenticated
`GET /v1/users/me/balance` request. Keys are not retried against another region,
custom origin or Kimi Code subscription endpoint.

[International balance contract](https://platform.kimi.ai/docs/api/balance)
documents USD; [China balance contract](https://platform.kimi.com/docs/api/balance)
documents CNY. The parser requires `code: 0`, `status: true` and
`scode: "0x0"` plus a finite numeric `data.available_balance`.
Cash and voucher amounts remain nullable; cash may be negative, vouchers cannot.
The available amount is authoritative; no amounts are summed, converted,
turned into percentages, or given inferred refill/reset timestamps.

The existing health request starts sequential probes with a three-second bound
per account and caches successful and failed attempts for five minutes.
Successful readings are durable and retain their observation timestamp.
Parse, permission, transport and durable-write failures produce a refresh error
while preserving the previous reading, generation authentication and affinity.
Only a fresh nonpositive balance makes an account ineligible for inference.
After five minutes, a last-reported balance is displayed as stale and no longer
determines inference eligibility; there is no known refill time.
Replacing the account API key clears the old balance while retaining its session lane.

The additive nullable health `balance` contains `availableBalance`,
`currency`, nullable `cashBalance`/`voucherBalance` and `observedAtMs`.
Older hosts decode to unknown balance. Existing model-scoped quota windows
remain unchanged. The compact account row shows the monetary amount directly,
including explicit currency and stale/refresh-error states.
