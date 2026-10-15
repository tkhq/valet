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
 *     whose prompt lists them in order, unless V1 waited for some of them
 *     and not for others (`addPending`).
 *   - V1 waited for an `agent_message` only when it set `await_response`,
 *     and then only up to a time limit. Without it, V1 sent the message
 *     with `prompt_async` and went on at once (`executeWorkflowAgentStep`
 *     in `prompt.ts`).
 *   - `agent`, `loop` and `subworkflow` steps did nothing, and so did every
 *     tool name the runner did not handle (`prompt.ts`
 *     `executeWorkflowToolStep`). The runner recorded them and moved on.
 *   - A `conditional` read `{ variable, equals }` from the run's variables.
 *     In V2 those are the trigger input, `trigger.data`.
 *   - V1 ran the steps inside a `conditional` or a `parallel` one after
 *     another, sorted by id (`asStepArray`). A denied approval among them
 *     skipped the rest of that list, and the run went on after the step.
 *     A denied approval anywhere else cancelled the run.
 *   - V1 cancelled a run that still waited for an approval 24 hours after
 *     it started (`expireWaitingApprovalExecutions` in
 *     `packages/worker/src/index.ts`).
 *   - V1 failed a run at its 51st step (`maxSteps` in `executeSteps`).
 *   - V1 rendered no templates. A `{{name}}` in a message reached the agent
 *     as written, so the import keeps it as literal text.
 *
 * What needs a person's judgment becomes a checklist line, never a silent
 * drop. The import dialog shows the checklist and sends it to the
 * workflow's editor conversation. When the import cannot do exactly what
 * V1 did, the line is a required decision (`requireDecision`).
 *
 * The import creates no schedules. V1 matched cron expressions itself, and
 * V2 reads many of them differently or refuses them. Each V1 schedule
 * becomes a line that tells the person to add it in Triggers after the
 * other items, with the time zone V1 used (UTC when it named none). If V2
 * reads the expression differently (`v1CronDifference`), the line says what
 * V1 did and tells the person not to copy the expression.
 */

import type { ApprovalNode, IfCondition, IfNode, SessionNode, WorkflowNode } from './dag/nodes.js';
import type { WorkflowDefinition, WorkflowEdge, WorkflowInputDefinition } from './dag/shape.js';
import { validateWorkflowDefinition } from './dag/validate.js';

export interface V1ConvertedWorkflow {
  name: string;
  definition: WorkflowDefinition;
  /** Each item the import could not decide, one line each. The V1
   * schedules of the workflow come last. */
  checklist: string[];
}

export interface V1Conversion {
  workflows: V1ConvertedWorkflow[];
  /** Pasted items that belong to no converted workflow, such as the V1
   * schedules that sent a prompt to the orchestrator. */
  notes: string[];
}

export type V1ConvertResult = { ok: true; value: V1Conversion } | { ok: false; errors: string[] };

const PASTE_HINT =
  "Paste the JSON that V1's GET /api/workflows returned. To list the V1 schedules and webhooks too, paste the JSON from GET /api/triggers after it.";

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

  const notes: string[] = [];
  for (const t of found.triggers) {
    if (claimed.has(t)) continue;
    if (isScheduleToOrchestrator(t)) {
      const prompt = stringField(t.config.prompt);
      const cron = stringField(t.config.cron);
      if (prompt === '' || cron === '') {
        notes.push(`V1 schedule "${t.name}" has no prompt or no cron expression, so the import did not create it.`);
      } else if (!t.enabled) {
        notes.push(`${scheduleLabel(t, cron)} sent the prompt "${prompt}" to the assistant and was turned off.${cronWarning(cron)} If you still need it, add it in Triggers after you finish the checklists of the imported workflows.${zoneStep(t)}`);
      } else {
        notes.push(`The import creates no schedules, so it did not create ${scheduleLabel(t, cron)}, which sent the prompt "${prompt}" to the assistant.${cronWarning(cron)} Add it in Triggers with the same prompt after you finish the checklists of the imported workflows.${zoneStep(t)}`);
      }
      continue;
    }
    if (t.config.type === 'manual') continue;
    const owner = t.workflowName ?? t.workflowId ?? 'no workflow';
    notes.push(
      `V1 trigger "${t.name}" belongs to workflow "${owner}", which the pasted JSON does not include. Paste that workflow too.`,
    );
  }

  if (workflows.length === 0) {
    return { ok: false, errors: [`The pasted JSON holds no V1 workflow. ${PASTE_HINT}`, ...notes] };
  }
  return { ok: true, value: { workflows, notes } };
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
  /** A shell command, whose failure stopped the V1 run. */
  command?: boolean;
  /** V1 waited for this step before the next one: a command, or a message
   * with `await_response`. */
  waits: boolean;
  /** For a message with `await_response`: how long V1 waited for the
   * answer, in milliseconds. */
  awaitMs?: number;
}

/** A V1 step and its V1 path, such as `step[2].then[0]`. */
interface Located {
  raw: unknown;
  path: string;
}

/** One sequence of steps: its open ends, and the session text not yet written. */
interface Lane {
  tails: Tail[];
  pending: Pending[];
}

/** The innermost `parallel` or `conditional` step around the steps being
 * walked, and the `false` tails of the approvals inside it. A V1 denial
 * there skipped the rest of the list and went on after the step. */
