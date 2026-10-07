# Gateway model checks

The server exposes `workjet.providerGateway.modelChecks` (read scope) and
`workjet.providerGateway.checkModels` (operation scope). The shared client atoms
are `workjetGatewayModelChecks` and `checkWorkjetGatewayModels`. The command can
select an account and model; omitted selectors check all configured models.
`force: true` bypasses the five-minute cooldown for a manual check.

The command returns promptly with the current checks, `pending` account/model
pairs (`queued` or `running`) and `deferredCount`. Clients refresh the query while
pending is nonempty. At most 32 new requests are admitted per command and 64
requests can be pending globally. For larger lists, `deferredCount` reports
eligible targets omitted by the bound; follow-up non-forced commands advance the
unchecked suffix without re-forcing freshly checked models. Admission prioritizes
never-admitted targets, then the least recently admitted targets, using an
internal monotonic order independent of the wall clock and provider routing.
Clients finish one requested pass by tracking its original target observations;
`deferredCount` describes current eligible work, rather than pass completion,
because earlier checks may expire during a long pass. Pending work is
owned by the service scope, aborts on shutdown and is not resumed after restart.

Each check sends a short Responses request through the same local provider
endpoint used by Threads. Requests run one at a time and coalesce per account,
model and credential/configuration revision. The response has a 15-second
transport deadline and a 64 KiB body ceiling. API-key additions/replacements,
completed OAuth logins and routing/model edits enqueue only changed models and
return the persisted settings without waiting for inference. New catalog/model edits also trigger the client command.

`provider-gateway-model-checks.json` holds redacted status, error class, timestamp,
latency and HTTP status, plus a server-only digest of the account connection and
credentials. Credentials, prompts, generated output and provider error text are
never persisted in that file. A credential or connection edit hides stale checks;
adding one model retains observations for the account's existing models.

The host must advertise `features.account_selection: true` in runtime status
before a per-account request is sent. Requests carry `X-CTOX-Provider` and
`X-CTOX-Account`; all responses must acknowledge exactly the selected
account in `X-CTOX-Account-Selected`, including failures. Older hosts receive no
inference request. Gateway admission, missing capability, transport failures and
unacknowledged or unverified responses produce `unavailable` with `source: gateway`,
a closed unavailable reason and no provider error class. The UI displays a grey
unchecked icon. Only an acknowledged native `X-CTOX-Error-Class` becomes a red
upstream error; neither a gateway HTTP code nor model-shaped gateway text implies
rejected credentials or an unknown provider model. A validated completed response
becomes green with `source: upstream`. Raw messages are never displayed.

The original provider HTTP code comes from `X-CTOX-Upstream-Status`, emitted
by the same request-local observation as the native error class. A provider 401
may be wrapped by the gateway in HTTP 502: only the original 401 warrants
credential recovery. Older hosts without that header retain their verified
class with an unknown (`null`) upstream HTTP code. Invalid status headers are
unverified gateway responses. Refresh/retry success replaces the first failure.

The observation file is version 3. Older observations are discarded because
version 1 lacked response provenance and version 2 could store a wrapper HTTP
code as the provider code. Settings and credentials are preserved, and the next
bounded pass checks the models afresh.

A valid Responses success may include `error: null`. Codex subscription checks
use `store: false` and a short-reply instruction because that upstream rejects
`max_output_tokens`; other providers retain the eight-token output bound. A bare
404 without a native upstream class remains unchecked. A 403 does not establish expired credentials and
does not show Re-login. Native retry cooldowns are displayed with their retry
time and the observed failure, separately from quota exhaustion. A retry time is
the gateway's next attempt, not a promise that the provider becomes available.

Settings use the selected Business OS's assigned Code-computer environment. The
provider endpoint belongs to that Workjet server, not automatically to the
Business OS daemon's CLIProxy. Explicit harness-instance endpoint overrides also
remain distinct routes; a ready worker or pool does not verify the exact account
shown in the Models table.
