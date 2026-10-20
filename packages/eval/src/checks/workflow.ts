/**
 * Workflow-authoring check (`workflow_definition`).
 *
 * Finds the workflow definitions an agent drafted and scores them. A draft
 * is a definition the agent sent to the save validator through
 * `workflows.save_workflow` or `workflows.validate_definition`. The final
 * definition is the one the case saved (product drive records it in
 * `metadata.savedWorkflows`), else the last draft.
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
import { approvalRequestWarning, validateWorkflowDraft } from "@valet/api/eval-workflows";
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
 * The first full draft and the probes before it. A full draft has at least
 * half as many steps as the final definition; a smaller draft before it is
 * a probe. When no draft is that large (the agent grew the workflow with
 * patches), the final definition is the first full one.
 */
export function firstFullDraft(drafts: WorkflowDraft[], final: unknown): { definition: unknown; probes: number } {
  const size = nodeCount(final);
  const index = drafts.findIndex((draft) => nodeCount(draft.definition) * 2 >= size);
  if (index === -1) return { definition: final, probes: drafts.length };
  return { definition: drafts[index].definition, probes: index };
}

/** The most recently saved definition a product-drive case recorded. */
function lastSavedDefinition(trajectory: Trajectory): unknown {
  const saved = trajectory.metadata?.savedWorkflows;
  if (!Array.isArray(saved) || saved.length === 0) return undefined;
  const last: unknown = saved[saved.length - 1];
  return isRecord(last) ? last.definition : undefined;
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

/**
 * True when `selector` names this step. A part with a dot is an action
 * glob for tool steps; a part without one is a step type. `|` separates
 * parts.
 */
export function selectorMatches(selector: string, node: Json): boolean {
  return selector.split("|").some((part) =>
    stepUnits(node).some((unit) => {
      if (!part.includes(".")) return unit.type === part;
      const actionId = toolActionId(unit);
      return actionId !== undefined && globMatches(part, actionId);
    }),
  );
}

/** True when an agent step's `toolScope.actions` entry can run an action the selector names. */
function scopeCovers(entry: string, selector: string): boolean {
  return selector.split("|").some((part) => {
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

function edgesOf(definition: unknown): Array<{ from: string; to: string }> {
  if (!isRecord(definition) || !Array.isArray(definition.edges)) return [];
  return definition.edges.flatMap((edge) =>
    isRecord(edge) && typeof edge.from === "string" && typeof edge.to === "string" ? [{ from: edge.from, to: edge.to }] : [],
  );
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

/** The property path of each `trigger.data` read, such as `.input.symbols`. Bare reads are skipped. */
function triggerDataReads(definition: unknown): string[] {
  const reads: string[] = [];
  for (const text of strings(isRecord(definition) ? [definition.nodes, definition.edges] : [])) {
    for (const match of text.matchAll(TRIGGER_DATA_READ)) {
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

/** Node ids reachable from `start` along edges, `start` excluded unless a cycle returns to it. */
function reachableFrom(start: string, edges: Array<{ from: string; to: string }>): Set<string> {
  const seen = new Set<string>();
  const queue = edges.filter((edge) => edge.from === start).map((edge) => edge.to);
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of edges) if (edge.from === id) queue.push(edge.to);
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
      const scope = isRecord(unit.toolScope) && Array.isArray(unit.toolScope.actions) ? unit.toolScope.actions : [];
      const covered = scope.filter((entry): entry is string => typeof entry === "string" && scopeCovers(entry, selector));
      if (covered.length > 0) {
        failures.push(`agent step "${stepId(unit)}" can run ${covered.join(", ")}; an approved action belongs in a tool step`);
      }
    }
  }
  if (check.order !== undefined) {
    const edges = edgesOf(definition);
    const [head, ...rest] = check.order;
    let previous = head;
    let current = nodes.filter((node) => selectorMatches(head, node)).map(stepId);
    if (current.length === 0) failures.push(`no step matches ${head}`);
    for (const selector of rest) {
      if (current.length === 0) break;
      const reachable = new Set(current.flatMap((id) => [...reachableFrom(id, edges)]));
      current = nodes.filter((node) => selectorMatches(selector, node) && reachable.has(stepId(node))).map(stepId);
      if (current.length === 0) failures.push(`no step that matches ${selector} runs after one that matches ${previous}`);
      previous = selector;
    }
  }
  if (check.schedule_input === true) {
    const reads = triggerDataReads(definition);
    const outside = reads.filter((path) => firstSegment(path) !== "input");
    if (!reads.some((path) => firstSegment(path) === "input")) failures.push("no step reads the schedule input at trigger.data.input");
    if (outside.length > 0) {
      failures.push(`steps read trigger.data${[...new Set(outside)].join(", trigger.data")}; schedule input is at trigger.data.input`);
    }
  }
  if (check.run_date === true) {
    if (!strings(nodes).some((text) => text.includes("trigger.timestamp"))) {
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

/** The validator's errors and the rule failures for one definition. */
function score(definition: unknown, check: WorkflowDefinitionCheck): { errors: string[]; rules: string[] } {
  const validation = validateWorkflowDraft(definition);
  return { errors: validation.ok ? [] : validation.errors, rules: workflowRuleFailures(definition, check) };
}

function summarize(problems: string[]): string {
  const shown = problems.slice(0, 5).join("; ");
  return problems.length > 5 ? `${shown}; and ${problems.length - 5} more` : shown;
}

/** Run one `workflow_definition` check against a trajectory. */
export function runWorkflowDefinitionCheck(check: WorkflowDefinitionCheck, trajectory: Trajectory): CheckResult {
  const drafts = workflowDrafts(trajectory);
  const saved = lastSavedDefinition(trajectory);
  const final = saved ?? drafts[drafts.length - 1]?.definition;
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

  const finalScore = score(final, check);
  const full = firstFullDraft(drafts, final);
  const first = score(full.definition, check);
  const metrics = {
    drafts: drafts.length,
    probes: full.probes,
    rejections,
    unknown_tool_calls: unknownToolCalls,
    first_valid: first.errors.length === 0,
    first_correct: first.errors.length === 0 && first.rules.length === 0,
    final_valid: finalScore.errors.length === 0,
  };
  const firstLine =
    metrics.first_correct
      ? "first full draft correct"
      : `first full draft: ${first.errors.length} validator error(s), ${first.rules.length} rule failure(s)`;
  const extras = [
    ...(full.probes > 0 ? [`${full.probes} probe(s)`] : []),
    ...(unknownToolCalls > 0 ? [`${unknownToolCalls} call(s) to a tool that does not exist`] : []),
  ];
  const effort = `${firstLine}; ${drafts.length} draft(s), ${rejections} validator rejection(s)${extras.map((e) => `, ${e}`).join("")}`;
  const source = saved !== undefined ? "saved definition" : "last draft";
  const problems = [...finalScore.errors.map((error) => `validator: ${error}`), ...finalScore.rules];
  if (problems.length > 0) {
    return { check, pass: false, detail: `the ${source} fails: ${summarize(problems)}. ${effort}.`, metrics };
  }
  return { check, pass: true, detail: `the ${source} passes the validator and every rule. ${effort}.`, metrics };
}