interface Scope {
  stepId: string;
  denials: Tail[];
}

interface Build {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  checklist: string[];
  ids: Set<string>;
  /** V1 `outputVariable` name → the V1 step that set it. */
  outputOwners: Map<string, string>;
  /** V1 step id → the V2 node it became. */
  nodeOfStep: Map<string, string>;
  /** Session nodes made from merged messages and commands. */
  messageSessions: string[];
  /** Trigger variable → the if nodes that read it and the types they
   * compare it to. `any` marks a truthiness test, which took any type. */
  variables: Map<string, { ifIds: string[]; types: Set<WorkflowInputDefinition['type'] | 'any'> }>;
  /** True after a required decision. The schedule lines then say why the
   * workflow must not run on a schedule yet. */
  differs: boolean;
}

function convertWorkflow(row: V1WorkflowRow, triggers: V1TriggerRow[]): V1ConvertedWorkflow {
  const data = row.data;
  const name = row.name ?? (isRecord(data) ? optionalString(data.name) : undefined) ?? 'Imported V1 workflow';
  const b: Build = {
    nodes: [],
    edges: [],
    checklist: [],
    ids: new Set(['trigger', 'stop']),
    outputOwners: new Map(),
    nodeOfStep: new Map(),
    messageSessions: [],
    variables: new Map(),
    differs: false,
  };

  const steps = isRecord(data) && Array.isArray(data.steps) ? data.steps : undefined;
  if (steps === undefined) {
    requireDecision(b, 'The V1 workflow has no "steps" list, so V1 could not run it. The import made an empty workflow.');
  }
  const top = (i: number) => `step[${i}]`;
  collectRefusals(steps ?? [], top, b);
  collectOutputOwners(steps ?? [], top, b);
  const visits = v1StepVisits(steps ?? []);
  if (visits > V1_MAX_STEPS) {
    requireDecision(
      b,
      `A V1 run of this workflow can reach ${visits} steps. V1 counted every step it ran, including each conditional and parallel step, and failed a run at step ${V1_MAX_STEPS + 1} with the error max_steps_exceeded:${V1_MAX_STEPS}. V2 has no step limit, so it runs the steps that V1 never reached. Decide which steps this workflow must run.`,
    );
  }

  const lane: Lane = { tails: [{ from: 'trigger' }], pending: [] };
  walk(located(steps ?? [], top), lane, b);
  flush(lane, b);
  b.nodes.push({ id: 'stop', type: 'stop', outcome: 'success' });
  connect(lane.tails, 'stop', b);
  describeInputs(b);

  if (b.messageSessions.length > 1) {
    // The shared V1 session took a message only after it finished the one
    // before it. Separate sessions lose that order for a node that does not wait.
    const noWait = b.messageSessions.filter((id) => b.nodes.some((n) => n.id === id && n.type === 'session' && n.wait?.mode === 'none'));
    const order =
      noWait.length === 0
        ? ''
        : ` V1's shared session did each message only after the one before it. A session node that does not wait (${noWait.map(quote).join(', ')}) lets the session nodes after it start before its work is done.`;
    requireDecision(
      b,
      `V1 sent every agent message and shell command in a run to one shared session. This import made ${b.messageSessions.length} session nodes (${b.messageSessions.map(quote).join(', ')}), and each one starts a new session. If a later node needs what an earlier one did, add that context to its prompt.${order}`,
    );
  }

  const approvals = b.nodes.filter((n) => n.type === 'approval').map((n) => n.id);
  if (approvals.length > 1) {
    // V1's deadline ran from the start of the run (`getTimedOutApprovals`),
    // not from each approval. V2 has no deadline for a whole run.
    requireDecision(
      b,
      `V1 cancelled a run that still waited for an approval 24 hours after the run started. This import made ${approvals.length} approval nodes (${approvals.map(quote).join(', ')}), and V2 gives each one its own 24-hour timeout from the time the run reaches it. A run that passes more than one approval can therefore wait longer than V1 allowed. Decide the timeout of each approval node.`,
    );
  }

  const schedules = triggers.filter((t) => t.config.type === 'schedule');
  for (const t of triggers) {
    if (t.config.type !== 'schedule') convertTrigger(t, b);
  }
  // The schedule lines come last, because they wait for every other item.
  const after = b.checklist.length > 0 ? ' after you finish the other items in this list' : '';
  for (const t of schedules) b.checklist.push(scheduleLine(t, row, after, b));

  const trigger: WorkflowNode = { id: 'trigger', type: 'trigger' };
  return {
    name,
    definition: { version: 'dag/v1', nodes: [trigger, ...b.nodes], edges: b.edges },
    // Two V1 rows with the same problem read the same; list it once.
    checklist: [...new Set(b.checklist)],
  };
}

/** The line for one V1 schedule of this workflow. The import creates no
 * schedules, so the line names it for the person to add in Triggers. */
