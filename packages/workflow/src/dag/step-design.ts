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
 *
 * A walk of the step references finds two designs that make a run drift:
 * an agent step that builds a foreach's list with read actions only, and a
 * model step that rewrites another model step's draft before a tool step
 * sends it.
 */

import { readToolScope } from '@valet/shared';
import { collectExpressionPaths, collectExpressionValuePaths, collectTemplatePaths, parseTemplate } from './expression.js';

/** Words that tell an agent to get a person's approval or sign-off. */
const APPROVAL_REQUEST =
  /\bask_(?:approval|question)\b|\bready for (?:your |their )?approval\b|\bapprove or (?:deny|reject)\b|\b(?:ask|request|get|seek|obtain|wait for|await)(?:s|ed|ing)?\b[^.\n]{0,40}?\b(?:approval|sign[- ]?off)\b/gi;

/**
 * A negation just before the match, in the same clause: "do not ask anyone
 * for approval". Clause punctuation ends it, so "Don't open a PR; commit and
 * push" still pushes.
 */
const NEGATED = /\b(?:not|never|no|without|don't|doesn't|do not|does not)\b[^.,;:!?\n]{0,24}$/i;

/**
 * Words that tell an agent to make git commits and push them: `git push`,
 * also with options such as `git -C <dir> push`, and commit-then-push or
 * push-to-a-branch phrasing. A period inside a word, as in a file name, does
 * not end the phrase. "Push the update to the main Slack channel" is not git.
 * Every repeat has a fixed bound, so a long prompt such as `git -C ` many
 * times over cannot make the match backtrack for seconds.
 */
const GIT_PUSH =
  /\bgit(?:\s+-\S{1,40}(?:\s+[^\s-]\S{0,200})?){0,4}?\s+(?:commit|push)\b|\bcommit(?:s|ted|ting)?\b(?:[^.\n]|\.(?=\S)){0,60}?\bpush(?:es|ed|ing)?\b|\bpush(?:es|ed|ing)?\b(?:[^.\n]|\.(?=\S)){0,30}?\b(?:to|into)\s+(?:the\s+)?(?:main|master|origin|remote|default branch|branch|repo|repository)\b(?![ \t]+(?:\w+[ \t]+)?channel\b)/gi;

/** Words that tell an agent to open a pull request. */
const OPENS_PULL_REQUEST = /\b(?:open|create|file|raise|submit)(?:s|ed|ing)?\s+(?:a|an|the)\s+(?:new\s+|draft\s+)?(?:pull request|PR)\b|\bgh\s+pr\s+create\b/gi;

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
 * git, and not to open a pull request. A person merges a pull request under
 * their own name, which is the fix the API's warning names. A heuristic over
 * the prompt text, like {@link approvalRequestWarning}. The caller decides
 * if the run's git identity makes a push a problem.
 */
export function pushesGitCommits(node: { type: string; prompt?: unknown }): boolean {
  return agentPromptSays(node, GIT_PUSH) && !agentPromptSays(node, OPENS_PULL_REQUEST);
}

/**
 * The `trigger.data` keys a scheduled run sets itself: `{ scheduleName,
 * cron, input }`, with the schedule's own input under `input`. An input key
 * with one of these names stays under `input` only.
 */
const SCHEDULE_DATA_KEYS: ReadonlySet<string> = new Set(['scheduleName', 'cron', 'input']);

/** How a definition reads `trigger.data`, for the schedule input copy. */
interface TriggerDataUse {
  /** The fields it reads under `trigger.data.input`. */
  nested: Set<string>;
  /** It reads `trigger.data` or `trigger.data.input` as one value, so a copy changes what it sees. */
  whole: boolean;
}

