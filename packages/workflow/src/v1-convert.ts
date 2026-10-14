/**
 * Converts the JSON a person copies out of V1, the frozen legacy stack, into
 * dag/v1 definitions. Moving one V1 workflow by hand took half an hour or
 * more, so broken V1 workflows stayed in place.
 *
 * V1 stored a workflow as `{ steps: [...] }` and ran it in
 * `packages/runner/src/workflow-engine.ts`. The conversion follows what that
 * runner did, not what the step types suggest:
 *
 *   - Every `agent_message` in one run went to ONE shared session, and a
 *     `bash` step ran in that same sandbox. A run of consecutive
 *     `agent_message` and `bash` steps therefore becomes one session node
 *     whose prompt lists them in order.
 *   - `agent`, `loop` and `subworkflow` steps did nothing, and so did every
 *     tool name the runner did not handle (`prompt.ts`
 *     `executeWorkflowToolStep`). The runner recorded them and moved on.
 *   - A `conditional` read `{ variable, equals }` from the run's variables.
 *     In V2 those are the trigger input, `trigger.data`.
 *   - V1 rendered no templates. A `{{name}}` in a message reached the agent
 *     as written, so the import keeps it as literal text.
 *
 * What needs a person's judgment becomes a checklist line, never a silent
 * drop. The import dialog shows the checklist and sends it to the
 * workflow's editor conversation.
 */

import type { ApprovalNode, IfCondition, IfNode, SessionNode, WorkflowNode } from './dag/nodes.js';
import type { WorkflowDefinition, WorkflowEdge, WorkflowInputDefinition } from './dag/shape.js';
import { validateWorkflowDefinition } from './dag/validate.js';

export interface V1ImportSchedule {
  name: string;
  cron: string;
  timezone?: string;
}

/** A V1 schedule that sent a prompt to the orchestrator. It starts no workflow. */
export interface V1PromptSchedule extends V1ImportSchedule {
  prompt: string;
}

export interface V1ConvertedWorkflow {
  name: string;
  definition: WorkflowDefinition;
  /** Schedules that start this workflow. */
  schedules: V1ImportSchedule[];
  /** Each item the import could not decide, one line each. */
  checklist: string[];
}

export interface V1Conversion {
  workflows: V1ConvertedWorkflow[];
  promptSchedules: V1PromptSchedule[];
  /** Pasted items that belong to no converted workflow. */
  notes: string[];
}

export type V1ConvertResult = { ok: true; value: V1Conversion } | { ok: false; errors: string[] };

const PASTE_HINT =
  "Paste the JSON that V1's GET /api/workflows returned, and the JSON from GET /api/triggers to bring schedules.";

/**
 * Pasted text → one JSON value. A person who copies both V1 responses
 * pastes two JSON documents one after the other, so this reads a sequence
 * of objects or arrays and returns an array when there is more than one.
 */
export function readV1Paste(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const documents: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (depth > 0 && c === '"') {
      inString = true;
    } else if (c === '{' || c === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (depth < 0) return { ok: false, error: `The pasted text has an extra "${c}". ${PASTE_HINT}` };
      if (depth === 0) {
        const parsed = parseDocument(text.slice(start, i + 1));
        if (!parsed.ok) return parsed;
        documents.push(parsed.value);
      }
    } else if (depth === 0 && !/[\s,]/.test(c)) {
      return {
        ok: false,
        error: `The pasted text has "${excerpt(text.slice(i), 20)}" outside a JSON object. ${PASTE_HINT}`,
      };
    }
  }
  // An open bracket at the end: JSON.parse names the mismatch or the cut.
  if (depth !== 0) return parseDocument(text.slice(start));
  if (documents.length === 0) return { ok: false, error: `The pasted text holds no JSON. ${PASTE_HINT}` };
  return { ok: true, value: documents.length === 1 ? documents[0] : documents };
}

function parseDocument(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `The pasted text is not valid JSON: ${detail}. ${PASTE_HINT}` };
  }
}

