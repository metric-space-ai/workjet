# Model provider accounts

Settings → Models lists each connected account in a compact table. Add provider connects another subscription or API-key provider. The small plus next to a provider stacks another account.

Account names and model IDs are editable in place. Press Enter or leave the field to save; Escape cancels. Paste comma-separated model IDs into a model field or the model plus to add several IDs. Model changes affect only the selected account. Active controls whether Workjet uses the account. The account menu offers re-check and permanent removal; removal requires confirmation.

Each model shows the result of a minimal server-side inference check for that exact account: green for a response, red for a classified failure, or gray before checking. Hover the status for the check time, latency and recovery action. Check all forces a new check of active accounts. Automatic checks are bounded and cached for five minutes, and results survive restarting the server. Gateways without exact account selection cannot report a successful account check.

Re-login appears when an active subscription account rejects credentials. API-key accounts offer replacement at the masked key or after an authentication error. Limits are provider-reported readings, with reset and observation time in the tooltip; an em dash means the provider does not report a reading. Account scheduling and session affinity use the standard gateway policy.

Usage below the table combines recorded requests by model across providers for 7 or 30 days. Missing token or limit readings remain unknown.

CTOX instance accounts expose their own controls when the connected instance supports them. Toggle an account directly in its row. The trash can asks for confirmation there and removes that account, its credentials and its account-specific model settings. The row changes only after the instance confirms the new state. If the connection fails, refresh accounts before retrying. Older instances keep account state read-only until CTOX is updated. Shared models remain available to other accounts of the same provider.
