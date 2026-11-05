/** Bound owner memory injected into the runtime prompt. */
export const PERSONALITY_INJECT_CAP = 500;

/** The persona prefix. `name` is a carried-over assistant name
 * (`legacy-profile.ts`): the assistant keeps answering to it, as it did when
 * the profile set it. */
export function personaPrefixText(personality: string, name?: string): string {
  const capped = personality.slice(0, PERSONALITY_INJECT_CAP).trim();
  const text = name ? (capped ? `You are ${name}. ${capped}` : `You are ${name}.`) : capped;
  return text ? `${text}\n\n` : "";
}