/**
 * One parsed value → converted workflows. Accepted shapes, alone or in an
 * array: `{ workflows, triggers }` (the two V1 list responses), `{ workflow }`
 * (one V1 workflow response), a workflow row with `data`, a bare
 * `{ steps }` data object, and trigger rows. Raw database rows also work:
 * their `data` and `config` columns are JSON strings.
 */
export function convertV1Workflows(input: unknown): V1ConvertResult {
  const found: Collected = { workflows: [], triggers: [], errors: [] };
  collect(input, 'The pasted JSON', found);
  if (found.errors.length > 0) return { ok: false, errors: found.errors };

  const claimed = new Set<V1TriggerRow>();
  const workflows: V1ConvertedWorkflow[] = [];
  const errors: string[] = [];
  for (const row of found.workflows) {
    const triggers = found.triggers.filter((t) => !isScheduleToOrchestrator(t) && belongsTo(t, row));
    for (const t of triggers) claimed.add(t);
    const converted = convertWorkflow(row, triggers);
    const result = validateWorkflowDefinition(converted.definition);
    if (!result.ok) {
      errors.push(
        `Valet converted V1 workflow "${converted.name}" to a definition that does not validate: ${result.errors.join('; ')}. Report this as a bug.`,
      );
      continue;
    }
    workflows.push(converted);
  }
  if (errors.length > 0) return { ok: false, errors };

  const promptSchedules: V1PromptSchedule[] = [];
  const notes: string[] = [];
  for (const t of found.triggers) {
    if (claimed.has(t)) continue;
    if (isScheduleToOrchestrator(t)) {
      const prompt = stringField(t.config.prompt);
      const cron = stringField(t.config.cron);
      if (!t.enabled) {
        notes.push(`V1 schedule "${t.name}" was turned off, so the import did not create it.`);
      } else if (prompt === '' || cron === '') {
        notes.push(`V1 schedule "${t.name}" has no prompt or no cron expression, so the import did not create it.`);
      } else {
        promptSchedules.push({ name: t.name, cron, ...timezoneOf(t), prompt });
      }
      continue;
    }
    if (t.config.type === 'manual') continue;
    const owner = t.workflowName ?? t.workflowId ?? 'no workflow';
    notes.push(
      `V1 trigger "${t.name}" belongs to workflow "${owner}", which the pasted JSON does not include. Paste that workflow too.`,
    );
  }

  if (workflows.length === 0 && promptSchedules.length === 0) {
    return { ok: false, errors: [`The pasted JSON holds no V1 workflow. ${PASTE_HINT}`, ...notes] };
  }
  return { ok: true, value: { workflows, promptSchedules, notes } };
}

/** The first message of an imported workflow's editor conversation. */
export function v1ChecklistPrompt(workflow: V1ConvertedWorkflow): string {
  return [
    'Valet imported this workflow from V1 and converted the steps it could map. Finish these items in this workflow. If an item needs information you do not have, ask me.',
    '',
    ...workflow.checklist.map((line) => `- ${line}`),
  ].join('\n');
}

// ─── Collection ───────────────────────────────────────────────────────────

interface V1WorkflowRow {
  id?: string;
  slug?: string;
  name?: string;
  enabled: boolean;
  data: unknown;
}

interface V1TriggerRow {
  name: string;
  enabled: boolean;
  workflowId?: string;
  workflowName?: string;
  config: Record<string, unknown>;
  variableMapping?: Record<string, unknown>;
}

interface Collected {
  workflows: V1WorkflowRow[];
  triggers: V1TriggerRow[];
  errors: string[];
}

