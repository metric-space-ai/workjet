# Provider login and model checks

After a successful OAuth claim, Workjet cancels the old model-check transport before replacing the secrets, reloads the gateway with those secrets and forces a fresh check of the completed accounts. This discards their previous persisted results even if the provider issued the same token. Other accounts retain their observations. Login completion does not depend on renderer timers.

The native host also persists account cooldowns. A verified, one-time OAuth claim clears only previous HTTP 401/403 outcomes whose stored provider and token fingerprint match the claimed token. Simply starting the gateway cannot heal a rejected credential. Quotas, balances, model failures and session affinity remain intact; recovery never stores or reports plaintext tokens. A failed durable reset keeps the claim available for retry.

Each server probe has a twenty-second deadline. Timeout and cancellation abort the adapter request; late successes cannot overwrite the result. A timeout persists as gateway-unavailable with no provider error class or HTTP status. The account/model row shows a direct retry; it never claims that an unobserved provider rejected credentials. Cancel and shutdown finish even if an adapter does not settle after abort.

The browser stops displaying cached pending checks when the status request fails or its finite polling deadline expires, and exposes a retry message. Authentication and quota errors still require a real upstream response. A green check still requires a real inference result.
