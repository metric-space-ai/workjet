# Provider model suggestions

Settings model discovery reads the public https://llm.ctox.dev/catalog metadata endpoint. Its IDs come from authenticated vendor GET /models observations. The server validates schema, size and freshness; failures or expired observations report catalogAvailable:false. Compiled CLIProxy model definitions are never a fallback for suggestions.

Existing account model configuration remains separately labelled account-configuration. A catalog observation does not prove that a particular account can infer with that model. The exact-account Hi check remains the inference-health evidence; it does not change because a suggestion appears in the catalog. No account credential or management token is sent to the catalog endpoint.

The HTTP request has an eight-second deadline, rejects redirects and limits the body to128KiB. Public provider/model metadata uses the existing typed discovery contract across desktop/web/mobile. Antigravity has no current public catalog source and reports unavailable.

Tests use exact Kimi IDs observed with the configured account on2026-10-08 (HTTP200 at the coding endpoint). Installed provider checks and account add/remove/reload acceptance remain separate from these source tests.

Check all also repairs legacy dotted Claude IDs, using a complete authenticated GET /v1/models from the same account as evidence. Only IDs whose corrected spelling appears in that response are rewritten. Unknown IDs remain available for the exact-account Hi check to classify. Disabled accounts and other selected accounts are untouched; provider bodies and credentials do not leave the bounded metadata adapter. The repair preserves account identity, secrets, priority and grants, and reloads the existing gateway after the durable configuration write.
