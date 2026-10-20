/**
 * Step design. A run never asks a person from an agent step (session or
 * orchestrator): the engine refuses `ask_approval` and `ask_question` there,
 * and a gated action call fails before any card opens. A step whose prompt
 * still tells its agent to get approval sends no card, and its own messages
 * can tell a person that a card is waiting.
 */

/** Words that tell an agent to get a person's approval or sign-off. */
const APPROVAL_REQUEST =
  /\bask_(?:approval|question)\b|\bready for (?:your |their )?approval\b|\bapprove or (?:deny|reject)\b|\b(?:ask|request|get|seek|obtain|wait for|await)(?:s|ed|ing)?\b[^.\n]{0,40}?\b(?:approval|sign[- ]?off)\b/gi;

/** A negation just before the match: "do not ask anyone for approval". */
const NEGATED = /\b(?:not|never|no|without|don't|doesn't|do not|does not)\b[^.\n]{0,24}$/i;

/**
 * Says when an agent step's prompt tells its agent to get a person's
 * approval. A heuristic over the prompt text: a suggestion, never a
 * validation error.
 */
export function approvalRequestWarning(node: { type: string; prompt?: unknown }): string | undefined {
  if (node.type !== 'session' && node.type !== 'orchestrator') return undefined;
  if (typeof node.prompt !== 'string') return undefined;
  for (const match of node.prompt.matchAll(APPROVAL_REQUEST)) {
    const before = node.prompt.slice(Math.max(0, match.index - 40), match.index);
    if (NEGATED.test(before)) continue;
    return (
      "This step tells its agent to get a person's approval. A run never asks a person from an agent step, so the request is refused and nobody gets a card. " +
      'Put the action that needs approval in a tool step, which stops for approval on each run, or add an approval step for a sign-off.'
    );
  }
  return undefined;
}
