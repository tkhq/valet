/**
 * The step reference: every field each dag/v1 step type accepts, with its
 * value shape, rendered as Markdown for the `workflows` skill.
 *
 * Agents read the skill before they draft a workflow, and a field the skill
 * never shows is a field they guess. The validator holds the truth in
 * `ALLOWED_KEYS` and its enum tables, so this module renders from those
 * tables and a test holds `STEP_FIELDS` to exactly `ALLOWED_KEYS`. A new
 * field fails that test until it is documented here. The skill embeds the
 * rendered text between markers, and a second test (in the api package,
 * which ships the skill) holds the two equal.
 */
import { allowedIfOperations, type IfDataType } from './if-operations.js';
import type { DagNodeType } from './nodes.js';
import { MAX_STEP_MODEL_CALLS } from './step-budget.js';
import { FOREACH_BODY_TYPES, IF_DATA_TYPES, INPUT_DEFINITION_TYPES, LLM_REASONING_LEVELS } from './validate.js';

/** One field of one step type: whether a save needs it, and its value shape. */
export interface StepField {
  required: boolean;
  shape: string;
}

const list = (values: Iterable<string>): string => [...values].map((value) => `"${value}"`).join(", ");
const DURATION = 'a duration: a number and a unit, such as "30s", "5m", "2h", or "1d"';
const ON_ERROR = '"fail" (default) or "continue"';
const OUTPUT_SCHEMA = "a JSON Schema object; the parsed reply is at `nodes.<id>.result.output`";
const TOOL_SCOPE = "`{ tools?, actions? }`: native tool names and exact `service.action` ids the step may use";
const WAIT = 'omit it to wait for the step to finish; `{ mode: "none" }` starts it and moves on';

/** Every field per step type, in the order the reference lists them. `id` and `type` are common to all. */
export const STEP_FIELDS: Record<DagNodeType, Record<string, StepField>> = {
  trigger: {
    dataSchema: { required: false, shape: `object of run inputs, each \`{ type, required?, default?, description?, enum? }\`; \`type\` is one of ${list(INPUT_DEFINITION_TYPES)}` },
  },
  set: {
    values: { required: true, shape: "object of names to values; a value may be a template" },
  },
  if: {
    conditions: { required: true, shape: "array of at least one `{ left, dataType, operation, right? }` (see Conditions below)" },
    combinator: { required: false, shape: '"and" (default) or "or"' },
  },
  wait: {
    mode: { required: true, shape: '"duration"' },
    duration: { required: true, shape: DURATION },
  },
  approval: {
    prompt: { required: true, shape: "text the approver reads" },
    summary: { required: false, shape: "one line for the approval card" },
    details: { required: false, shape: "extra data the card shows" },
    timeout: { required: false, shape: `${DURATION}; how long the step waits for a decision` },
    onDeny: { required: false, shape: '"fail" (default) or "skip"' },
  },
  session: {
    mode: { required: true, shape: '"start", always' },
    prompt: { required: true, shape: "the task for the agent" },
    title: { required: false, shape: "a title for the agent's session" },
    model: { required: false, shape: "a size tier (`xs`, `s`, `m`, `l`, `xl`) or an approved model id" },
    outputSchema: { required: false, shape: OUTPUT_SCHEMA },
    maxModelCalls: { required: false, shape: `an integer from 1 to ${MAX_STEP_MODEL_CALLS}` },
    wait: { required: false, shape: WAIT },
    toolScope: { required: false, shape: TOOL_SCOPE },
  },
  orchestrator: {
    prompt: { required: true, shape: "the task for the workspace assistant" },
    outputSchema: { required: false, shape: OUTPUT_SCHEMA },
    maxModelCalls: { required: false, shape: `an integer from 1 to ${MAX_STEP_MODEL_CALLS}` },
    wait: { required: false, shape: WAIT },
    toolScope: { required: false, shape: TOOL_SCOPE },
  },
  tool: {
    service: { required: true, shape: 'the plugin service, such as "github"' },
    action: { required: true, shape: 'the action name, such as "create_issue"' },
    params: { required: true, shape: "object of the action's parameters (`{}` when it takes none); a value may be a template" },
    summary: { required: false, shape: "one line that the approval card shows" },
    credential: { required: false, shape: '"auto" (default), "app", or "user"' },
    onError: { required: false, shape: ON_ERROR },
    onDeny: { required: false, shape: '"fail" (default) or "skip", when an approval is denied or times out' },
    approvalTimeout: { required: false, shape: DURATION },
  },
  llm: {
    model: { required: true, shape: "a size tier (`xs`, `s`, `m`, `l`, `xl`) or an approved model id" },
    prompt: { required: true, shape: "the prompt; it may use templates" },
    system: { required: false, shape: "a system prompt" },
    outputSchema: { required: false, shape: OUTPUT_SCHEMA },
    temperature: { required: false, shape: "a number from 0 to 2" },
    maxOutputTokens: { required: false, shape: "a positive integer" },
    reasoning: { required: false, shape: `one of ${list(LLM_REASONING_LEVELS)}; omit it for the owner's default` },
    onError: { required: false, shape: ON_ERROR },
  },
  workflow: {
    workflowId: { required: true, shape: "the id of a workflow with the same owner" },
    input: { required: false, shape: "becomes the called run's `trigger.data`; it may use templates" },
    onError: { required: false, shape: ON_ERROR },
  },
  foreach: {
    items: { required: true, shape: 'a template that resolves to an array, such as "{{nodes.list.result.output.tasks}}"' },
    body: { required: true, shape: `ONE inline step object, never a list of node ids; its type is one of ${list(FOREACH_BODY_TYPES)}; it has its own unique \`id\`, no edges, and no \`onError\`` },
    maxItems: { required: false, shape: "a positive integer; without it, a list of more than 100 entries fails the step" },
    concurrency: { required: false, shape: "an integer from 1 to 10" },
    itemAlias: { required: false, shape: 'the name the body reads the entry by (default "item")' },
    indexAlias: { required: false, shape: 'the name the body reads the position by (default "index")' },
    onItemError: { required: false, shape: '"fail" (default), "skip", or "collect"' },
  },
  stop: {
    outcome: { required: false, shape: '"success" (default) or "failure"; not the run outcome ("completed", "failed", "cancelled")' },
    output: { required: false, shape: "the run's result; it may use templates" },
    message: { required: false, shape: "a message for the run" },
  },
};

