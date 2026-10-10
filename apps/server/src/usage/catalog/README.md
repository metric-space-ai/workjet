# Bundled price catalog 2026-10-10.1

This is a source-controlled snapshot, embedded in the server bundle. UsageService
never downloads prices or reads the legacy external price cache. Update this
file in a reviewed source change; there is no runtime refresh option.

Base-tier USD-per-token fields come from [LiteLLM revision 3981228d7038383fcc7e998e2561ef124f8c878c](https://github.com/BerriAI/litellm/blob/3981228d7038383fcc7e998e2561ef124f8c878c/model_prices_and_context_window.json).
The accompanying MIT license is in LICENSE.litellm.

To comply with the live-model rule, only exact provider/model entries whose IDs
were observed in llm.ctox.dev/catalog are retained. The observed catalog and its
timestamp are embedded for provenance. This snapshot has three priced models;
the remaining observed models have no matching upstream price. Other models
remain unpriced. The catalog is used only for cost arithmetic, never suggestions
or provider defaults. Provider-reported costs still take precedence.
