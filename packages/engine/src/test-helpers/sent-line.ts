/**
 * The engine starts each user message in the model transcript with a
 * `[sent: …]` line (`messageTimeLine`). Tests that check what the person
 * wrote use this to remove it. `model-context.test.ts` checks the line itself.
 */
export function withoutSentLine(text: string): string {
  return text.replace(/^\[sent: [^\]\n]*\](?:\n\n|$)/, "");
}