function scheduleLine(t: V1TriggerRow, row: V1WorkflowRow, after: string, b: Build): string {
  const cron = stringField(t.config.cron);
  if (cron === '') return `V1 schedule "${t.name}" has no cron expression, so the import did not create it.`;
  const label = scheduleLabel(t, cron);
  const steps = (add: string) => `${cronWarning(cron)} ${add}${after}.${zoneStep(t)}`;
  if (!t.enabled) return `${label} was turned off.${steps('If you still need it, add it in Triggers')}`;
  if (!row.enabled) return `The V1 workflow was turned off, so ${label} did not run.${steps('If you still need it, add it in Triggers')}`;
  const why = b.differs ? ' This workflow does not do exactly what it did in V1, so it must not run on a schedule yet.' : '';
  return `The import creates no schedules, so it did not create ${label}.${why}${steps('Add it in Triggers')}`;
}

/** `V1 schedule "Nightly" (0 2 * * *, UTC)`. V1 used UTC for a schedule
 * that named no time zone (`cronMatchesNow`). */
function scheduleLabel(t: V1TriggerRow, cron: string): string {
  return `V1 schedule "${t.name}" (${cron}, ${stringField(t.config.timezone) || 'UTC'})`;
}

/** The time zone to set in Triggers. The Triggers form starts with the
 * browser's time zone, so the line names UTC too. */
function zoneStep(t: V1TriggerRow): string {
  const timezone = stringField(t.config.timezone);
  return timezone === ''
    ? ' Set its time zone to UTC. V1 used UTC because the schedule named no time zone.'
    : ` Set its time zone to ${timezone}.`;
}

/** A required decision for a cron expression that V2 reads differently,
 * or nothing when V2 reads it as V1 did. */
function cronWarning(cron: string): string {
  const difference = v1CronDifference(cron);
  if (difference === undefined) return '';
  return ` V2 reads its cron expression differently from V1. ${difference} Do not add the expression as written. Decide when the schedule must run, and write an expression for those times.`;
}

const CRON_FIELDS = ['minute', 'hour', 'day of the month', 'month', 'day of the week'] as const;

/**
 * What V1 did with `cron` where V2's cron-parser reads it differently, or
 * undefined when the two agree. V1 matched cron itself (`cronMatchesNow` in
 * `packages/worker/src/index.ts`): it read only numbers, ranges and steps,
 * and a day had to match both day fields. Any part outside the forms both
 * read the same way is reported, even when its V1 meaning is not known.
 */
function v1CronDifference(cron: string): string | undefined {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return `V1 read only expressions with 5 fields, so it never ran this schedule.`;
  const sentences: string[] = [];
  if (fields[2] !== '*' && fields[4] !== '*') {
    sentences.push(
      'V1 ran it only on a day that matched both the day of the month and the day of the week. V2 runs it on a day that matches either one.',
    );
  }
  const unread: string[] = [];
  const other: string[] = [];
  fields.forEach((field, i) => {
    for (const part of field.split(',')) {
      const step = /^\*\/(\d+)$/.exec(part);
      if (part !== '*' && !/\d/.test(part)) unread.push(quote(part));
      else if (step !== null && Number(step[1]) > 1 && (i === 2 || i === 3)) {
        // V1 tested `value % step === 0`. cron-parser counts from 1 in these fields.
        sentences.push(
          `In the ${CRON_FIELDS[i]}, V1 read "${part}" as each value that divides by ${step[1]}. V2 counts from 1.`,
        );
      } else if (!/^(\*|\d+|\d+-\d+(\/\d+)?|\*\/\d+)$/.test(part)) other.push(quote(part));
    }
  });
  if (unread.length > 0) {
    const never = fields.some((field) => field.split(',').every((part) => part !== '*' && !/\d/.test(part)));
    sentences.push(`V1 read only numbers, so it never matched ${unread.join(', ')}.${never ? ' V1 never ran this schedule.' : ''}`);
  }
  if (other.length > 0) sentences.push(`V1 and V2 read ${other.join(', ')} differently.`);
  return sentences.length > 0 ? sentences.join(' ') : undefined;
}

