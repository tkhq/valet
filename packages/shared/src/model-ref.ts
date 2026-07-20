/**
 * Model-reference splitting shared by every layer that handles model ids.
 *
 * Two dialects exist across the product — "provider/model" (OpenCode, the
 * model catalog, UI pickers) and "provider:model" (workflow llm nodes, the
 * Vercel AI SDK convention). Both are split at the FIRST separator of either
 * kind, so model names that embed the other character keep working
 * ("ollama/llama3:70b" → provider "ollama"; "openrouter:anthropic/claude-x"
 * → provider "openrouter").
 *
 * A reference with no separator, or with a separator at either edge
 * (":model", "provider/"), does not split — callers decide whether bare refs
 * are legal in their context.
 */

export interface ModelRefParts {
  provider: string;
  model: string;
}

/** Split a model reference at the first "/" or ":". Null for bare/edge refs. */
export function splitModelRef(ref: string): ModelRefParts | null {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf('/');
  const colon = trimmed.indexOf(':');
  const sep = slash === -1 ? colon : colon === -1 ? slash : Math.min(slash, colon);
  if (sep <= 0 || sep >= trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, sep), model: trimmed.slice(sep + 1) };
}

/** True when a model reference has no provider prefix in either dialect. */
export function isBareModelRef(ref: string): boolean {
  const trimmed = ref.trim();
  return !trimmed.includes('/') && !trimmed.includes(':');
}
