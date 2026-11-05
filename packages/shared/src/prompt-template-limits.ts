/**
 * The longest text one prompt template field of a line may store: the
 * instructions (`systemPrompt`) and the event message (`userPromptTemplate`).
 *
 * One definition for both sides. The api refuses a longer field
 * (`validatePromptTemplate` in packages/api/src/events/prompt-template.ts),
 * and the web editor counts characters and holds Save against the same
 * number, so the editor never sends a field the api will refuse.
 *
 * Why 4,000 (docs/specs/2026-07-20-event-system-design.md, Prompt templates):
 * the instructions ride above the event in every delivery, inside an
 * 8,000-character delivered body, so 4,000 keeps at least half of that body
 * for the event. About 1,000 tokens repeats on every event of a busy line.
 * Long guidance belongs in a skill, which the assistant reads only when it
 * needs it.
 */
export const MAX_PROMPT_TEMPLATE_CHARS = 4_000;
