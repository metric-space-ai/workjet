# Provider account and model status

`workjetGatewayHealth` reads the running environment's authenticated gateway
management surface. `accounts` contains the host's account observations; it is
independent of `instance.providers.read`, which supplies the selected CTOX
instance's provider catalog through the guest.

Each account now optionally supplies `models` for its exact configured model
IDs. Each item has `modelId`, `status`, `usable`, `cooldownUntilMs`, `errorCode`,
`httpStatus` and `observedAtMs`. Wildcard configuration entries are not expanded
into guessed model IDs. Older hosts omit this field: omission is unreported
model eligibility, never a successful check.

The statuses are `ready`, `unknown`, `disabled`, `cooldown`, `auth-required`,
`model-unavailable`, `quota` and `balance`. `ready` means selectable according
to the host's persisted account/model policy; it does not replace an upstream
model probe. Account `authentication`, generation HTTP status and quota-probe
status remain separate evidence. `auth-required` requires an active persisted
HTTP 401 failure; generic 503 or an instance connection failure must not be
converted into an instruction to sign in again. A usage HTTP 200 does not erase
a model cooldown or prove that a normal model turn is selectable.

For the settings UI, match accounts by `accountId` and models by `modelId`.
Show a paused-until value when `cooldownUntilMs` exists (including a provider's
actual quota reset); show the existing account re-login action for
`auth-required`. Keep healthy models usable when another model has a 404 or an
exhausted model bucket. Never infer access or quota from enabled configuration.

This host change needs a new provider-host artifact and desktop host pin before
it can supply these fields in an installed application. It does not repair or
restart a production account, change credentials, or prove installed model
access.