function convertTrigger(t: V1TriggerRow, b: Build): void {
  const type = t.config.type;
  const entries = Object.entries(t.variableMapping ?? {});
  const fields = mappingText(entries);
  if (type === 'manual') {
    // V1 ran a manual trigger with the request fields copied into the
    // variables (`runTrigger`). V2 has no such copy, so a condition reads
    // the variable name from the run input.
    const first = entries[0]?.[0];
    if (first !== undefined) {
      requireDecision(
        b,
        `V1 manual trigger "${t.name}" copied request fields into variables (${fields}). V2 does not copy them: each condition reads the variable name from the run input, such as ${triggerDataPath(first)}. Change the callers to send the variable names, or change the conditions to read the request fields.`,
      );
    }
    return;
  }
  if (type === 'webhook') {
    const method = stringField(t.config.method) || 'POST';
    const path = stringField(t.config.path);
    const off = t.enabled ? '' : ' It was turned off in V1, so do this only if you still need it.';
    const getNote = method === 'GET' ? ' The caller sends GET, so change its method too.' : '';
    // V1 overwrote these mappings with built-in objects. Other mappings
    // followed dot-separated payload paths into literal variable names.
    const builtins = {
      _payload: 'the whole request payload, including query parameters',
      _trigger: 'webhook metadata (type, triggerId, path, method and timestamp)',
    };
    const mapped = entries.filter(([key]) => !Object.prototype.hasOwnProperty.call(builtins, key));
    const same = mapped.filter(([key, from]) => !key.includes('.') && from === `$.${key}`);
    const renamed = mapped.filter(([key, from]) => key.includes('.') || from !== `$.${key}`);
    const mapping =
      same.length === 0
        ? ''
        : ` V1 copied request fields into variables of the same name (${mappingText(same)}). V2 reads them from trigger.data the same way.`;
    b.checklist.push(
      `V1 started this workflow from webhook trigger "${t.name}" (${method} ${path}). Create a webhook for this workflow in Triggers, then change the caller to the new URL. V2 webhooks take POST with a JSON body.${getNote}${mapping}${off}`,
    );
    const firstRenamed = renamed[0]?.[0];
    if (firstRenamed !== undefined) {
      requireDecision(
        b,
        `V1 webhook trigger "${t.name}" copied request fields into variables (${mappingText(renamed)}). V1 read each path one field at a time. A V2 webhook does not copy them: each condition reads the variable name from the JSON body, such as ${triggerDataPath(firstRenamed)}. Change the caller to send the variable names, or change the conditions to read the request fields.`,
      );
    }
    for (const [variable, meaning] of Object.entries(builtins)) {
      if (!b.variables.has(variable)) continue;
      requireDecision(
        b,
        `V1 webhook trigger "${t.name}": V1 set "${variable}" to ${meaning}, after applying the variable mapping. An object value is truthy. A V2 webhook does not set this variable: its conditions read ${triggerDataPath(variable)} from the posted JSON instead. Change these conditions to read the V2 trigger, or change the caller to supply the required value.`,
      );
    }
    // V1 set only mapped variables and built-ins (`webhooks.ts`). A V2
    // webhook passes the whole body.
    const unset = [...b.variables.keys()].filter((v) =>
      !Object.prototype.hasOwnProperty.call(builtins, v) && !Object.prototype.hasOwnProperty.call(t.variableMapping ?? {}, v));
    if (unset.length > 0) {
      const them = unset.length === 1 ? 'it' : 'them';
      requireDecision(
        b,
        `V1 webhook trigger "${t.name}" set only mapped variables from the request${fields === '' ? ', and it has no mapping' : ` (${fields})`}. V1 left ${unset.map(quote).join(', ')} unset, so each condition on ${them} took its false branch. A V2 webhook passes the JSON body as trigger.data, so these conditions read ${unset.map(triggerDataPath).join(', ')} from the request. Decide whether the conditions must read the request, then change the conditions or the caller.`,
      );
    }
    return;
  }
  b.checklist.push(`V1 trigger "${t.name}" has the unknown type ${JSON.stringify(type)}. The import did not create it.`);
}

/** `environment from $.target, repo from $.repo`, or '' for no mapping. */
function mappingText(entries: [string, unknown][]): string {
  return entries.map(([key, from]) => `${key} from ${String(from)}`).join(', ');
}

/** Builds nodes from steps. A step V1's compiler refused is left out
 * without a line, because `collectRefusals` already listed it. `scope` is
 * undefined for the top-level steps. */
function walk(steps: Located[], lane: Lane, b: Build, scope?: Scope): void {
  steps.forEach(({ raw, path }) => {
    if (!isRecord(raw)) return;
    const id = v1StepId(raw, path);
    const type = typeof raw.type === 'string' ? raw.type.trim() : '';
    switch (type) {
      case 'agent_message':
        return addMessage(raw, id, lane, b);
      case 'bash':
        return addCommand(stringField(raw.command), raw.cwd, id, lane, b);
      case 'tool':
        return addTool(raw, id, lane, b);
      case 'approval':
        return addApproval(raw, id, lane, b, scope);
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
    }
  });
}

function addMessage(raw: Record<string, unknown>, id: string, lane: Lane, b: Build): void {
  const text = v1MessageText(raw);
  if (text === '') {
    if ((stringField(raw.content, false) || stringField(raw.message, false) || stringField(raw.goal, false)).trim() !== '') {
      requireDecision(
        b,
        `Step "${id}": V1 selected an empty message field before its fallback, so V1 failed a run at this step. The import leaves the step out. Decide whether later steps must run, then change this message or the workflow.`,
      );
    }
    return;
  }
  if (raw.interrupt === true) {
    requireDecision(
      b,
      `Step "${id}" set "interrupt", which stopped the message before it in V1. The import runs every message in order.`,
    );
  }
  // V1's runner reads either spelling as true (`executeWorkflowAgentStep`).
  const awaitMs = raw.await_response === true || raw.awaitResponse === true ? v1AwaitMs(raw) : undefined;
  addPending(
    {
      stepId: id,
      text,
      ...(text.includes('{{') ? { braces: true } : {}),
      waits: awaitMs !== undefined,
      ...(awaitMs === undefined ? {} : { awaitMs }),
    },
    lane,
    b,
  );
}

/** V1's runner chose the first string even when it was empty. Its compiler
 * instead checked the first nonempty string (`collectRefusals`). */
function v1MessageText(raw: Record<string, unknown>): string {
  return (typeof raw.content === 'string'
    ? raw.content
    : typeof raw.message === 'string'
      ? raw.message
      : stringField(raw.goal, false)).trim();
}

