/**
 * Workflow-authoring check (`workflow_definition`).
 *
 * Finds the workflow definitions an agent drafted and scores them. A draft
 * is a definition the agent sent to the save validator through
 * `workflows.save_workflow` or `workflows.validate_definition`. The final
 * definition is the one the case saved (product drive records it in
 * `metadata.savedWorkflows`), else the last draft. A case asks for one
 * workflow, so saving more than one fails.
 *
 * The product's save validator decides validity: a saved definition passed
 * it, and a draft passed it when its call succeeded. The check does not
 * validate again, because only the product knows the org's integrations
 * and models.
 *
 * The check reports two measurements apart: initial correctness (the
 * first full draft already passes) and repair effort (validator rejections
 * before the final definition). Only the final definition decides pass or
 * fail.
 *
 * Two kinds of call are not drafts. A call to a tool that does not exist
 * (a model that writes `workflows__validate_definition` after the pinned
 * `workflows__get_workflow`) never reaches the validator. A probe is a
 * small draft that checks one detail, such as whether the validator
 * accepts an action name, before the real draft. The check counts both
 * on their own.
 */
import { approvalRequestWarning } from "@valet/api/eval-workflows";
import { toolResultText } from "../trajectory.js";
import type { CheckResult, Trajectory, TrajectoryToolCall, WorkflowDefinitionCheck } from "../types.js";

/** Actions that run the save validator over a full definition. */
const DRAFT_ACTIONS = new Set(["workflows.save_workflow", "workflows.validate_definition"]);
/** Actions whose rejection is a validator rejection. A patch is linted too. */
const VALIDATED_ACTIONS = new Set([...DRAFT_ACTIONS, "workflows.patch_workflow"]);
/** A literal calendar date in a step. Runs read their date from `trigger.timestamp`. */
const LITERAL_DATE = /\b(?:19|20)\d\d-[01]\d-[0-3]\d\b/;
/** A `trigger.data` read and the property path after it. */
const TRIGGER_DATA_READ = /\btrigger\.data((?:\.[A-Za-z_$][\w$]*|\[[^\]]*\])*)/g;
/** What a scheduled run puts in `trigger.data` besides its input (the scheduler's `{ scheduleName, cron, input }`). */
const SCHEDULE_METADATA = new Set(["scheduleName", "cron"]);

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One definition the agent sent to the validator, in call order. */
export interface WorkflowDraft {
  definition: unknown;
  /** Index of the tool call that carried it. */
  callIndex: number;
  rejected: boolean;
}

/** The params a plugin action received: `call_tool` nests them; a pinned tool gets them flat. */
function actionParams(call: TrajectoryToolCall): unknown {
  if (call.toolName === "call_tool") return isRecord(call.args) ? call.args.params : undefined;
  return call.args;
}

/**
 * True when the call named a tool that does not exist. The agent loop
 * answers it before any action runs, so it is not a validator rejection.
 */
function isUnknownTool(call: TrajectoryToolCall): boolean {
  return call.status === "error" && toolResultText(call.result).trim() === `Tool ${call.toolName} not found`;
}

/** True when the action refused the call: a tool error, or a failed action result. */
function isRejected(call: TrajectoryToolCall): boolean {
  if (call.status === "error") return true;
  if (isRecord(call.result) && isRecord(call.result.details) && call.result.details.ok === false) return true;
  return call.actionId !== undefined && toolResultText(call.result).startsWith(`${call.actionId} failed`);
}

/**
 * Every definition the agent sent to the save validator, in call order. A
 * call to a tool that does not exist never reached the validator, so it is
 * not a draft.
 */
export function workflowDrafts(trajectory: Trajectory): WorkflowDraft[] {
  const drafts: WorkflowDraft[] = [];
  for (const call of trajectory.toolCalls) {
    if (call.actionId === undefined || !DRAFT_ACTIONS.has(call.actionId) || isUnknownTool(call)) continue;
    const params = actionParams(call);
    if (!isRecord(params) || params.definition === undefined) continue;
    drafts.push({ definition: params.definition, callIndex: call.index, rejected: isRejected(call) });
  }
  return drafts;
}

