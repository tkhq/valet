/**
 * Step design. A run never asks a person from an agent step (session or
 * orchestrator): the engine refuses `ask_approval` and `ask_question` there,
 * and a gated action call fails before any card opens. A step whose prompt
 * still tells its agent to get approval sends no card, and its own messages
 * can tell a person that a card is waiting.
 *
 * The same prompt reading finds a step that pushes git commits, which the
 * API flags when the run commits under the generic Valet identity. A
 * template walk finds the trigger fields that a scheduled run leaves empty.
 */

import { collectExpressionValuePaths, collectTemplateValuePaths } from './expression.js';

/** Words that tell an agent to get a person's approval or sign-off. */
const APPROVAL_REQUEST =
  /\bask_(?:approval|question)\b|\bready for (?:your |their )?approval\b|\bapprove or (?:deny|reject)\b|\b(?:ask|request|get|seek|obtain|wait for|await)(?:s|ed|ing)?\b[^.\n]{0,40}?\b(?:approval|sign[- ]?off)\b/gi;

/** A negation just before the match: "do not ask anyone for approval". */
const NEGATED = /\b(?:not|never|no|without|don't|doesn't|do not|does not)\b[^.\n]{0,24}$/i;

/** Words that tell an agent to make git commits and push them. */
const GIT_PUSH =
  /\bgit\s+(?:commit|push)\b|\bcommit(?:s|ted|ting)?\b[^.\n]{0,60}?\bpush(?:es|ed|ing)?\b|\bpush(?:es|ed|ing)?\b[^.\n]{0,30}?\b(?:to|into)\s+(?:the\s+)?(?:main|master|origin|remote|default branch|branch|repo|repository)\b/gi;

/** True when an agent step's prompt has a match for `words` that no negation comes just before. */
function agentPromptSays(node: { type: string; prompt?: unknown }, words: RegExp): boolean {
  if (node.type !== 'session' && node.type !== 'orchestrator') return false;
  if (typeof node.prompt !== 'string') return false;
  for (const match of node.prompt.matchAll(words)) {
    const before = node.prompt.slice(Math.max(0, match.index - 40), match.index);
    if (!NEGATED.test(before)) return true;
  }
  return false;
}

/**
 * Says when an agent step's prompt tells its agent to get a person's
 * approval. A heuristic over the prompt text: a suggestion, never a
 * validation error.
 */
export function approvalRequestWarning(node: { type: string; prompt?: unknown }): string | undefined {
  if (!agentPromptSays(node, APPROVAL_REQUEST)) return undefined;
  return (
    "This step tells its agent to get a person's approval. A run never asks a person from an agent step, so the request is refused and nobody gets a card. " +
    'Put the action that needs approval in a tool step, which stops for approval on each run, or add an approval step for a sign-off.'
  );
}

/**
 * True when an agent step's prompt tells its agent to commit and push with
 * git. A heuristic over the prompt text, like {@link approvalRequestWarning}.
 * The caller decides if the run's git identity makes that a problem.
 */
export function pushesGitCommits(node: { type: string; prompt?: unknown }): boolean {
  return agentPromptSays(node, GIT_PUSH);
}

/**
 * The `trigger.data` keys a scheduled run sets itself. The API's scheduler
 * starts the run with `{ scheduleName, cron, input }` and puts the
 * schedule's own input under `input`.
 */
const SCHEDULE_DATA_KEYS: ReadonlySet<string> = new Set(['scheduleName', 'cron', 'input']);

/**
 * The `trigger.data.<field>` reads that are empty on a scheduled run, by
 * node id. A foreach body counts under the foreach's id, and an edge's
 * `when` counts under the edge's `from` node, where the branch is decided.
 * A field that the same template or expression also reads as
 * `trigger.data.input.<field>` works on both kinds of run, so it is left
 * out.
 */
export function scheduledRunMisses(definition: unknown): Map<string, string[]> {
  const misses = new Map<string, string[]>();
  if (!isRecord(definition) || !Array.isArray(definition.nodes)) return misses;
  for (const node of definition.nodes) {
    if (!isRecord(node) || typeof node.id !== 'string') continue;
    const fields = new Set<string>();
    collectMisses(node, fields);
    if (fields.size > 0) misses.set(node.id, [...fields]);
  }
  if (Array.isArray(definition.edges)) {
    for (const edge of definition.edges) {
      if (!isRecord(edge) || typeof edge.from !== 'string' || typeof edge.when !== 'string') continue;
      const fields = new Set(misses.get(edge.from));
      addMisses(edge.when.includes('{{') ? collectTemplateValuePaths(edge.when) : collectExpressionValuePaths(edge.when), fields);
      if (fields.size > 0) misses.set(edge.from, [...fields]);
    }
  }
  return misses;
}

/** Every template string in `value`, and an `if` condition's bare `left` expression. */
function collectMisses(value: unknown, fields: Set<string>): void {
  if (typeof value === 'string') {
    if (value.includes('{{')) addMisses(collectTemplateValuePaths(value), fields);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectMisses(entry, fields);
    return;
  }
  if (!isRecord(value)) return;
  if (value.type === 'if' && Array.isArray(value.conditions)) {
    for (const condition of value.conditions) {
      if (isRecord(condition) && typeof condition.left === 'string') addMisses(collectExpressionValuePaths(condition.left), fields);
    }
  }
  for (const entry of Object.values(value)) collectMisses(entry, fields);
}

function addMisses(paths: string[][], fields: Set<string>): void {
  const isData = (path: string[]) => path[0] === 'trigger' && path[1] === 'data';
  const covered = new Set(paths.filter((path) => isData(path) && path[2] === 'input' && path[3] !== undefined).map((path) => path[3]));
  for (const path of paths) {
    const field = path[2];
    if (!isData(path) || field === undefined || SCHEDULE_DATA_KEYS.has(field) || covered.has(field)) continue;
    fields.add(field);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