function triggerDataUse(definition: unknown): TriggerDataUse {
  const use: TriggerDataUse = { nested: new Set(), whole: false };
  const record = (path: string[]) => {
    if (path[0] !== 'trigger' || path[1] !== 'data') return;
    if (path.length === 2) use.whole = true;
    else if (path[2] === 'input') {
      if (path[3] === undefined) use.whole = true;
      else use.nested.add(path[3]);
    }
  };
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.includes('{{')) {
        try {
          collectTemplatePaths(value).forEach(record);
        } catch {
          // The validator reports a template that does not parse.
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (isRecord(value)) {
      if (value.type === 'if' && Array.isArray(value.conditions)) {
        for (const condition of value.conditions) if (isRecord(condition) && typeof condition.left === 'string') visitExpression(condition.left);
      }
      Object.values(value).forEach(visit);
    }
  };
  const visitExpression = (source: string) => {
    try {
      collectExpressionPaths(source).forEach(record);
    } catch {
      // The validator reports an expression that does not parse.
    }
  };
  if (isRecord(definition)) {
    visit(definition.nodes);
    if (Array.isArray(definition.edges)) {
      for (const edge of definition.edges) {
        if (isRecord(edge) && typeof edge.when === 'string' && !edge.when.includes('{{')) visitExpression(edge.when);
      }
      visit(definition.edges);
    }
  }
  return use;
}

/**
 * The `trigger.data` of a scheduled run. A manual run puts its input at
 * `trigger.data.<field>`, and a scheduled run used to put it only under
 * `trigger.data.input`, so a workflow written for manual runs read empty
 * values on every scheduled run. The schedule's input now also goes at the
 * top level, with three exceptions that keep a workflow written for the
 * nested shape exactly as it was:
 *
 * - a field the definition reads under `trigger.data.input` stays nested
 *   only, so a fallback such as `{{trigger.data.input.ref}}{{trigger.data.ref}}`
 *   does not render the value twice;
 * - nothing is copied when the definition reads `trigger.data` or
 *   `trigger.data.input` as one value;
 * - a field named `scheduleName`, `cron` or `input` stays nested only.
 */
export function scheduledTriggerData(
  definition: unknown,
  schedule: { scheduleName: string; cron: string; input: unknown },
): Record<string, unknown> {
  const use = triggerDataUse(definition);
  const copied = use.whole || !isRecord(schedule.input)
    ? {}
    : Object.fromEntries(Object.entries(schedule.input).filter(([field]) => !SCHEDULE_DATA_KEYS.has(field) && !use.nested.has(field)));
  return { ...copied, scheduleName: schedule.scheduleName, cron: schedule.cron, input: schedule.input };
}

/**
 * Where a step reads a trigger field: a `{{ }}` template, or an
 * `expression` (an `if` condition's `left` or an edge's `when`), which takes
 * no braces.
 */
export type TriggerReadSite = 'template' | 'expression';

/** A `trigger.data.<field>` read that a scheduled run leaves empty, and where the step reads it. */
export interface ScheduledRunMiss {
  field: string;
  sites: TriggerReadSite[];
}

/** Each missed field's read sites. */
type FieldReads = Map<string, Set<TriggerReadSite>>;

/**
 * The `trigger.data.<field>` reads that are empty on a scheduled run, by
 * node id. A scheduled run copies its input to the top level unless the
 * definition reads that field under `trigger.data.input`, or reads the
 * envelope whole ({@link scheduledTriggerData}). So a read misses only when
 * the copy is skipped. A foreach body counts under the foreach's id, and an
 * edge's `when` counts under the edge's `from` node, where the branch is
 * decided. A field that the same template or expression also reads as
 * `trigger.data.input.<field>` works on both kinds of run, so it is left
 * out.
 */
export function scheduledRunMisses(definition: unknown): Map<string, ScheduledRunMiss[]> {
  if (!isRecord(definition) || !Array.isArray(definition.nodes)) return new Map();
  const use = triggerDataUse(definition);
  const copySkipped = (field: string) => use.whole || use.nested.has(field);
  const reads = new Map<string, FieldReads>();
  for (const node of definition.nodes) {
    if (!isRecord(node) || typeof node.id !== 'string') continue;
    const fields: FieldReads = new Map();
    collectMisses(node, fields);
    reads.set(node.id, fields);
  }
  if (Array.isArray(definition.edges)) {
    for (const edge of definition.edges) {
      if (!isRecord(edge) || typeof edge.from !== 'string' || typeof edge.when !== 'string') continue;
      const fields: FieldReads = reads.get(edge.from) ?? new Map();
      const expressions = edge.when.includes('{{') ? templateExpressionPaths(edge.when) : [collectExpressionValuePaths(edge.when)];
      for (const paths of expressions) addMisses(paths, fields, 'expression');
      reads.set(edge.from, fields);
    }
  }
  const misses = new Map<string, ScheduledRunMiss[]>();
  for (const [nodeId, fields] of reads) {
    const missed = [...fields].filter(([field]) => copySkipped(field));
    if (missed.length > 0) misses.set(nodeId, missed.map(([field, sites]) => ({ field, sites: [...sites] })));
  }
  return misses;
}