function collect(value: unknown, where: string, found: Collected): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => collect(item, `Item ${i + 1} of ${lowerFirst(where)}`, found));
    return;
  }
  if (!isRecord(value)) {
    found.errors.push(`${where} is not an object. ${PASTE_HINT}`);
    return;
  }
  const containerKeys = ['workflows', 'triggers', 'workflow', 'trigger'].filter((key) => value[key] !== undefined);
  if (containerKeys.length > 0) {
    for (const key of containerKeys) collect(value[key], `"${key}" in ${lowerFirst(where)}`, found);
    return;
  }
  if (Array.isArray(value.steps)) {
    found.workflows.push({ name: optionalString(value.name), enabled: true, data: value });
    return;
  }
  if (value.data !== undefined) {
    found.workflows.push({
      id: optionalString(value.id),
      slug: optionalString(value.slug),
      name: optionalString(value.name),
      enabled: value.enabled !== false && value.enabled !== 0,
      data: maybeJson(value.data),
    });
    return;
  }
  const config = maybeJson(value.config);
  if (isRecord(config)) {
    const mapping = maybeJson(value.variableMapping ?? value.variable_mapping);
    found.triggers.push({
      name: optionalString(value.name) ?? 'V1 trigger',
      enabled: value.enabled !== false && value.enabled !== 0,
      workflowId: optionalString(value.workflowId ?? value.workflow_id),
      workflowName: optionalString(value.workflowName ?? value.workflow_name),
      // V1's API returns the type on the row and inside config; keep one.
      config: typeof config.type === 'string' || typeof value.type !== 'string' ? config : { ...config, type: value.type },
      ...(isRecord(mapping) ? { variableMapping: mapping } : {}),
    });
    return;
  }
  found.errors.push(`${where} is neither a V1 workflow nor a V1 trigger. ${PASTE_HINT}`);
}

function belongsTo(trigger: V1TriggerRow, row: V1WorkflowRow): boolean {
  if (trigger.workflowId !== undefined) return trigger.workflowId === row.id || trigger.workflowId === row.slug;
  return trigger.workflowName !== undefined && trigger.workflowName === row.name;
}

function isScheduleToOrchestrator(trigger: V1TriggerRow): boolean {
  return trigger.config.type === 'schedule' && trigger.config.target === 'orchestrator';
}

// ─── One workflow ─────────────────────────────────────────────────────────

/** Where the next node attaches: a node id, and the branch of an `if`. */
interface Tail {
  from: string;
  fromOutput?: 'true' | 'false';
}

/** One message or command waiting to join the current session node. */
interface Pending {
  stepId: string;
  text: string;
  /** Message text with `{{`, which V1 sent as written. */
  braces?: boolean;
}

/** One sequence of steps: its open ends, and the session text not yet written. */
interface Lane {
  tails: Tail[];
  pending: Pending[];
}

interface Build {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  checklist: string[];
  inputs: Record<string, WorkflowInputDefinition>;
  ids: Set<string>;
  /** V1 `outputVariable` name → the V1 step that set it. */
  outputOwners: Map<string, string>;
  /** V1 step id → the V2 node it became. */
  nodeOfStep: Map<string, string>;
  /** Session nodes made from merged messages and commands. */
  messageSessions: string[];
}

function convertWorkflow(row: V1WorkflowRow, triggers: V1TriggerRow[]): V1ConvertedWorkflow {
  const data = row.data;
  const name = row.name ?? (isRecord(data) ? optionalString(data.name) : undefined) ?? 'Imported V1 workflow';
  const b: Build = {
    nodes: [],
    edges: [],
    checklist: [],
    inputs: {},
    ids: new Set(['trigger', 'stop']),
    outputOwners: new Map(),
    nodeOfStep: new Map(),
    messageSessions: [],
  };

  const steps = isRecord(data) && Array.isArray(data.steps) ? data.steps : undefined;
  if (steps === undefined) {
    b.checklist.push('The V1 workflow has no "steps" list, so V1 could not run it. The import made an empty workflow.');
  }
  collectOutputOwners(steps ?? [], (i) => `step[${i}]`, b);

  const lane: Lane = { tails: [{ from: 'trigger' }], pending: [] };
  walk(steps ?? [], (i) => `step[${i}]`, lane, b);
  flush(lane, b);
  b.nodes.push({ id: 'stop', type: 'stop', outcome: 'success' });
  connect(lane.tails, 'stop', b);

  if (b.messageSessions.length > 1) {
    b.checklist.push(
      `V1 sent every agent message and shell command in a run to one shared session. This import made ${b.messageSessions.length} session nodes (${b.messageSessions.map(quote).join(', ')}), and each one starts a new session. If a later node needs what an earlier one did, add that context to its prompt.`,
    );
  }

  const schedules: V1ImportSchedule[] = [];
  for (const t of triggers) convertTrigger(t, row, schedules, b);

  const trigger: WorkflowNode =
    Object.keys(b.inputs).length > 0 ? { id: 'trigger', type: 'trigger', dataSchema: b.inputs } : { id: 'trigger', type: 'trigger' };
  return {
    name,
    definition: { version: 'dag/v1', nodes: [trigger, ...b.nodes], edges: b.edges },
    schedules,
    // Two V1 rows with the same problem read the same; list it once.
    checklist: [...new Set(b.checklist)],
  };
}

