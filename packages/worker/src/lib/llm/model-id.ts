/**
 * Provider-prefixed model id parsing + env-key lookup.
 *
 * Lives in its own dep-free module so callers like the validator can
 * import `parseModelId` / `hasProviderKey` without dragging in the
 * Vercel AI SDK (`ai` + `@ai-sdk/*`) — those weigh hundreds of KB and
 * are only needed at LLM execution time.
 */

import { splitModelRef } from '@valet/shared';
import type { Env } from '../../env.js';

export type LlmProvider = 'anthropic' | 'openai' | 'google';

export function parseModelId(modelId: string): { provider: LlmProvider; model: string } {
  // Both separator dialects appear in the product: "provider:model" (workflow
  // llm nodes) and "provider/model" (the model catalog and UI pickers).
  const ref = splitModelRef(modelId);
  if (!ref) {
    throw new Error(`invalid model id "${modelId}" — expected provider-prefixed form like "anthropic:claude-sonnet-4-5" or "anthropic/claude-sonnet-4-5"`);
  }
  if (ref.provider === 'anthropic' || ref.provider === 'openai' || ref.provider === 'google') {
    return { provider: ref.provider, model: ref.model };
  }
  throw new Error(`unsupported LLM provider "${ref.provider}" — supported: anthropic, openai, google`);
}

/**
 * True when the worker env has the API key required by this provider.
 * Used by the publish-time validator to reject `llm` nodes whose
 * provider has no configured key.
 */
export function hasProviderKey(env: Env, provider: LlmProvider): boolean {
  switch (provider) {
    case 'anthropic': return typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.length > 0;
    case 'openai':    return typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.length > 0;
    case 'google':    return typeof env.GOOGLE_API_KEY === 'string' && env.GOOGLE_API_KEY.length > 0;
  }
}
