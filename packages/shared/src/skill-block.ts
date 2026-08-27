/**
 * The skill-block wire format — the single definition of the
 * `<skill name="...">…</skill>` expansion that the command dispatcher
 * writes into a user message for a context-invocation skill.
 *
 * The engine builds the block (`buildSkillBlock` from
 * `commands/dispatch.ts`); the web transcript recovers it for rendering.
 * Recovery has two tiers:
 *
 * 1. `sliceSkillBlock` — exact, delimiter-proof extraction for messages
 *    whose wire projection carries the skill name and raw args (stamped
 *    as queue-item metadata at dispatch time). Because the name and args
 *    are known, the body is recovered by LENGTH, so a body that contains
 *    a literal `</skill>` line cannot corrupt the split.
 * 2. `parseSkillBlock` — best-effort regex for messages persisted before
 *    the metadata stamp existed. Its lazy body match splits early on a
 *    body that contains a line-start `</skill>` followed by a blank
 *    line; that is the accepted limit of the legacy tier.
 */

/** A recovered skill invocation: the skill body and the user's raw args. */
export interface SkillBlock {
  name: string;
  content: string;
  /** Text the user typed after the command. Empty string when absent. */
  rest: string;
}

/**
 * Build the dispatcher's expansion: the wrapped skill body, then the raw
 * user args after one blank line. This is the ONLY producer of the format;
 * `sliceSkillBlock` and `parseSkillBlock` must stay inverse to it (see
 * the round-trip tests in skill-block.test.ts).
 */
export function buildSkillBlock(name: string, content: string, raw = ""): string {
  const block = `<skill name="${name}">\n${content.trim()}\n</skill>`;
  return raw ? `${block}\n\n${raw}` : block;
}

/**
 * Exact extraction when the skill name and raw args are known from
 * message metadata. Verifies the text is byte-for-byte a `buildSkillBlock`
 * output for (name, args) and recovers the body by length — immune to
 * `</skill>` inside the body or the args. Returns null on any mismatch
 * (caller falls back to `parseSkillBlock`, then to plain rendering).
 */
export function sliceSkillBlock(text: string, name: string, args = ""): SkillBlock | null {
  const prefix = `<skill name="${name}">\n`;
  const suffix = args ? `\n</skill>\n\n${args}` : "\n</skill>";
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) return null;
  const content = text.slice(prefix.length, text.length - suffix.length);
  // A body that contains the closing delimiter would make prefix+suffix
  // overlap on very short texts; reject rather than return garbage.
  if (prefix.length + suffix.length > text.length) return null;
  return { name, content, rest: args };
}

/**
 * Legacy best-effort parse for messages without the metadata stamp.
 * Anchored at both ends so a message that merely QUOTES a skill block
 * mid-prose stays plain text. Lazy body match — see the module comment
 * for the accepted `</skill>`-in-body limitation.
 */
const SKILL_BLOCK_RE = /^<skill name="([^"\n]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]*))?$/;

export function parseSkillBlock(text: string): SkillBlock | null {
  const m = SKILL_BLOCK_RE.exec(text);
  if (!m) return null;
  return { name: m[1], content: m[2], rest: m[3]?.trim() ?? "" };
}
