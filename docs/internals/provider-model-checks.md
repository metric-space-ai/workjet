# Provider login and model checks

After a successful OAuth claim, Workjet cancels the old model-check transport before replacing the secrets, reloads the gateway with those secrets and forces a fresh check of the completed accounts. This discards their previous persisted results even if the provider issued the same token. Other accounts retain their observations. Login completion does not depend on renderer timers. A new account retains only the model IDs actually reported in its credential claim; an absent list stays empty and can be edited in the account row. OAuth completion never invents wildcard model IDs, and re-login preserves the existing model selection.

The native host also persists account cooldowns. A verified, one-time OAuth claim clears only previous HTTP 401/403 outcomes whose stored provider and token fingerprint match the claimed token. Simply starting the gateway cannot heal a rejected credential. Quotas, balances, model failures and session affinity remain intact; recovery never stores or reports plaintext tokens. A failed durable reset keeps the claim available for retry.

Each server probe has a twenty-second deadline. Timeout and cancellation abort the adapter request; late successes cannot overwrite the result. A timeout persists as gateway-unavailable with no provider error class or HTTP status. The account/model row shows a direct retry; it never claims that an unobserved provider rejected credentials. Cancel and shutdown finish even if an adapter does not settle after abort.

The browser stops displaying cached pending checks when the status request fails or its finite polling deadline expires, and exposes a retry message. Authentication and quota errors still require a real upstream response. A green check still requires a real inference result.

The Claude subscription adapter uses the same protocol baseline as CTOX: Claude Code 2.1.280 with Stainless 0.112.1. User-Agent and generated billing headers share that version. Cached older software profiles are normalized by the existing profile resolver while credential identity and sessions are preserved. This repairs Anthropic's real HTTP 400 minimum-version rejection; an upstream quota response remains a quota response, and cannot be presented as a successful check.

The xAI subscription buffered path accepts both `response.completed` and `response.incomplete` terminal events. A valid token-limited answer retains its incomplete status and output; it does not replace the session's last complete reasoning replay. Failed or unterminated streams remain failures. Model probes ask xAI to reply with `Hi` only, keeping the visible answer inside the existing eight-token limit.