/** Every template string in `value`, and an `if` condition's bare `left` expression. */
function collectMisses(value: unknown, fields: FieldReads): void {
  if (typeof value === 'string') {
    if (value.includes('{{')) for (const paths of templateExpressionPaths(value)) addMisses(paths, fields, 'template');
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectMisses(entry, fields);
    return;
  }
  if (!isRecord(value)) return;
  if (value.type === 'if' && Array.isArray(value.conditions)) {
    for (const condition of value.conditions) {
      if (isRecord(condition) && typeof condition.left === 'string') addMisses(collectExpressionValuePaths(condition.left), fields, 'expression');
    }
  }
  for (const entry of Object.values(value)) collectMisses(entry, fields);
}

/**
 * The value paths of each `{{ }}` expression in `source`, one list per
 * expression, so a fallback in one expression covers only that expression.
 * Empty when the template does not parse: the validator reports that.
 */
function templateExpressionPaths(source: string): string[][][] {
  try {
    return parseTemplate(source).segments.filter((segment) => segment.kind === 'expr').map((segment) => collectExpressionValuePaths(segment.text));
  } catch {
    return [];
  }
}

/** Adds the fields one expression reads, unless it also reads them under `trigger.data.input`. */
function addMisses(paths: string[][], fields: FieldReads, site: TriggerReadSite): void {
  const isData = (path: string[]) => path[0] === 'trigger' && path[1] === 'data';
  const covered = new Set(paths.filter((path) => isData(path) && path[2] === 'input' && path[3] !== undefined).map((path) => path[3]));
  for (const path of paths) {
    const field = path[2];
    if (!isData(path) || field === undefined || SCHEDULE_DATA_KEYS.has(field) || covered.has(field)) continue;
    fields.set(field, (fields.get(field) ?? new Set<TriggerReadSite>()).add(site));
  }
}

const AGENT_STEP_TYPES: ReadonlySet<string> = new Set(['session', 'orchestrator']);
const MODEL_STEP_TYPES: ReadonlySet<string> = new Set(['session', 'orchestrator', 'llm']);

/** An action that only reads, by the verb its name starts with. */
const READ_ACTION = /^[\w-]+\.(?:search|list|get|read|inspect|fetch|query)_/;
/** An action that enumerates items. An agent that also reads their content may be choosing which ones count. */
const LIST_ACTION = /^[\w-]+\.(?:search|list|query)_/;
/** Words that make a step an editing pass over a draft, in its prompt or its id. */
const EDITS_DRAFT = /\b(?:tighten|revis(?:e|es|ing)|rewrit(?:e|es|ing)|re-write|polish|proofread|copy-?edit|check (?:the|this) draft)\b/gi;

type Step = Record<string, unknown> & { id: string; type: string };

/** The top-level steps of a definition, by id. */
function stepsById(definition: unknown): Map<string, Step> {
  const steps = new Map<string, Step>();
  if (!isRecord(definition) || !Array.isArray(definition.nodes)) return steps;
  for (const node of definition.nodes) {
    if (isRecord(node) && typeof node.id === 'string' && typeof node.type === 'string') steps.set(node.id, { ...node, id: node.id, type: node.type });
  }
  return steps;
}

/** The step ids that templates in `value` read as `nodes.<id>`. A foreach body counts as its foreach. */
function stepReads(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    if (!value.includes('{{')) return out;
    try {
      for (const path of collectTemplatePaths(value)) if (path[0] === 'nodes' && path[1] !== undefined) out.add(path[1]);
    } catch {
      // The validator reports a template that does not parse.
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) stepReads(entry, out);
  } else if (isRecord(value)) {
    for (const entry of Object.values(value)) stepReads(entry, out);
  }
  return out;
}