/** How long V1 waited for an answer (`executeWorkflowAgentStep`): the
 * step's `await_timeout_ms`, 2 minutes when unset, 15 minutes at most. */
function v1AwaitMs(raw: Record<string, unknown>): number {
  const set =
    typeof raw.await_timeout_ms === 'number'
      ? raw.await_timeout_ms
      : typeof raw.awaitTimeoutMs === 'number'
        ? raw.awaitTimeoutMs
        : 120_000;
  return Math.max(1_000, Math.min(set, 900_000));
}

function addCommand(command: string, cwd: unknown, id: string, lane: Lane, b: Build): void {
  if (command === '') return;
  const dir = stringField(cwd);
  const where = dir === '' ? '' : ` Run it in ${dir}.`;
  addPending(
    {
      stepId: id,
      text: `Run this shell command.${where} If it fails, stop and report the error.\n\n\`\`\`sh\n${command}\n\`\`\``,
      command: true,
      waits: true,
    },
    lane,
    b,
  );
}

/**
 * Adds a message or a command to the session text that waits for the next
 * node. A session node has one wait mode, but V1 waited for some steps and
 * not for others. So the import starts a new node where one wait mode
 * cannot do what V1 did:
 *
 *   - A message that V1 did not wait for, after a step that V1 waited for.
 *     V1 went on at once after that message.
 *   - A command after a message that V1 did not wait for. V1 ran the
 *     command in the runner, beside the agent's work, and waited only for
 *     the command.
 *
 * A message with `await_response` joins the messages before it. V1 waited
 * until the shared session was idle, so it waited for them too. A new node
 * is a new session, and the shared-session line of the checklist says so.
 */
function addPending(item: Pending, lane: Lane, b: Build): void {
  const last = lane.pending.at(-1);
  if (last !== undefined && (last.waits ? !item.waits : item.command === true)) flush(lane, b);
  lane.pending.push(item);
}

