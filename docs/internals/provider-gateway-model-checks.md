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
`X-CTOX-Account`; successful responses must acknowledge exactly the selected
account in `X-CTOX-Account-Selected`. Older hosts receive no inference request and
produce `account-selection-unavailable`. Errors use the host's closed-whitelist
`X-CTOX-Error-Class` when present, then HTTP status and structured error codes.
Raw error messages are never displayed. An empty/malformed success is not green.

A valid Responses success may include `error: null`. Codex subscription checks
use `store: false` and a short-reply instruction because that upstream rejects
`max_output_tokens`; other providers retain the eight-token output bound. A bare
404 is a connection/provider failure unless the structured error or native class
identifies an unknown model. A 403 does not establish expired credentials and
does not show Re-login. Native retry cooldowns are displayed with their retry
time and the observed failure, separately from quota exhaustion.