function convertTrigger(t: V1TriggerRow, row: V1WorkflowRow, schedules: V1ImportSchedule[], b: Build): void {
  const type = t.config.type;
  if (type === 'manual') return;
  if (type === 'schedule') {
    const cron = stringField(t.config.cron);
    if (cron === '') {
      b.checklist.push(`V1 schedule "${t.name}" has no cron expression, so the import did not create it.`);
    } else if (!t.enabled) {
      b.checklist.push(`V1 schedule "${t.name}" (${cron}) was turned off, so the import did not create it. Add it in Triggers if you still need it.`);
    } else if (!row.enabled) {
      b.checklist.push(`The V1 workflow was turned off, so the import did not create its schedule "${t.name}" (${cron}). Add it in Triggers if you still need it.`);
    } else {
      schedules.push({ name: t.name, cron, ...timezoneOf(t) });
    }
    return;
  }
  if (type === 'webhook') {
    const method = stringField(t.config.method) || 'POST';
    const path = stringField(t.config.path);
    const off = t.enabled ? '' : ' It was turned off in V1, so do this only if you still need it.';
    const getNote = method === 'GET' ? ' The caller sends GET, so change its method too.' : '';
    const mapping =
      t.variableMapping !== undefined && Object.keys(t.variableMapping).length > 0
        ? ` V1 copied request fields into variables (${Object.entries(t.variableMapping)
            .map(([key, from]) => `${key} from ${String(from)}`)
            .join(', ')}). Read those fields from trigger.data instead.`
        : '';
    b.checklist.push(
      `V1 started this workflow from webhook trigger "${t.name}" (${method} ${path}). Create a webhook for this workflow in Triggers, then change the caller to the new URL. V2 webhooks take POST with a JSON body.${getNote}${mapping}${off}`,
    );
    return;
  }
  b.checklist.push(`V1 trigger "${t.name}" has the unknown type ${JSON.stringify(type)}. The import did not create it.`);
}

function walk(steps: unknown[], pathOf: (index: number) => string, lane: Lane, b: Build): void {
  steps.forEach((raw, index) => {
    const path = pathOf(index);
    if (!isRecord(raw)) {
      b.checklist.push(`Item ${path} is not a step object, so V1 refused to run this workflow. The import leaves it out.`);
      return;
    }
    const id = v1StepId(raw, path);
    const type = typeof raw.type === 'string' ? raw.type.trim() : '';
    switch (type) {
      case 'agent_message':
        return addMessage(raw, id, lane, b);
      case 'bash':
        return addCommand(stringField(raw.command), raw.cwd, id, lane, b, 'refused');
      case 'tool':
        return addTool(raw, id, lane, b);
      case 'approval':
        return addApproval(raw, id, lane, b);
      case 'conditional':
        return addConditional(raw, id, path, lane, b);
      case 'parallel':
        return addParallel(raw, id, path, lane, b);
      case 'agent':
        b.checklist.push(
          `Step "${id}" is an "agent" step, which did nothing in V1. The import leaves it out.${goalHint(raw)}`,
        );
        return;
      case 'loop': {
        const inner = Array.isArray(raw.steps) ? raw.steps.length : 0;
        b.checklist.push(
          `Step "${id}" is a "loop" step. V1 did not run it or the ${inner} steps inside it, so the import leaves them out. To repeat work over a list, add a foreach node.`,
        );
        return;
      }
      case 'subworkflow':
        b.checklist.push(
          `Step "${id}" is a "subworkflow" step, which did nothing in V1. The import leaves it out. To call another workflow, import it, then add a workflow node.`,
        );
        return;
      default:
        b.checklist.push(
          `Step "${id}" has the unknown type ${JSON.stringify(raw.type)}, so V1 refused to run this workflow. The import leaves the step out.`,
        );
    }
  });
}

