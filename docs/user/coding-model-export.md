# Coding model export

Run `workjet models export --url https://your-workjet-server` with a Workjet access token supplied through `WORKJET_ACCESS_TOKEN`. The command prints a JSON snapshot from the running server. The token needs orchestration read access.

Each model ID comes from a fresh authenticated model list for its exact provider account. The export also reports account health, a recent model check, and the configured coding route and harness probe. A row has `available: true` only when every required observation agrees. `unverifiedAccounts` names accounts whose live model list could not be read; those accounts contribute no model IDs to a worker draw.

The server currently supports authenticated account model lists for Claude, xAI API keys, and MiniMax API keys. Other provider accounts remain unverified until their own live list endpoint is supported. A configured model name or a Worker profile does not make an unverified model eligible.