function addTool(raw: Record<string, unknown>, id: string, lane: Lane, b: Build): void {
  const tool = stringField(raw.tool, false);
  const args = isRecord(raw.arguments) ? raw.arguments : {};
  switch (tool) {
    case '':
      return;
    case 'bash': {
      const command = stringField(args.command);
      if (command === '') {
        requireDecision(b, `Step "${id}" ran the bash tool with no command, so every V1 run failed at this step. The import leaves it out.`);
        return;
      }
      return addCommand(command, args.cwd, id, lane, b);
    }
    case 'spawn_session':
      return addSpawnSession(args, id, lane, b);
    case 'send_message': {
      const target = stringField(args.targetSessionId);
      const content = stringField(args.content);
      requireDecision(b, target && content
        ? `Step "${id}" sent "${excerpt(content, 80)}" to V1 session ${target}, which does not exist in V2. The import leaves it out. To send the message somewhere, add a tool node, such as a Slack message.`
        : `Step "${id}" is a send_message step with no target session or content, so it failed in V1. The import leaves it out.`);
      return;
    }
    case 'run_workflow': {
      const target = stringField(args.workflowId) || 'another workflow';
      requireDecision(
        b,
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
    requireDecision(
      b,
      `Step "${id}" called spawn_session without a task or a workspace, so every V1 run failed at this step. The import leaves it out.`,
    );
    return;
  }
  flush(lane, b);
  const nodeId = newId(id, b);
  const title = stringField(args.title);
  // V1 went on to the next step when the session started, and the session
  // ran beside the later steps. Wait mode `none` does the same. An unset
  // mode waits until the session is idle (`nodes/submission-node.ts`).
  const node: SessionNode = {
    id: nodeId,
    type: 'session',
    mode: 'start',
    prompt: literalTemplate(task),
    ...(title === '' ? {} : { title: literalTemplate(title) }),
    wait: { mode: 'none' },
  };
  addNode(node, lane, b);
  b.nodeOfStep.set(id, nodeId);

  // `workspace` was the child's display label in V1. Only a repository
  // changes what the child works on, and a V2 session node takes none.
  const repo = [stringField(args.repoUrl), stringField(args.branch) || stringField(args.ref)].filter((s) => s !== '');
  if (repo.length > 0) {
    requireDecision(
      b,
      `Session node "${nodeId}" came from step "${id}", which started its session on ${repo.join(' at ')}. A V2 session node does not clone a repository. Name the repository and the branch in its prompt.`,
    );
  }
  const model = stringField(args.model);
  if (model !== '') {
    requireDecision(b, `Step "${id}" asked for the model "${model}". Choose a model for session node "${nodeId}".`);
  }
}

/** V1 cancelled a run that waited 24 hours for an approval. A timeout
 * acts as a denial in V2 (`nodes/approval.ts`). */
const V1_APPROVAL_TIMEOUT = '24h';

function addApproval(raw: Record<string, unknown>, id: string, lane: Lane, b: Build, scope: Scope | undefined): void {
  flush(lane, b);
  const prompt = stringField(raw.prompt) || `Approval required for step ${id}`;
  const node: ApprovalNode = { id: newId(id, b), type: 'approval', prompt: literalTemplate(prompt), timeout: V1_APPROVAL_TIMEOUT };
  b.nodeOfStep.set(id, node.id);
  if (scope === undefined) {
    // A denial fails the node and stops the run, as V1 cancelled it.
    addNode(node, lane, b);
    return;
  }
  // A denial completes the node with `approved: false`. The `true` edge
  // goes on in the list, and the `false` edge goes past the scope step.
  node.onDeny = 'skip';
  addNode(node, lane, b);
  lane.tails = [{ from: node.id, fromOutput: 'true' }];
  scope.denials.push({ from: node.id, fromOutput: 'false' });
  requireDecision(
    b,
    `Approval node "${node.id}" is inside step "${scope.stepId}". If the run still waited for it 24 hours after the run started, V1 cancelled the run. Here a timeout acts as a denial, so the run goes on after step "${scope.stepId}". Decide whether a timeout must stop the run.`,
  );
}

/**
 * Leaves trigger variables undeclared to preserve V1 input admission.
 * V1 compared with `===` and accepted any type, including null. Even one
 * comparison cannot establish the variable's type. A checklist item asks
 * the person to choose any restrictions needed for the manual run form.
 */
function describeInputs(b: Build): void {
  for (const [variable, { ifIds, types }] of b.variables) {
    // A truthiness test already has its line (`addConditional`).
    if (types.has('any')) continue;
    const [type, ...others] = types;
    if (type !== undefined && type !== 'any' && others.length === 0) {
      b.checklist.push(
        `The if nodes ${ifIds.map(quote).join(', ')} compare "${variable}" to ${type} values. V1 took a value of any type, including null, so the import leaves "${variable}" off the run form. To set it in a run you start by hand, add it as a trigger input. Choose its type after you check the callers. A trigger input has one type, so it rejects values of other types and null.`,
      );
      continue;
    }
    b.checklist.push(
      `The if nodes ${ifIds.map(quote).join(', ')} compare "${variable}" to values of more than one type (${[...types].join(', ')}). V1 took a value of any type, so the import does not add "${variable}" to the run form. To set it in a run you start by hand, add it as a trigger input. A trigger input has one type, so a run then cannot pass a value of another type.`,
    );
  }
}

/** Ends a scope: a denial inside it led to whatever follows the scope step. */
function leaveScope(scope: Scope, lane: Lane, b: Build): void {
  if (scope.denials.length === 0) return;
  // The waiting text belongs to the scope's list, which a denial skipped.
  flush(lane, b);
  // An approval that ends the list goes on either way: one plain edge.
  const last = new Set(lane.tails.filter((t) => scope.denials.some((d) => d.from === t.from)).map((t) => t.from));
  lane.tails = dedupeTails([
    ...lane.tails.map((t) => (last.has(t.from) ? { from: t.from } : t)),
    ...scope.denials.filter((d) => !last.has(d.from)),
  ]);
}

function addConditional(raw: Record<string, unknown>, id: string, path: string, lane: Lane, b: Build): void {
  const branches = { then: Array.isArray(raw.then) ? raw.then : [], else: Array.isArray(raw.else) ? raw.else : [] };
  const condition = readCondition(raw.condition);

  const scope: Scope = { stepId: id, denials: [] };
  if (condition.kind === 'constant') {
    // V1 decided the branch without reading anything, so only that branch ever ran.
    const taken = condition.value ? 'then' : 'else';
    b.checklist.push(
      `Step "${id}" has the condition ${JSON.stringify(raw.condition ?? null)}, which ${condition.reason}. V1 always ran its "${taken}" steps, so the import keeps only those.`,
    );
    walk(branchInV1Order(id, taken, branches[taken], path, b), lane, b, scope);
    leaveScope(scope, lane, b);
    return;
  }

  flush(lane, b);
  const ifId = newId(id, b);
  const node: IfNode = { id: ifId, type: 'if', conditions: condition.conditions };
  b.nodes.push(node);
  connect(lane.tails, ifId, b);
  b.nodeOfStep.set(id, ifId);

  const owner = b.outputOwners.get(condition.variable);
  if (owner !== undefined) {
    const nodeId = b.nodeOfStep.get(owner);
    const now = nodeId === undefined ? '' : ` (now node "${nodeId}")`;
    requireDecision(
      b,
      `If node "${ifId}" reads "${condition.variable}", which V1 set from the output of step "${owner}"${now}. V2 reads a node's output as nodes.<id>.result. Change the condition to read that node.`,
    );
  } else {
    // `describeInputs` explains the run form's type restriction after the walk.
    const seen = b.variables.get(condition.variable) ?? { ifIds: [], types: new Set() };
    seen.ifIds.push(ifId);
    seen.types.add(condition.inputType ?? 'any');
    b.variables.set(condition.variable, seen);
    if (condition.inputType === undefined) {
      // A declared type would refuse a run whose value has another type,
      // and V1 took any value here.
      b.checklist.push(
        `If node "${ifId}" checks that "${condition.variable}" has a value, as V1 did. V1 took a value of any type, so the import does not add "${condition.variable}" to the run form. To set it in a run you start by hand, add it as a trigger input.`,
      );
    }
  }

  const tails: Tail[] = [];
  for (const key of ['then', 'else'] as const) {
    const branch: Lane = { tails: [{ from: ifId, fromOutput: key === 'then' ? 'true' : 'false' }], pending: [] };
    walk(branchInV1Order(id, key, branches[key], path, b), branch, b, scope);
    flush(branch, b);
    tails.push(...branch.tails);
  }
  lane.tails = dedupeTails(tails);
  leaveScope(scope, lane, b);
}

/** V1 ran a parallel step's children one after another, so the import puts
 * them in sequence. Branches that run at the same time would let a later
 * child run while an approval before it still waits or after a denial. */
function addParallel(raw: Record<string, unknown>, id: string, path: string, lane: Lane, b: Build): void {
  const children = inV1Order(Array.isArray(raw.steps) ? raw.steps : [], path, 'steps');
  if (children.length > 1) {
    b.checklist.push(
      `Step "${id}" is a "parallel" step, but V1 ran its ${children.length} steps one after another, in id order (${children.map((s) => quote(idOf(s))).join(', ')}). The import does the same.`,
    );
  }
  const scope: Scope = { stepId: id, denials: [] };
  walk(children, lane, b, scope);
  leaveScope(scope, lane, b);
}

type ReadCondition =
  | { kind: 'constant'; value: boolean; reason: string }
  | {
      kind: 'variable';
      variable: string;
      conditions: IfCondition[];
      /** Comparison operand type. Undefined for a truthiness test. */
      inputType?: WorkflowInputDefinition['type'];
    };

/** `evaluateCondition` in V1's `workflow-engine.ts`, as if-node conditions. */
function readCondition(raw: unknown): ReadCondition {
  if (typeof raw === 'boolean') return { kind: 'constant', value: raw, reason: 'is a constant' };
  if (!isRecord(raw) || typeof raw.variable !== 'string' || raw.variable === '') {
    return { kind: 'constant', value: false, reason: 'V1 could not read, so it was always false' };
  }
  const variable = raw.variable;
  const left = triggerDataPath(variable);
  if (!Object.prototype.hasOwnProperty.call(raw, 'equals')) {
    // V1 tested `Boolean(value)`. A boolean `equals true` is the same test:
    // it compares `Boolean(left)` for a value of any type (`nodes/if.ts`).
    return {
      kind: 'variable',
      variable,
      conditions: [{ left, dataType: 'boolean', operation: 'equals', right: true }],
    };
  }
  const expected = raw.equals;
  if (typeof expected === 'string') {
    return { kind: 'variable', variable, conditions: [{ left, dataType: 'string', operation: 'equals', right: expected }], inputType: 'string' };
  }
  if (typeof expected === 'number') {
    // A number `equals` reads "0" as 0. `exists` passes only a real number,
    // so the two conditions compare strictly, as V1's `===` did.
    return {
      kind: 'variable',
      variable,
      conditions: [
        { left, dataType: 'number', operation: 'exists' },
        { left, dataType: 'number', operation: 'equals', right: expected },
      ],
      inputType: 'number',
    };
  }
  if (typeof expected === 'boolean') {
    // isTrue/isFalse compare strictly, as V1's `===` did.
    return {
      kind: 'variable',
      variable,
      conditions: [{ left, dataType: 'boolean', operation: expected ? 'isTrue' : 'isFalse' }],
      inputType: 'boolean',
    };
  }
  return { kind: 'constant', value: false, reason: 'compares to a value V1 never matched' };
}

/** The steps under `key` of the step at `path`, in the order V1 ran them:
 * sorted by id (`asStepArray`), not in the listed order. */
function inV1Order(steps: unknown[], path: string, key: string): Located[] {
  return located(steps, (i) => `${path}.${key}[${i}]`).sort((x, y) => idOf(x).localeCompare(idOf(y)));
}

/** `inV1Order` for a branch of conditional step `id`, with a line when V1's
 * order is not the listed order. */
function branchInV1Order(id: string, key: string, steps: unknown[], path: string, b: Build): Located[] {
  const ordered = inV1Order(steps, path, key);
  if (ordered.some((s, i) => s.path !== `${path}.${key}[${i}]`)) {
    b.checklist.push(
      `V1 ran the "${key}" steps of step "${id}" in id order (${ordered.map((s) => quote(idOf(s))).join(', ')}), not in the order listed. The import keeps the V1 order.`,
    );
  }
  return ordered;
}

function idOf(step: Located): string {
  return isRecord(step.raw) ? v1StepId(step.raw, step.path) : step.path;
}

function located(steps: unknown[], pathOf: (index: number) => string): Located[] {
  return steps.map((raw, index) => ({ raw, path: pathOf(index) }));
}

/**
 * Lists what made V1's compiler (`normalizeStep` in `workflow-compiler.ts`)
 * refuse these steps. V1 never ran a workflow it refused, so each problem
 * is a required decision. This reads every nested list, including the
 * branches and loops that the walk does not convert.
 */
function collectRefusals(steps: unknown[], pathOf: (index: number) => string, b: Build): void {
  steps.forEach((raw, index) => {
    const path = pathOf(index);
    if (!isRecord(raw)) {
      requireDecision(b, `Item ${path} is not a step object, so V1 refused to run this workflow. The import leaves it out.`);
      return;
    }
    const id = v1StepId(raw, path);
    // `dropped` is set when the walk leaves the step out, too.
    const refused = (problem: string, dropped = '') =>
      requireDecision(b, `Step "${id}" ${problem}, so V1 refused to run this workflow.${dropped}`);
    const type = typeof raw.type === 'string' ? raw.type.trim() : '';
    if (!V1_STEP_TYPES.has(type)) {
      refused(`has the unknown type ${JSON.stringify(raw.type)}`, ' The import leaves the step out.');
      return;
    }
    if (type === 'bash' && stringField(raw.command) === '') refused('is a bash step with no command', ' The import leaves it out.');
    if (type === 'tool' && stringField(raw.tool) === '') refused('is a tool step with no tool name', ' The import leaves it out.');
    if (type === 'agent_message') {
      if ((stringField(raw.content, false) || stringField(raw.message, false) || stringField(raw.goal, false)).trim() === '') {
        refused('is an agent message with no text', ' The import leaves it out.');
      }
      if (raw.interrupt !== undefined && typeof raw.interrupt !== 'boolean') refused('has an "interrupt" that is not true or false');
      const awaitResponse = raw.await_response !== undefined ? raw.await_response : raw.awaitResponse;
      if (awaitResponse !== undefined && typeof awaitResponse !== 'boolean') refused('has an "await_response" that is not true or false');
      const timeout = raw.await_timeout_ms !== undefined ? raw.await_timeout_ms : raw.awaitTimeoutMs;
      if (timeout !== undefined && !(typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 1000)) {
        refused('has an "await_timeout_ms" that is not a number of 1000 or more');
      }
    }
    for (const key of ['then', 'else', 'steps'] as const) {
      const nested = raw[key];
      if (Array.isArray(nested)) collectRefusals(nested, (i) => `${path}.${key}[${i}]`, b);
      else if (nested !== undefined && nested !== null) refused(`has a "${key}" that is not a list`);
    }
  });
}

const V1_STEP_TYPES = new Set(['agent', 'agent_message', 'tool', 'bash', 'conditional', 'loop', 'parallel', 'subworkflow', 'approval']);

/** V1's default `maxSteps` (`executeWorkflowRun`). The V1 workflow executor
 * (`buildWorkflowRunPayload`) never set another. */
const V1_MAX_STEPS = 50;

/**
 * The most steps one V1 run reaches, counted as V1's `executeSteps` did: one
 * for each step it ran, a `conditional` or `parallel` step included, plus
 * the steps of the branch or list it ran. A `loop` step counts once, because
 * V1 ran none of its steps.
 */
function v1StepVisits(steps: unknown[]): number {
  let visits = 0;
  for (const raw of steps) {
    visits += 1;
    if (!isRecord(raw)) continue;
    const type = typeof raw.type === 'string' ? raw.type.trim() : '';
    const list = (key: string) => {
      const value = raw[key];
      return v1StepVisits(Array.isArray(value) ? value : []);
    };
    if (type === 'parallel') visits += list('steps');
    if (type === 'conditional') {
      const condition = readCondition(raw.condition);
      if (condition.kind === 'constant') visits += list(condition.value ? 'then' : 'else');
      else visits += Math.max(list('then'), list('else'));
    }
  }
  return visits;
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
  // The node waits when V1 waited for one of its steps (`addPending`). Both
  // modes are explicit, because the editor shows an unset mode as `none`.
  const node: SessionNode = {
    id: newId(first.stepId, b),
    type: 'session',
    mode: 'start',
    prompt: literalTemplate(prompt),
    wait: { mode: lane.pending.some((p) => p.waits) ? 'until_idle' : 'none' },
  };
  addNode(node, lane, b);
  for (const p of lane.pending) b.nodeOfStep.set(p.stepId, node.id);
  b.messageSessions.push(node.id);
  if (lane.pending.some((p) => p.braces === true)) {
    b.checklist.push(
      `Session node "${node.id}" has text in {{ }}. V1 sent it to the agent as written, and the import keeps it as written. To fill in a value when the workflow runs, change it to a V2 template such as {{trigger.data.name}}.`,
    );
  }
  const commands = lane.pending.filter((p) => p.command === true).map((p) => quote(p.stepId));
  if (commands.length > 0) {
    requireDecision(
      b,
      `Session node "${node.id}" runs the shell commands of steps ${commands.join(', ')}. V1 stopped the run when a command failed. Here the session only reports the failure, and the work after it can still run. Decide how the workflow stops when a command fails.`,
    );
  }
  // dag/v1 refuses a session `wait.timeout`, so the V1 limit cannot carry over.
  for (const p of lane.pending) {
    if (p.awaitMs === undefined) continue;
    requireDecision(
      b,
      `V1 waited up to ${durationText(p.awaitMs)} for the answer to step "${p.stepId}", and failed the run when the agent took longer. Session node "${node.id}" waits with no time limit, because V2 has no time limit for a session node. Decide whether the run can wait longer than it did in V1.`,
    );
  }
  lane.pending = [];
}

/** A checklist line for a place where the import does not do exactly what
 * V1 did. The schedule lines of the workflow then say that it must not run
 * on a schedule yet (`scheduleLine`). */
function requireDecision(b: Build, line: string): void {
  b.checklist.push(line);
  b.differs = true;
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

/** `120000` → `2 minutes`, `1500` → `1.5 seconds`. */
function durationText(ms: number): string {
  const seconds = ms / 1000;
  if (seconds % 60 !== 0) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = seconds / 60;
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
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
