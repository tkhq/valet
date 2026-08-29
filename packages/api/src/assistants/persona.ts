/** Personality is capped at injection time (assistant-centered web UI
 * decision 5), independent of any cap the memory service itself applies.
 * The constant lives on the wire (`wire/types.ts`) so the editor's
 * `maxLength` imports the same value the API 400s on; re-exported here for
 * the api-side callers. */
import { PERSONALITY_INJECT_CAP } from "../wire/types.js";
export { PERSONALITY_INJECT_CAP };

/** `You are {name}. {personality}` prefix for an assistant's systemPrompt
 * (assistant-centered web UI decision 5). Absent name → "" regardless of
 * personality: the identity step always sets name first, and a prefix with
 * no name in it helps nobody. */
export function personaPrefixText(name: string | null, personality: string): string {
  if (!name) return "";
  const capped = personality.slice(0, PERSONALITY_INJECT_CAP);
  const sentence = capped ? `You are ${name}. ${capped}` : `You are ${name}.`;
  return `${sentence}\n\n`;
}
