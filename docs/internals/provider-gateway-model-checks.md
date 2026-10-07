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
unchecked suffix without re-forcing freshly checked models. Pending work is
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
