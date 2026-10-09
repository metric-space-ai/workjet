# Provider login and model checks

Kimi keys are checked automatically against the official Coding Plan endpoints (api.kimi.com and api.kimi.ai) and Moonshot API Plan endpoints (api.moonshot.ai and api.moonshot.cn). The four authenticated GET /models requests share an eight-second deadline, refuse redirects and bounded/malformed lists, and discard provider bodies and transport errors. An accepted existing origin takes precedence; otherwise Coding precedes the API Plan. Only models in the accepted account's live list are adopted. No user plan selector or prefix guess is involved. [Official Kimi endpoint reference](https://www.kimi.com/code/docs/en/).

The accepted plan and endpoint are persisted with the account and shown in its table row. Check all fills missing plan metadata for enabled legacy accounts without replacing secrets or account identity. If no endpoint supplies a valid authenticated list, a typed, secret-free failure names the checked endpoints in the inline key form; network failure is not labelled as rejected credentials. Failed additions or key replacements preserve the previous configuration and secret.

After a successful OAuth claim, Workjet cancels the old model-check transport before replacing the secrets, reloads the gateway with those secrets and forces a fresh check of the completed accounts. This discards their previous persisted results even if the provider issued the same token. Other accounts retain their observations. Login completion does not depend on renderer timers. A new account retains only the model IDs actually reported in its credential claim; an absent list stays empty and can be edited in the account row. OAuth completion never invents wildcard model IDs, and re-login preserves the existing model selection.

The native host also persists account cooldowns. A verified, one-time OAuth claim clears only previous HTTP 401/403 outcomes whose stored provider and token fingerprint match the claimed token. Simply starting the gateway cannot heal a rejected credential. Quotas, balances, model failures and session affinity remain intact; recovery never stores or reports plaintext tokens. A failed durable reset keeps the claim available for retry.

Each server probe has a twenty-second deadline. Timeout and cancellation abort the adapter request; late successes cannot overwrite the result. A timeout persists as gateway-unavailable with no provider error class or HTTP status. The account/model row shows a direct retry; it never claims that an unobserved provider rejected credentials. Cancel and shutdown finish even if an adapter does not settle after abort.

The browser stops displaying cached pending checks when the status request fails or its finite polling deadline expires, and exposes a retry message. Authentication and quota errors still require a real upstream response. A green check still requires a real inference result.

The Claude subscription adapter uses the same protocol baseline as CTOX: Claude Code 2.1.280 with Stainless 0.112.1. User-Agent and generated billing headers share that version. Cached older software profiles are normalized by the existing profile resolver while credential identity and sessions are preserved. This repairs Anthropic's real HTTP 400 minimum-version rejection; an upstream quota response remains a quota response, and cannot be presented as a successful check.

The xAI subscription buffered path accepts both `response.completed` and `response.incomplete` terminal events. A valid token-limited answer retains its incomplete status and output; it does not replace the session's last complete reasoning replay. Failed or unterminated streams remain failures. Model probes ask xAI to reply with `Hi` only, keeping the visible answer inside the existing eight-token limit.

Z.ai API and Coding Plans can return identical authenticated model lists. On adding a key, a bounded eight-token inference selects an accepted official endpoint; new selections come from the live public catalog intersected with the account's own list. Check all repairs legacy platform-default accounts only when the same stored key accepts inference at the Coding endpoint. Custom origins and disabled accounts stay untouched. An exhausted Coding quota never triggers a paid platform fallback. Stored endpoint bindings isolate quota, balance and cooldown observations from the old endpoint while retaining account identity, secret references and session affinity; subsequent restarts preserve genuine failures at the new endpoint.

Claude model spelling is repaired only when the account's complete authenticated GET /models contains the corrected ID. Inline model edits are normalized before persistence. Check all also repairs disabled Claude accounts while preserving their disabled state and secret references; disabled accounts never run inference probes. Unknown IDs remain visible for their actual check result when no live correction is available. The gateway's OAuth claim carries no default Claude model list, and it does not import the Claude CLI settings model. Historical stored selections have no author/source audit field, so the current configuration alone cannot identify who entered a legacy ID.

## Provider-wide model selection

The Models table edits one providerModels selection per provider. Account rows
retain real per-account check results and only expose model exclusions. The
holder's private gateway configuration persists exclusions and projects the
selection into native account lists; no secret enters catalog read responses.

Legacy lists are adopted as their provider's union. Each account retains its
effective list through exclusions and a conservative migration snapshot.
Adoption does not enable disabled accounts or broaden usable models. New IDs
require the current public llm.ctox.dev catalog or an authenticated account list;
existing legacy IDs may be retained or removed. Suggestions exclude
configuration-only IDs. Kimi and Claude edits refresh account evidence privately.
An observed account list constrains effective selection; unknown access remains
limited to the migration snapshot. Exclusions survive provider model removal,
re-addition and credential replacement. Changed lists schedule exact-account Hi
checks.

This holder-side compatibility slice does not implement native federation,
remove the Environment boundary or claim an offline Mac serves remote workers.
Instance metadata, membership/withdrawals and holder dispatch follow separately.

## Public catalog cache

The server loads its bounded public catalog cache and refreshes llm.ctox.dev at
startup and every day while its service scope is alive. Concurrent readers share
one refresh. The cache contains only the decoded public catalog, not credentials
or account configuration. It survives restarts and retains the original upstream
observation timestamp during an outage. Suggestions older than seven days are
omitted; malformed, future-dated and unavailable observations never become a
static fallback. Failed refreshes are throttled for one minute.

Cached suggestions do not authorize adding a model ID. Provider selection edits
still require a fresh public observation or the account's authenticated live
list. This cache does not add catalog provider coverage or federated routing.