function addMessage(raw: Record<string, unknown>, id: string, lane: Lane, b: Build): void {
  // V1's precedence (`workflow-compiler.ts`): content, then message, then goal.
  const text = (stringField(raw.content, false) || stringField(raw.message, false) || stringField(raw.goal, false)).trim();
  if (text === '') {
    b.checklist.push(`Step "${id}" is an agent message with no text, so V1 refused to run this workflow. The import leaves it out.`);
    return;
  }
  if (raw.interrupt === true) {
    b.checklist.push(
      `Step "${id}" set "interrupt", which stopped the message before it in V1. The import runs every message in order.`,
    );
  }
  lane.pending.push({ stepId: id, text, ...(text.includes('{{') ? { braces: true } : {}) });
}

function addCommand(
  command: string,
  cwd: unknown,
  id: string,
  lane: Lane,
  b: Build,
  ifMissing: 'refused' | 'failed',
): void {
  if (command === '') {
    b.checklist.push(
      ifMissing === 'refused'
        ? `Step "${id}" is a bash step with no command, so V1 refused to run this workflow. The import leaves it out.`
        : `Step "${id}" ran the bash tool with no command, so every V1 run failed at this step. The import leaves it out.`,
    );
    return;
  }
  const dir = stringField(cwd);
  const where = dir === '' ? '' : ` Run it in ${dir}.`;
  lane.pending.push({
    stepId: id,
    text: `Run this shell command.${where} If it fails, stop and report the error.\n\n\`\`\`sh\n${command}\n\`\`\``,
  });
}

function addTool(raw: Record<string, unknown>, id: string, lane: Lane, b: Build): void {
  const tool = stringField(raw.tool);
  const args = isRecord(raw.arguments) ? raw.arguments : {};
  switch (tool) {
    case '':
      b.checklist.push(`Step "${id}" is a tool step with no tool name, so V1 refused to run this workflow. The import leaves it out.`);
      return;
    case 'bash':
      return addCommand(stringField(args.command), args.cwd, id, lane, b, 'failed');
    case 'spawn_session':
      return addSpawnSession(args, id, lane, b);
    case 'send_message': {
      const target = stringField(args.targetSessionId);
      const content = stringField(args.content);
      b.checklist.push(target && content
        ? `Step "${id}" sent "${excerpt(content, 80)}" to V1 session ${target}, which does not exist in V2. The import leaves it out. To send the message somewhere, add a tool node, such as a Slack message.`
        : `Step "${id}" is a send_message step with no target session or content, so it failed in V1. The import leaves it out.`);
      return;
    }
    case 'run_workflow': {
      const target = stringField(args.workflowId) || 'another workflow';
      b.checklist.push(
        `Step "${id}" started V1 workflow ${target}. The import leaves it out. Import that workflow too, then add a workflow node that calls it.`,
      );
      return;
    }
    case 'list_workflows':
    case 'list_workflow_executions':
      b.checklist.push(`Step "${id}" called ${tool}, which only read data. The import leaves it out.`);
      return;
    default:
      b.checklist.push(
        `Step "${id}" called the tool "${tool}", which did nothing in V1. The import leaves it out. If the workflow needs that action, add a tool node.`,
      );
  }
}

