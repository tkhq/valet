# Supplemental model catalog metadata

Date: 2026-10-05
Status: implemented

The bundled catalog adds `openai/gpt-6.1-sol` and `anthropic/claude-sonnet-5-5`
when the pinned SDK lacks those IDs. SDK entries take precedence by provider and
ID; existing runtime registry overlays still take precedence over the bundled
baseline. No dependency, default model, tier, credential, or approval-list changes
are required. Provider availability and organization approval rules still apply.

Both models accept text and images and support 128,000 output tokens. Sol uses
the Responses API for tool calling, a 1,050,000-token context, and the documented
price tier above 272,000 input tokens. Sonnet uses Anthropic Messages with a
1,000,000-token context. Pricing metadata includes standard input/output and
cache rates. Both expose low, medium, high, xhigh, and max effort.

Sonnet uses adaptive thinking and omits temperature. The SDK does not expose
Sonnet's optional `between_tools` mode through this catalog; off and minimal are
unavailable. Valet does not force tool choice. This addition does not enable
other optional model-specific features or guarantee account access.

Validation covers catalog deduplication and SDK precedence, normal provider and
approval eligibility, effort levels, and SDK request serialization using a fake
HTTP transport. It does not make paid model requests or measure model quality.

## Sources

Verified October 5, 2026:

- [OpenAI GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [Claude Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)
- [Sonnet migration guide](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide)
- [Claude effort support](https://platform.claude.com/docs/en/build-with-claude/effort)
