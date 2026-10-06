# Astra retirement

Astra is disabled because its cost exceeded the accepted budget.
The policy applies across organizations and provider namespaces.
Model IDs containing an `astra` component are disabled, including dated aliases.

The bundled and runtime catalogs exclude disabled models.
Cached catalogs and remote refreshes cannot restore their availability.
Custom-provider and OpenRouter selections use the same exclusion.
Saved tier fallback lists skip Astra and can select the next allowed entry.
Explicit pins fail with instructions to select GPT-6.1 Sol or Claude Opus 5.5.
The engine checks the effective model before sending each request, including compaction summaries.
OpenRouter routing suffixes cannot bypass the exclusion.
The recording proxy rejects Astra requests before contacting the provider.
Both centralized credentials and personal pass-through credentials follow this policy.
Inference requests must identify their model explicitly.
Proxy batch creation is unavailable because uploaded request files are not inspected.
Send individual inference requests through the proxy instead.

Existing sessions, transcripts, workflows, and usage records remain retained.
Historical pricing uses bundled metadata separately from execution eligibility.
Restoring a session with an Astra default resolves the current owner/tier default,
so history and the model selector remain accessible. Allowed pins stay unchanged.
Retired stored user defaults fall through to the next allowed default.
Thread-specific Astra pins still reject inference until changed.

## Validation

Focused tests cover bundled, cached, and refreshed catalogs; model resolution;
current-pin validation; tier fallback; proxy rejection; and historical pricing.
Proxy tests verify that rejected requests never contact the upstream provider.