/** Validator rejections across save, validate, and patch calls. */
function rejectionCount(trajectory: Trajectory): number {
  return trajectory.toolCalls.filter(
    (call) =>
      call.actionId !== undefined && VALIDATED_ACTIONS.has(call.actionId) && !isUnknownTool(call) && isRejected(call),
  ).length;
}

function nodeCount(definition: unknown): number {
  return isRecord(definition) && Array.isArray(definition.nodes) ? definition.nodes.length : 0;
}

/**
 * The first full draft, whether the save validator accepted it, and the
 * probes before it. A full draft has at least half as many steps as the
 * final definition; a smaller draft before it is a probe. When no draft is
 * that large (the agent grew the workflow with patches), the final
 * definition is the first full one.
 */
export function firstFullDraft(
  drafts: WorkflowDraft[],
  final: unknown,
  finalValid: boolean,
): { definition: unknown; valid: boolean; probes: number } {
  const size = nodeCount(final);
  const index = drafts.findIndex((draft) => nodeCount(draft.definition) * 2 >= size);
  if (index === -1) return { definition: final, valid: finalValid, probes: drafts.length };
  return { definition: drafts[index].definition, valid: !drafts[index].rejected, probes: index };
}

/** The definitions a product-drive case saved: one per workflow, oldest update first. */
function savedDefinitions(trajectory: Trajectory): unknown[] {
  const saved = trajectory.metadata?.savedWorkflows;
  return Array.isArray(saved) ? saved.filter(isRecord).map((row) => row.definition) : [];
}

// ── Selectors ────────────────────────────────────────────────────────────────