/** The action id a tool step runs: `action` when it is qualified, else `service.action`. */
function toolAction(step: Record<string, unknown>): string | undefined {
  if (step.type !== 'tool' || typeof step.action !== 'string') return undefined;
  if (step.action.includes('.')) return step.action;
  return typeof step.service === 'string' ? `${step.service}.${step.action}` : undefined;
}

/** True when the step, or a foreach's body, runs a tool action that is not a read. */
function sendsOrWrites(step: Step): boolean {
  const target = step.type === 'foreach' && isRecord(step.body) ? step.body : step;
  const action = toolAction(target);
  return action !== undefined && !READ_ACTION.test(action);
}

/**
 * Agent steps whose output is the list a foreach runs over, when every
 * action in the step's scope only lists. A tool step with that action
 * returns the same list on each run with no model turns, and its list
 * cannot drop or repeat items. A heuristic: a suggestion, never a
 * validation error.
 */
export function listingAgentStepWarnings(definition: unknown): Map<string, string> {
  const steps = stepsById(definition);
  const warnings = new Map<string, string>();
  for (const foreach of steps.values()) {
    // A foreach that sends or writes each item posts a step's output; its list is a result, not fetched data.
    if (foreach.type !== 'foreach' || sendsOrWrites(foreach)) continue;
    for (const id of stepReads(foreach.items)) {
      const step = steps.get(id);
      if (step === undefined || !AGENT_STEP_TYPES.has(step.type)) continue;
      const actions = readToolScope(step.toolScope)?.actions ?? [];
      if (actions.length === 0 || !actions.every((action) => LIST_ACTION.test(action))) continue;
      warnings.set(id, `This agent step builds the list that foreach step "${foreach.id}" runs over, and it only lists (${actions.join(', ')}). ` +
        'Get the list from a tool step instead. A tool step returns the same items on each run with no model turns. ' +
        'If the list needs judgment, put an llm step after the tool step, or decide each item in the foreach.');
    }
  }
  return warnings;
}

/**
 * Model steps that rewrite another model step's output before a tool step
 * sends or writes it. The earlier step's output goes only to this step, so
 * it is a draft, and this step's id or prompt says it edits it (tighten,
 * revise, polish). A step that writes a message from gathered data is not
 * a rewrite. A second model pass can change correct facts as easily as it
 * fixes wrong ones, and it adds a model call to each run. A heuristic: a
 * suggestion, never a validation error.
 */
export function rewriteStepWarnings(definition: unknown): Map<string, string> {
  const steps = stepsById(definition);
  const reads = new Map([...steps.values()].map((step) => [step.id, stepReads(step)]));
  const readers = (id: string) => [...steps.values()].filter((step) => step.id !== id && reads.get(step.id)?.has(id));
  const warnings = new Map<string, string>();
  for (const step of steps.values()) {
    if (!MODEL_STEP_TYPES.has(step.type) || !editsDraft(step) || !readers(step.id).some(sendsOrWrites)) continue;
    for (const id of reads.get(step.id) ?? []) {
      const draft = steps.get(id);
      if (draft === undefined || !MODEL_STEP_TYPES.has(draft.type)) continue;
      if (readers(id).some((reader) => reader.id !== step.id)) continue;
      warnings.set(step.id, `This step rewrites the output of model step "${id}" before it is sent. ` +
        'A second model pass can change correct facts as easily as it fixes wrong ones, and each run pays for both. ' +
        `Write the result in one step: move this step's rules into "${id}" and its outputSchema. To check exact fields, use an if step.`);
    }
  }
  return warnings;
}

/** True when the step's id, or its prompt outside a negation, says it edits a draft. */
function editsDraft(step: Step): boolean {
  if (new RegExp(EDITS_DRAFT.source, 'i').test(step.id.replace(/[_-]+/g, ' '))) return true;
  if (typeof step.prompt !== 'string') return false;
  for (const match of step.prompt.matchAll(EDITS_DRAFT)) {
    if (!NEGATED.test(step.prompt.slice(Math.max(0, match.index - 40), match.index))) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