/** The start marker the `workflows` skill wraps the generated reference in. */
export const STEP_REFERENCE_START = "<!-- step-reference:start (generated from packages/workflow/src/dag/step-reference.ts; run scripts/workflows/write-step-reference.mjs to update) -->";
/** The end marker of the generated reference. */
export const STEP_REFERENCE_END = "<!-- step-reference:end -->";

/** The reference as Markdown, without the markers. */
export function renderStepReference(): string {
  const lines = [
    "Every step has `id` and `type`. A step accepts only the fields listed for its type, and a save refuses any other field.",
    "",
  ];
  for (const [type, fields] of Object.entries(STEP_FIELDS)) {
    const entries = Object.entries(fields);
    lines.push(`- \`${type}\`:`);
    for (const [name, field] of entries) {
      lines.push(`  - \`${name}\` (${field.required ? "required" : "optional"}): ${field.shape}`);
    }
  }
  lines.push(
    "",
    "**Conditions.** `left` is an expression without braces, such as `nodes.check.result.output.count`. " +
      `\`dataType\` is one of ${list(IF_DATA_TYPES)}. \`right\` is the value to compare, when the operation takes one. ` +
      'An `if` step\'s outgoing edges carry `"fromOutput": "true"` or `"fromOutput": "false"`. The operations for each `dataType`:',
    "",
  );
  for (const dataType of IF_DATA_TYPES) {
    lines.push(`- \`${dataType}\`: ${allowedIfOperations(dataType as IfDataType).map((operation) => `\`${operation}\``).join(", ")}`);
  }
  return lines.join("\n");
}

/** The reference wrapped in its markers, as the skill holds it. */
export function renderStepReferenceBlock(): string {
  return `${STEP_REFERENCE_START}\n${renderStepReference()}\n${STEP_REFERENCE_END}`;
}
