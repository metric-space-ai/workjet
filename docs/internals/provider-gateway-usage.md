# Environment model usage

The Workjet gateway host records one inference receipt for each completed
Responses or Messages connection. The host owns collection, so Workjet workers
and other callers routed through the same gateway are included. Model catalog,
OAuth, and token-count requests do not count as inference. Stream frames and
internal account retries do not add requests; an inference error remains one
request with one error.

Receipts live under the environment state directory in
`provider-gateway-usage/<UTC-epoch-day>.jsonl`. Each receipt retains its completion
timestamp, provider, model evidence, outcome, and available token counters.
Request content, generated content, credentials, and credential fingerprints
are never persisted. Appends are serialized and fsynced; after a crash, the
writer truncates an incomplete final line before appending another receipt.
Historical receipts survive both gateway-host and Workjet-server restarts.
There is no retrospective reconstruction and no collection for calls that bypass
the environment gateway.

The authenticated `workjet.providerGateway.usage` RPC requires orchestration
read scope. Its typed input is `{ days: 7 | 30, timeZone?: string }`; the server
validates the timezone with the runtime's IANA timezone database, defaulting to
UTC. Windows are calendar days including today. Completion timestamps are
converted into that zone, preserving local midnight and daylight-saving
boundaries. Daily rows retain provider and model dimensions, while `modelTotals`
combine a model across providers and `providerTotals` combine models. The shared
client query is `serverAtoms.workjetGatewayUsage({ environmentId, input })`.
Environment, window, and timezone form separate cache keys.

Token sums are null when no receipt supplied that counter. A sum with fewer
`*MeasuredRequests` than `requests` is a partial measurement, not an estimate.
Cache read and cache write counters remain separate. Input-token conventions
follow the gateway protocol: native Anthropic Messages input excludes separately
reported cache tokens; Responses input may include cached tokens. Consumers
must not add cache counters indiscriminately to input totals.

Portable SDK translators can synthesize zero token fields and model aliases
when upstream fields are absent. Collection therefore trusts zero and response
model identity only on direct Codex Responses and native Claude Messages.
Translated positive token counts are retained, translated zeros stay unknown,
and translated model identity uses the requested model with request provenance.
`responseModelRequests` exposes how many requests had direct response-model
evidence. Requested aliases must not be presented as independently verified
upstream model identity. Oversized response frames are dropped from observation
without changing inference delivery; their unavailable counters stay unknown.

The read path examines only UTC journals overlapping the selected window and
limits each journal to 16 MiB. A read/parse/size failure is `usage-unavailable`,
not an empty successful history; an invalid timezone is `invalid-usage-query`.
A concurrently appended final line is deferred to the next read. The host retains today plus 35 completed UTC days, providing a boundary margin
for every supported local 30-day window. Cleanup runs at most once per UTC day
under the append lock and removes only recognized old numeric day journals. No journal in the
window yields `not-collected-yet`. Native storage-write failure emits a
content-free error; successful inference delivery is preserved, and those
receipts cannot be recovered retrospectively.