function addSpawnSession(args: Record<string, unknown>, id: string, lane: Lane, b: Build): void {
  const task = stringField(args.task);
  const workspace = stringField(args.workspace);
  if (task === '' || workspace === '') {
    b.checklist.push(
      `Step "${id}" called spawn_session without a task or a workspace, so every V1 run failed at this step. The import leaves it out.`,
    );
    return;
  }
  flush(lane, b);
  const nodeId = newId(id, b);
  const title = stringField(args.title);
  const node: SessionNode = {
    id: nodeId,
    type: 'session',
    mode: 'start',
    prompt: literalTemplate(task),
    ...(title === '' ? {} : { title: literalTemplate(title) }),
  };
  addNode(node, lane, b);
  b.nodeOfStep.set(id, nodeId);

  // `workspace` was the child's display label in V1. Only a repository
  // changes what the child works on, and a V2 session node takes none.
  const repo = [stringField(args.repoUrl), stringField(args.branch) || stringField(args.ref)].filter((s) => s !== '');
  if (repo.length > 0) {
    b.checklist.push(
      `Session node "${nodeId}" came from step "${id}", which started its session on ${repo.join(' at ')}. A V2 session node does not clone a repository. Name the repository and the branch in its prompt.`,
    );
  }
  const model = stringField(args.model);
  if (model !== '') {
    b.checklist.push(`Step "${id}" asked for the model "${model}". Choose a model for session node "${nodeId}".`);
  }
}

function addApproval(raw: Record<string, unknown>, id: string, lane: Lane, b: Build): void {
  flush(lane, b);
  const prompt = stringField(raw.prompt) || `Approval required for step ${id}`;
  const node: ApprovalNode = { id: newId(id, b), type: 'approval', prompt: literalTemplate(prompt) };
  addNode(node, lane, b);
  b.nodeOfStep.set(id, node.id);
}

function addConditional(raw: Record<string, unknown>, id: string, path: string, lane: Lane, b: Build): void {
  const branches = { then: Array.isArray(raw.then) ? raw.then : [], else: Array.isArray(raw.else) ? raw.else : [] };
  const condition = readCondition(raw.condition);

  if (condition.kind === 'constant') {
    // V1 decided the branch without reading anything, so only that branch ever ran.
    const taken = condition.value ? 'then' : 'else';
    b.checklist.push(
      `Step "${id}" has the condition ${JSON.stringify(raw.condition ?? null)}, which ${condition.reason}. V1 always ran its "${taken}" steps, so the import keeps only those.`,
    );
    noteRunOrder(id, taken, branches[taken], path, b);
    walk(branches[taken], (i) => `${path}.${taken}[${i}]`, lane, b);
    return;
  }

  flush(lane, b);
  const ifId = newId(id, b);
  const node: IfNode = { id: ifId, type: 'if', conditions: [condition.condition] };
  b.nodes.push(node);
  connect(lane.tails, ifId, b);
  b.nodeOfStep.set(id, ifId);

  const owner = b.outputOwners.get(condition.variable);
  if (owner !== undefined) {
    const nodeId = b.nodeOfStep.get(owner);
    const now = nodeId === undefined ? '' : ` (now node "${nodeId}")`;
    b.checklist.push(
      `If node "${ifId}" reads "${condition.variable}", which V1 set from the output of step "${owner}"${now}. V2 reads a node's output as nodes.<id>.result. Change the condition to read that node.`,
    );
  } else if (b.inputs[condition.variable] === undefined) {
    b.inputs[condition.variable] = { type: condition.inputType, description: 'A V1 workflow variable.' };
  }

  const tails: Tail[] = [];
  for (const key of ['then', 'else'] as const) {
    noteRunOrder(id, key, branches[key], path, b);
    const branch: Lane = { tails: [{ from: ifId, fromOutput: key === 'then' ? 'true' : 'false' }], pending: [] };
    walk(branches[key], (i) => `${path}.${key}[${i}]`, branch, b);
    flush(branch, b);
    tails.push(...branch.tails);
  }
  lane.tails = dedupeTails(tails);
}

