/**
 * Step budgets. An agent step (session or orchestrator) may make at most
 * `maxModelCalls` model calls. At the limit the engine stops before the next
 * call and the step fails with a reason, instead of running on until a
 * compaction loses the task or the run times out.
 */
import type { WorkflowNode } from './nodes.js';

/** Model calls an agent step may make when it sets no `maxModelCalls`. */
export const DEFAULT_STEP_MODEL_CALLS = 150;
/** The highest `maxModelCalls` a step may set. */
export const MAX_STEP_MODEL_CALLS = 500;

/** The model call limit a dispatched agent step carries. */
export function stepModelCallLimit(node: { maxModelCalls?: number }): number {
  // A stored value that skipped validation falls back to the default, never to no limit.
  const value = node.maxModelCalls;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_STEP_MODEL_CALLS
    ? value : DEFAULT_STEP_MODEL_CALLS;
}

/** A plural work item next to "every", "each" or "all": one agent handles a whole list. */
const LIST_OF_WORK =
  /\b(?:every|each|all)\b[^.\n]{0,48}?\b(?:prs?|pull requests?|issues?|tickets?|items?|rows?|records?|files?|documents?|docs|pages?|messages?|emails?|threads?|commits?|repos?|repositories|channels?|meetings?|leads?|accounts?|customers?|users?|releases?|alerts?|incidents?)\b/i;

/**
 * Says when an agent step outside a foreach asks one agent to handle every
 * item in a list. A list that grows makes that step run out of model calls.
 * A heuristic over the prompt text: a suggestion, never a validation error.
 * A step that sets its own `maxModelCalls` was bounded on purpose, so it gets
 * no warning.
 */
export function unboundedWorkWarning(node: WorkflowNode): string | undefined {
  if (node.type !== 'session' && node.type !== 'orchestrator') return undefined;
  if (node.maxModelCalls !== undefined) return undefined;
  if (typeof node.prompt !== 'string' || !LIST_OF_WORK.test(node.prompt)) return undefined;
  return (
    `This step asks one agent to handle every item in a list. It stops after ${stepModelCallLimit(node)} model calls. ` +
    'If the list can grow, list the items in one step, then use a foreach step that handles one item in each iteration.'
  );
}