function globMatches(glob: string, value: string): boolean {
  const pattern = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`).test(value);
}

/** The action id a tool step runs: `action` when it is qualified, else `service.action`. */
function toolActionId(node: Json): string | undefined {
  if (node.type !== "tool" || typeof node.action !== "string") return undefined;
  if (node.action.includes(".")) return node.action;
  return typeof node.service === "string" ? `${node.service}.${node.action}` : undefined;
}

/** A step and, for a `foreach`, its body: the units a selector can match. */
function stepUnits(node: Json): Json[] {
  return node.type === "foreach" && isRecord(node.body) ? [node, node.body] : [node];
}

/** A selector's parts: the ones that name steps, and the `!` parts that take steps out again. */
function selectorParts(selector: string): { include: string[]; exclude: string[] } {
  const parts = selector.split("|");
  return {
    include: parts.filter((part) => !part.startsWith("!")),
    exclude: parts.filter((part) => part.startsWith("!")).map((part) => part.slice(1)),
  };
}

/** True when one selector part names `unit`. */
function partMatches(part: string, unit: Json): boolean {
  if (!part.includes(".")) return unit.type === part;
  const actionId = toolActionId(unit);
  return actionId !== undefined && globMatches(part, actionId);
}

/**
 * True when `selector` names this step. A part with a dot is an action
 * glob for tool steps; a part without one is a step type. `|` separates
 * parts. A part that starts with `!` excludes what it names, so
 * `sheets.*|!sheets.read_*` names every sheets action except the reads.
 */
export function selectorMatches(selector: string, node: Json): boolean {
  const { include, exclude } = selectorParts(selector);
  return stepUnits(node).some(
    (unit) => include.some((part) => partMatches(part, unit)) && !exclude.some((part) => partMatches(part, unit)),
  );
}

/** True when an agent step's `toolScope.actions` entry can run an action the selector names. */
function scopeCovers(entry: string, selector: string): boolean {
  const { include, exclude } = selectorParts(selector);
  if (exclude.some((part) => globMatches(part, entry))) return false;
  return include.some((part) => {
    if (globMatches(part, entry)) return true;
    // `sheets.*` in a scope covers every `sheets.` action.
    return entry.endsWith(".*") && part.startsWith(entry.slice(0, -1));
  });
}

// ── Rules ────────────────────────────────────────────────────────────────────

function nodesOf(definition: unknown): Json[] {
  if (!isRecord(definition) || !Array.isArray(definition.nodes)) return [];
  return definition.nodes.filter(isRecord);
}

interface Edge {
  from: string;
  to: string;
  fromOutput?: string;
}

function edgesOf(definition: unknown): Edge[] {
  if (!isRecord(definition) || !Array.isArray(definition.edges)) return [];
  return definition.edges.flatMap((edge) =>
    isRecord(edge) && typeof edge.from === "string" && typeof edge.to === "string"
      ? [{ from: edge.from, to: edge.to, ...(typeof edge.fromOutput === "string" ? { fromOutput: edge.fromOutput } : {}) }]
      : [],
  );
}

/**
 * True when the edge also runs after a person denies its source approval
 * step. A denial fails the step, except with `onDeny: "skip"`: then the
 * step completes with approved false, which runs its `"false"` edges and
 * its edges without `fromOutput`.
 */
function runsOnDenial(edge: Edge, nodesById: Map<string, Json>): boolean {
  if (nodesById.get(edge.from)?.type !== "approval") return false;
  if (edge.fromOutput === "false") return true;
  return edge.fromOutput === undefined && nodesById.get(edge.from)?.onDeny === "skip";
}

function stepId(node: Json): string {
  return typeof node.id === "string" ? node.id : "(no id)";
}

/** Every string in `value`, at any depth. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (isRecord(value)) return Object.values(value).flatMap(strings);
  return [];
}

/** Template text with `["name"]` reads written as `.name`, so both spellings match one pattern. */
function dotted(text: string): string {
  return text.replace(/\[\s*["']([A-Za-z_$][\w$]*)["']\s*\]/g, ".$1");
}

/** The property path of each `trigger.data` read, such as `.input.symbols`. Bare reads are skipped. */
function triggerDataReads(definition: unknown): string[] {
  const reads: string[] = [];
  for (const text of strings(isRecord(definition) ? [definition.nodes, definition.edges] : [])) {
    for (const match of dotted(text).matchAll(TRIGGER_DATA_READ)) {
      if (match[1] !== "") reads.push(match[1]);
    }
  }
  return reads;
}

/** The first segment of a read path: `.input.symbols` → `input`, `["a b"]` → `a b`. */
function firstSegment(path: string): string {
  const match = /^\.([A-Za-z_$][\w$]*)|^\[\s*["']?([^"'\]]*)["']?\s*\]/.exec(path);
  return match?.[1] ?? match?.[2] ?? "";
}

/**
 * Node ids reachable from `start` along edges, `start` excluded unless a
 * cycle returns to it. From an approval step, only the edges that run
 * after an approval count: a step on its denial branch does not run after
 * the approval.
 */
function reachableFrom(start: string, edges: Edge[], nodesById: Map<string, Json>): Set<string> {
  const seen = new Set<string>();
  const queue = edges.filter((edge) => edge.from === start && !runsOnDenial(edge, nodesById)).map((edge) => edge.to);
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of edges) if (edge.from === id) queue.push(edge.to);
  }
  return seen;
}

/**
 * Node ids that can run before every step in `gate` has run: all that the
 * trigger reaches without passing a gate step. A path passes a gate
 * approval step only on its approve path, so it continues along the edges
 * that also run on a denial.
 */
function reachableWithout(gate: Set<string>, nodes: Json[], edges: Edge[], nodesById: Map<string, Json>): Set<string> {
  const triggers = nodes.filter((node) => node.type === "trigger").map(stepId);
  const entries = triggers.length > 0 ? triggers : nodes.map(stepId).filter((id) => !edges.some((edge) => edge.to === id));
  const seen = new Set<string>();
  const queue = [...entries];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of edges) {
      if (edge.from === id && (!gate.has(id) || runsOnDenial(edge, nodesById))) queue.push(edge.to);
    }
  }
  return seen;
}

/**
 * Every rule `definition` breaks, as one line each. The rules every
 * definition gets come first; the case's optional rules follow.
 */
export function workflowRuleFailures(definition: unknown, check: WorkflowDefinitionCheck): string[] {
  const failures: string[] = [];
  const nodes = nodesOf(definition);
  if (nodes.length === 0) return ["the definition has no steps"];
  const units = nodes.flatMap(stepUnits);

  for (const node of nodes) {
    if (node.type === "stop" && node.outcome !== undefined && node.outcome !== "success" && node.outcome !== "failure") {
      failures.push(`stop step "${stepId(node)}" has outcome ${JSON.stringify(node.outcome)}; a stop outcome is success or failure`);
    }
    if (node.type === "foreach") {
      if (!isRecord(node.body)) failures.push(`foreach step "${stepId(node)}" has no inline body object`);
      if (typeof node.maxItems !== "number" || node.maxItems < 1) {
        failures.push(`foreach step "${stepId(node)}" sets no maxItems`);
      }
    }
  }
  for (const unit of units) {
    if (typeof unit.type === "string" && approvalRequestWarning({ type: unit.type, prompt: unit.prompt }) !== undefined) {
      failures.push(`agent step "${stepId(unit)}" tells its agent to get approval`);
    }
  }

  if (check.foreach === true && !nodes.some((node) => node.type === "foreach")) {
    failures.push("no foreach step handles the list");
  }
  for (const selector of [...(check.tool_steps ?? []), ...(check.approved_actions ?? [])]) {
    if (!nodes.some((node) => selectorMatches(selector, node) && stepUnits(node).some((unit) => unit.type === "tool"))) {
      failures.push(`no tool step runs ${selector}`);
    }
  }
  for (const selector of check.approved_actions ?? []) {
    for (const unit of units) {
      if (unit.type !== "session" && unit.type !== "orchestrator") continue;
      // Without `toolScope.actions`, an agent step can run every action (`actionInScope`).
      if (!isRecord(unit.toolScope) || !Array.isArray(unit.toolScope.actions)) {
        failures.push(`agent step "${stepId(unit)}" sets no toolScope.actions, so it can run ${selector}; an approved action belongs in a tool step`);
        continue;
      }
      const covered = unit.toolScope.actions.filter((entry): entry is string => typeof entry === "string" && scopeCovers(entry, selector));
      if (covered.length > 0) {
        failures.push(`agent step "${stepId(unit)}" can run ${covered.join(", ")}; an approved action belongs in a tool step`);
      }
    }
  }
  if (check.order !== undefined) {
    const edges = edgesOf(definition);
    const nodesById = new Map(nodes.map((node) => [stepId(node), node]));
    const [head, ...rest] = check.order;
    let previous = head;
    let current = nodes.filter((node) => selectorMatches(head, node)).map(stepId);
    if (current.length === 0) failures.push(`no step matches ${head}`);
    for (const selector of rest) {
      if (current.length === 0) break;
      // After an approval, every matching step must wait for it, not just
      // one of them: a second write before the approval runs unapproved.
      // Other steps may repeat earlier, such as a read before a write.
      if (current.every((id) => nodesById.get(id)?.type === "approval")) {
        const early = reachableWithout(new Set(current), nodes, edges, nodesById);
        for (const node of nodes) {
          if (selectorMatches(selector, node) && early.has(stepId(node))) {
            failures.push(`step "${stepId(node)}" matches ${selector} and can run before the approval`);
          }
        }
      }
      const reachable = new Set(current.flatMap((id) => [...reachableFrom(id, edges, nodesById)]));
      current = nodes.filter((node) => selectorMatches(selector, node) && reachable.has(stepId(node))).map(stepId);
      if (current.length === 0) failures.push(`no step that matches ${selector} runs after one that matches ${previous}`);
      previous = selector;
    }
  }
  if (check.schedule_input === true) {
    const reads = triggerDataReads(definition);
    const outside = reads.filter((path) => firstSegment(path) !== "input" && !SCHEDULE_METADATA.has(firstSegment(path)));
    if (!reads.some((path) => firstSegment(path) === "input")) failures.push("no step reads the schedule input at trigger.data.input");
    if (outside.length > 0) {
      failures.push(`steps read trigger.data${[...new Set(outside)].join(", trigger.data")}; schedule input is at trigger.data.input`);
    }
  }
  if (check.run_date === true) {
    if (!strings(nodes).some((text) => dotted(text).includes("trigger.timestamp"))) {
      failures.push("no step reads the run date from trigger.timestamp");
    }
    const dated = nodes.filter((node) => node.type !== "trigger" && strings(node).some((text) => LITERAL_DATE.test(text)));
    if (dated.length > 0) failures.push(`steps ${dated.map(stepId).join(", ")} hold a literal date`);
  }
  if (check.declared_inputs === true) {
    const trigger = nodes.find((node) => node.type === "trigger");
    const declared = trigger !== undefined && isRecord(trigger.dataSchema) ? Object.keys(trigger.dataSchema) : [];
    const undeclared = [...new Set(triggerDataReads(definition).map(firstSegment))].filter((field) => !declared.includes(field));
    if (undeclared.length > 0) failures.push(`the trigger dataSchema does not declare ${undeclared.join(", ")}`);
  }
  return failures;
}

function summarize(problems: string[]): string {
  const shown = problems.slice(0, 5).join("; ");
  return problems.length > 5 ? `${shown}; and ${problems.length - 5} more` : shown;
}

/** Run one `workflow_definition` check against a trajectory. */
export function runWorkflowDefinitionCheck(check: WorkflowDefinitionCheck, trajectory: Trajectory): CheckResult {
  const drafts = workflowDrafts(trajectory);
  const savedRows = savedDefinitions(trajectory);
  const saved = savedRows[savedRows.length - 1];
  const lastDraft = drafts[drafts.length - 1];
  const final = saved ?? lastDraft?.definition;
  const rejections = rejectionCount(trajectory);
  const unknownToolCalls = trajectory.toolCalls.filter(isUnknownTool).length;
  if (final === undefined) {
    return {
      check,
      pass: false,
      detail: "the agent sent no workflow definition to the save validator and saved none",
      metrics: {
        drafts: 0,
        probes: 0,
        rejections,
        unknown_tool_calls: unknownToolCalls,
        first_valid: false,
        first_correct: false,
        final_valid: false,
      },
    };
  }

  const finalValid = saved !== undefined || lastDraft?.rejected === false;
  const finalRules = workflowRuleFailures(final, check);
  const full = firstFullDraft(drafts, final, finalValid);
  const firstRules = workflowRuleFailures(full.definition, check);
  const metrics = {
    drafts: drafts.length,
    probes: full.probes,
    rejections,
    unknown_tool_calls: unknownToolCalls,
    first_valid: full.valid,
    first_correct: full.valid && firstRules.length === 0,
    final_valid: finalValid,
  };
  const firstLine =
    metrics.first_correct
      ? "first full draft correct"
      : `first full draft: ${full.valid ? "accepted" : "rejected"} by the save validator, ${firstRules.length} rule failure(s)`;
  const extras = [
    ...(full.probes > 0 ? [`${full.probes} probe(s)`] : []),
    ...(unknownToolCalls > 0 ? [`${unknownToolCalls} call(s) to a tool that does not exist`] : []),
  ];
  const effort = `${firstLine}; ${drafts.length} draft(s), ${rejections} validator rejection(s)${extras.map((e) => `, ${e}`).join("")}`;
  const source = saved !== undefined ? "saved definition" : "last draft";
  const problems = [
    // A save that returns an error stores nothing, so its draft does not count as saved.
    ...(check.saved === true && saved === undefined ? ["no workflow was saved"] : []),
    ...(savedRows.length > 1 ? [`the agent saved ${savedRows.length} workflows; the case asks for one`] : []),
    ...(finalValid ? [] : ["the save validator rejected the last draft"]),
    ...finalRules,
  ];
  if (problems.length > 0) {
    return { check, pass: false, detail: `the ${source} fails: ${summarize(problems)}. ${effort}.`, metrics };
  }
  return { check, pass: true, detail: `the ${source} passes the save validator and every rule. ${effort}.`, metrics };
}