function addParallel(raw: Record<string, unknown>, id: string, path: string, lane: Lane, b: Build): void {
  const children = Array.isArray(raw.steps) ? raw.steps : [];
  if (children.length === 0) return;
  flush(lane, b);
  const tails: Tail[] = [];
  children.forEach((child, i) => {
    const branch: Lane = { tails: lane.tails, pending: [] };
    walk([child], () => `${path}.steps[${i}]`, branch, b);
    flush(branch, b);
    tails.push(...branch.tails);
  });
  lane.tails = dedupeTails(tails);
  if (children.length > 1) {
    b.checklist.push(
      `Step "${id}" is a "parallel" step. V1 ran its ${children.length} steps one after another, and V2 runs each branch at the same time. Make sure no branch needs the work of another.`,
    );
  }
}

type ReadCondition =
  | { kind: 'constant'; value: boolean; reason: string }
  | { kind: 'variable'; variable: string; condition: IfCondition; inputType: WorkflowInputDefinition['type'] };

/** `evaluateCondition` in V1's `workflow-engine.ts`, as an if-node condition. */
function readCondition(raw: unknown): ReadCondition {
  if (typeof raw === 'boolean') return { kind: 'constant', value: raw, reason: 'is a constant' };
  if (!isRecord(raw) || typeof raw.variable !== 'string' || raw.variable === '') {
    return { kind: 'constant', value: false, reason: 'V1 could not read, so it was always false' };
  }
  const variable = raw.variable;
  const left = triggerDataPath(variable);
  if (!Object.prototype.hasOwnProperty.call(raw, 'equals')) {
    // V1 tested `Boolean(value)`. A boolean `equals true` is the same test.
    return {
      kind: 'variable',
      variable,
      condition: { left, dataType: 'boolean', operation: 'equals', right: true },
      inputType: 'boolean',
    };
  }
  const expected = raw.equals;
  if (typeof expected === 'string') {
    return { kind: 'variable', variable, condition: { left, dataType: 'string', operation: 'equals', right: expected }, inputType: 'string' };
  }
  if (typeof expected === 'number') {
    return { kind: 'variable', variable, condition: { left, dataType: 'number', operation: 'equals', right: expected }, inputType: 'number' };
  }
  if (typeof expected === 'boolean') {
    // isTrue/isFalse compare strictly, as V1's `===` did.
    return {
      kind: 'variable',
      variable,
      condition: { left, dataType: 'boolean', operation: expected ? 'isTrue' : 'isFalse' },
      inputType: 'boolean',
    };
  }
  return { kind: 'constant', value: false, reason: 'compares to a value V1 never matched' };
}

/** V1 ran nested steps sorted by id (`asStepArray`), not in the listed order. */
function noteRunOrder(id: string, key: string, steps: unknown[], path: string, b: Build): void {
  const ids = steps.flatMap((s, i) => (isRecord(s) ? [v1StepId(s, `${path}.${key}[${i}]`)] : []));
  const sorted = [...ids].sort((x, y) => x.localeCompare(y));
  if (ids.every((value, i) => value === sorted[i])) return;
  b.checklist.push(
    `V1 ran the "${key}" steps of step "${id}" in id order (${sorted.map(quote).join(', ')}), not in the order listed. The import keeps the listed order. Make sure that order is correct.`,
  );
}

function collectOutputOwners(steps: unknown[], pathOf: (index: number) => string, b: Build): void {
  steps.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const path = pathOf(index);
    const name = stringField(raw.outputVariable);
    if (name !== '' && !b.outputOwners.has(name)) b.outputOwners.set(name, v1StepId(raw, path));
    for (const key of ['then', 'else', 'steps'] as const) {
      const nested = raw[key];
      if (Array.isArray(nested)) collectOutputOwners(nested, (i) => `${path}.${key}[${i}]`, b);
    }
  });
}

