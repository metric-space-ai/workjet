# Instance provider remaining limits

The native account Limits cell adapts the bounded public utilization receipt in
`normalizeNativeModelsQuota`, then uses `normalizeModelsQuota` and the existing
`AccountLimits` renderer from the gateway account table. There is one calculation
of remaining percentage, one warning policy and one bar renderer.

The native Claude receipt reports utilization as a fraction. Its adapter only
converts that fraction to the qualified raw percentage; the shared normalizer
computes the remaining allowance. An unqualified provider direction stays
unknown. `allowed` and `rejected` never establish a percentage or exhaustion.
Missing, stale and expired readings share the existing unknown presentation.
The component schedules a repaint only at freshness/reset transitions.

The same renderer supplies Short-term (duration in the tooltip), 7 Tage and
30 Tage labels, remaining meters and the 20%/5% warning boundaries. The current
native receipt contract supplies five-hour and seven-day windows. 30-day windows
remain supported by the shared gateway normalizer; this change does not invent
new native receipt fields.

At narrow widths, instance limits and model selection occupy separate full-width
rows under the account controls. At wider widths, the existing five-column table
is retained. Web and Desktop share this renderer; this proof is not a native
React Native or installed-product acceptance run.

The isolated browser profile renders the real `NativeProviderRowsView` with
synthetic public account metadata, empty model lists and no account credentials.
Playwright uses clean contexts at 1440/420 px, reloads each case, blocks external
requests, and checks remaining values, bars, colors, zero-only exhaustion,
unknown directions and narrow-row separation. Console errors and failed requests
must be empty. Auth, account mutations and upstream inference are outside this
component proof.

| Width   | Before original #422                                                    | Shared remaining display                                              |
| ------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1440 px | [Before](native-provider-limits-20261011/native-limits-before-1440.png) | [After](native-provider-limits-20261011/native-limits-after-1440.png) |
| 420 px  | [Before](native-provider-limits-20261011/native-limits-before-420.png)  | [After](native-provider-limits-20261011/native-limits-after-420.png)  |

The browser receipt records the exact screenshot source revision. Before source
is original #422 head `29de99516aadd413803e1a36b0e0f30c880e854e`.
Run `scripts/verify-native-provider-limits.sh` through the GPU build lane for the
focused tests, typechecks, lint and the browser proof. Earlier negative lane
receipts remain in the durable task evidence directory; lint-import and fixture
selector failures were harness issues. The first narrow screenshot exposed text
overlap, which the responsive row change and its geometry assertion address.