// ─── Graph helpers ────────────────────────────────────────────────────────

/** Write the waiting messages and commands as one session node. */
function flush(lane: Lane, b: Build): void {
  if (lane.pending.length === 0) return;
  const first = lane.pending[0]!;
  const prompt =
    lane.pending.length === 1
      ? first.text
      : ['Complete these steps in order.', ...lane.pending.map((p, i) => `${i + 1}. ${p.text}`)].join('\n\n');
  const node: SessionNode = { id: newId(first.stepId, b), type: 'session', mode: 'start', prompt: literalTemplate(prompt) };
  addNode(node, lane, b);
  for (const p of lane.pending) b.nodeOfStep.set(p.stepId, node.id);
  b.messageSessions.push(node.id);
  if (lane.pending.some((p) => p.braces === true)) {
    b.checklist.push(
      `Session node "${node.id}" has text in {{ }}. V1 sent it to the agent as written, and the import keeps it as written. To fill in a value when the workflow runs, change it to a V2 template such as {{trigger.data.name}}.`,
    );
  }
  lane.pending = [];
}

function addNode(node: WorkflowNode, lane: Lane, b: Build): void {
  b.nodes.push(node);
  connect(lane.tails, node.id, b);
  lane.tails = [{ from: node.id }];
}

function connect(tails: Tail[], to: string, b: Build): void {
  for (const t of tails) {
    b.edges.push(t.fromOutput === undefined ? { from: t.from, to } : { from: t.from, to, fromOutput: t.fromOutput });
  }
}

/** A branch that adds no node hands back the tails it started with, so two
 * such branches would otherwise write the same edge twice. */
function dedupeTails(tails: Tail[]): Tail[] {
  const seen = new Set<string>();
  return tails.filter((t) => {
    const key = `${t.from} ${t.fromOutput ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A dag/v1 node id made from a V1 step id: `step[0]_then[1]` → `step-0_then-1`. */
function newId(stepId: string, b: Build): string {
  const base =
    stepId
      .replace(/\[(\d+)\]/g, '-$1')
      .replace(/[^a-z0-9_-]+/gi, '-')
      .replace(/^[^a-z0-9]+/i, '')
      .replace(/[-_]+$/, '')
      .slice(0, 56) || 'step';
  let id = base;
  for (let n = 2; b.ids.has(id); n++) id = `${base}-${n}`;
  b.ids.add(id);
  return id;
}

/** V1's own id rule (`normalizeStep`): the given id, else the step's path. */
function v1StepId(step: Record<string, unknown>, path: string): string {
  const given = stringField(step.id);
  return given === '' ? path.replace(/\./g, '_') : given;
}

function triggerDataPath(variable: string): string {
  return /^[A-Za-z0-9_]+$/.test(variable) ? `trigger.data.${variable}` : `trigger.data[${JSON.stringify(variable)}]`;
}

/**
 * Text that renders as itself. dag/v1 has no escape for `{{`, so each one
 * becomes a template whose only content is the string literal "{{".
 */
function literalTemplate(text: string): string {
  return text.split('{{').join('{{"{{"}}');
}

function goalHint(raw: Record<string, unknown>): string {
  const goal = stringField(raw.goal);
  return goal === '' ? '' : ` If you want its goal ("${excerpt(goal, 80)}") done, add a session node for it.`;
}

function timezoneOf(t: V1TriggerRow): { timezone?: string } {
  const timezone = stringField(t.config.timezone);
  return timezone === '' ? {} : { timezone };
}

// ─── Value helpers ────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, trim = true): string {
  if (typeof value !== 'string') return '';
  return trim ? value.trim() : value;
}

function optionalString(value: unknown): string | undefined {
  const s = stringField(value);
  return s === '' ? undefined : s;
}

/** A database row stores `data` and `config` as JSON text. */
function maybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
}

function quote(value: string): string {
  return `"${value}"`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
