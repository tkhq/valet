/**
 * dag/v1 definition validator — linter-grade.
 *
 * Ported (in spirit) from the V1 workflow-dag validator: the goal is that
 * an agent saving a workflow receives errors it can ACT on — named node,
 * named field, what's wrong, and where useful a did-you-mean hint — and
 * that a definition which passes cannot crash the interpreter at runtime
 * for structural reasons. Checks:
 *
 *   - structure: one trigger, known node types, id pattern, duplicate ids
 *   - per-type field shape: required fields, types, enums, ranges,
 *     unknown-key lint with nearest-match suggestions (catches the
 *     `config: {...}` and `condition` vs `conditions` LLM mistakes)
 *   - templates/expressions: every templated field must PARSE, and every
 *     `nodes.<id>` reference must point at a real node (with a bracket-
 *     notation hint for hyphenated ids)
 *   - edges: known endpoints, fromOutput semantics, no edges out of stop,
 *     no self-loops, no duplicates, `when` predicates parse + reference-check
 *   - graph: no cycles, every node reachable from the trigger
 *   - if conditions: left expression parses, dataType/operation pairs are
 *     supported (with the allowed list in the message), regex patterns
 *     compile
 *   - optional environment hooks: `isKnownModel` / `isKnownAction` let the
 *     host reject unknown model specs and unknown tool service/actions at
 *     save time instead of at run time
 *
 * Every check guards field TYPES before dereferencing — callers hand us
 * LLM-authored JSON, and a malformed field must produce a validation error
 * the author can fix, never a TypeError that crashes the interpreter (or,
 * downstream, the web canvas).
 */

import { parseDurationMs } from './duration.js';
import {
  collectExpressionPaths,
  collectTemplatePaths,
  parseExpression,
  parseTemplate,
  TemplateParseError,
} from './expression.js';
import {
  allowedIfOperations,
  isIfOperationSupported,
  normalizeIfOperation,
  type IfDataType,
} from './if-operations.js';
import type { WorkflowDefinition } from './shape.js';
import type { DagNodeType, ForeachNode, IfNode, WorkflowNode } from './nodes.js';

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

/**
 * Optional environment hooks. When provided, the validator also rejects
 * references the RUNTIME would reject: unknown model specs and unknown
 * tool service/action pairs. Return values:
 *   - `isKnownModel(spec)`: false → error.
 *   - `isKnownAction(service, action)`: "unknown-service" / "unknown-action"
 *     → error; "ok" or "dynamic" (MCP-style plugins whose action list only
 *     resolves at runtime) → pass.
 */
export interface ValidateEnvironment {
  isKnownModel?: (spec: string) => boolean;
  isKnownAction?: (service: string, action: string) => 'ok' | 'dynamic' | 'unknown-service' | 'unknown-action';
}

const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const SUPPORTED_NODE_TYPES: ReadonlySet<DagNodeType> = new Set<DagNodeType>([
  'trigger',
  'set',
  'if',
  'wait',
  'approval',
  'session',
  'stop',
  'foreach',
  'llm',
  'orchestrator',
  'tool',
]);

/** Node types allowed as a foreach body (decision 1: no nested foreach/if/approval/stop). */
const FOREACH_BODY_TYPES: ReadonlySet<DagNodeType> = new Set<DagNodeType>([
  'llm',
  'tool',
  'set',
  'orchestrator',
  'session',
]);

/** Allowed keys per node type — the unknown-key lint's ground truth. */
const ALLOWED_KEYS: Record<DagNodeType, readonly string[]> = {
  trigger: ['id', 'type', 'dataSchema'],
  set: ['id', 'type', 'values'],
  if: ['id', 'type', 'combinator', 'conditions'],
  wait: ['id', 'type', 'mode', 'duration'],
  approval: ['id', 'type', 'prompt', 'summary', 'details', 'timeout', 'onDeny'],
  session: ['id', 'type', 'mode', 'prompt', 'title', 'model', 'outputSchema', 'wait'],
  stop: ['id', 'type', 'outcome', 'output', 'message'],
  llm: ['id', 'type', 'model', 'system', 'prompt', 'outputSchema', 'temperature', 'maxOutputTokens'],
  orchestrator: ['id', 'type', 'prompt', 'outputSchema', 'wait'],
  tool: ['id', 'type', 'service', 'action', 'params', 'summary'],
  foreach: ['id', 'type', 'items', 'body', 'maxItems', 'concurrency', 'itemAlias', 'indexAlias', 'onItemError'],
};

const IF_DATA_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'date', 'boolean', 'array', 'object']);
const IF_CONDITION_KEYS: readonly string[] = ['left', 'dataType', 'operation', 'right'];

export function validateWorkflowDefinition(
  definition: WorkflowDefinition,
  env: ValidateEnvironment = {},
): ValidationResult {
  const errors: string[] = [];

  if (definition.version !== 'dag/v1') {
    errors.push(`unsupported version ${JSON.stringify(definition.version)}: expected "dag/v1"`);
  }

  const nodesById = new Map<string, WorkflowNode>();
  for (const node of definition.nodes) {
    if (typeof node !== 'object' || node === null) {
      errors.push(`nodes[] contains a non-object entry ${JSON.stringify(node)}`);
      continue;
    }
    if (typeof node.id !== 'string' || node.id.length === 0) {
      errors.push(`a ${JSON.stringify(node.type)} node is missing its "id" (must be a non-empty string)`);
      continue;
    }
    if (!SUPPORTED_NODE_TYPES.has(node.type)) {
      errors.push(
        `node ${JSON.stringify(node.id)}: unsupported node type ${JSON.stringify(node.type)} ` +
          `(supported: ${[...SUPPORTED_NODE_TYPES].join(', ')})`,
      );
      continue;
    }
    if (!NODE_ID_PATTERN.test(node.id)) {
      errors.push(`node ${JSON.stringify(node.id)}: id must match ${NODE_ID_PATTERN}`);
    }
    if (nodesById.has(node.id)) {
      errors.push(`duplicate node id ${JSON.stringify(node.id)}`);
      continue;
    }
    nodesById.set(node.id, node);
  }

  // Exactly one trigger node, and it must have no incoming edges.
  const triggerNodes = definition.nodes.filter((n) => n.type === 'trigger');
  if (triggerNodes.length !== 1) {
    errors.push(`expected exactly one trigger node, found ${triggerNodes.length}`);
  }
  const triggerIds = new Set(triggerNodes.map((n) => n.id));

  // Every id a template may reference via `nodes.<id>`: top-level nodes plus
  // foreach body ids (body results checkpoint under the body's own id).
  const referenceableIds = new Set(nodesById.keys());
  // Foreach aliases are in scope inside bodies; collecting them globally is
  // deliberately looser than exact scoping — a linter false-negative beats a
  // false-positive that blocks a valid save.
  const aliasRoots = new Set<string>();
  for (const node of definition.nodes) {
    if (node.type !== 'foreach') continue;
    aliasRoots.add(typeof node.itemAlias === 'string' ? node.itemAlias : 'item');
    aliasRoots.add(typeof node.indexAlias === 'string' ? node.indexAlias : 'index');
    if (typeof node.body === 'object' && node.body !== null && typeof node.body.id === 'string') {
      referenceableIds.add(node.body.id);
    }
  }
  const refCtx: RefContext = { referenceableIds, aliasRoots };

  // ── Edges ────────────────────────────────────────────────────────────────
  const seenEdges = new Set<string>();
  for (const [i, edge] of definition.edges.entries()) {
    if (typeof edge !== 'object' || edge === null || typeof edge.from !== 'string' || typeof edge.to !== 'string') {
      errors.push(`edge[${i}]: must be an object with string "from" and "to" node ids`);
      continue;
    }
    const fromNode = nodesById.get(edge.from);
    const toNode = nodesById.get(edge.to);
    if (!fromNode) {
      errors.push(`edge[${i}]: unknown source node ${JSON.stringify(edge.from)}${didYouMean(edge.from, [...nodesById.keys()])}`);
    }
    if (!toNode) {
      errors.push(`edge[${i}]: unknown target node ${JSON.stringify(edge.to)}${didYouMean(edge.to, [...nodesById.keys()])}`);
    }
    if (edge.from === edge.to) {
      errors.push(`edge[${i}]: cannot connect node ${JSON.stringify(edge.from)} to itself`);
    }
    const key = `${edge.from} ${edge.to} ${edge.fromOutput ?? ''}`;
    if (seenEdges.has(key)) {
      errors.push(`edge[${i}]: duplicate edge ${JSON.stringify(edge.from)} → ${JSON.stringify(edge.to)}`);
    }
    seenEdges.add(key);
    if (triggerIds.has(edge.to)) {
      errors.push(`edge[${i}]: trigger node ${JSON.stringify(edge.to)} cannot have incoming edges`);
    }
    if (fromNode) {
      if (fromNode.type === 'stop') {
        errors.push(`edge[${i}]: stop node ${JSON.stringify(edge.from)} cannot have outgoing edges`);
      }
      if (fromNode.type === 'if' || fromNode.type === 'approval') {
        if (fromNode.type === 'if' && edge.fromOutput === undefined) {
          errors.push(
            `edge[${i}]: edges leaving if node ${JSON.stringify(edge.from)} must declare fromOutput: "true" or "false"`,
          );
        }
        if (edge.fromOutput !== undefined && edge.fromOutput !== 'true' && edge.fromOutput !== 'false') {
          errors.push(
            `edge[${i}]: fromOutput must be the string "true" or "false", got ${JSON.stringify(edge.fromOutput)}`,
          );
        }
      } else if (edge.fromOutput !== undefined) {
        errors.push(
          `edge[${i}]: fromOutput is only valid on edges leaving "if" or "approval" nodes, ` +
            `not ${JSON.stringify(fromNode.type)}`,
        );
      }
    }
    if (edge.when !== undefined) {
      if (typeof edge.when !== 'string') {
        errors.push(`edge[${i}]: "when" must be an expression string`);
      } else {
        checkExpression(`edge[${i}] (${edge.from} → ${edge.to})`, 'when', edge.when, refCtx, errors);
      }
    }
  }

  // ── Cycles ───────────────────────────────────────────────────────────────
  const adjacency = new Map<string, string[]>();
  for (const edge of definition.edges) {
    if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) continue;
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }
  const cycleNode = findCycle(nodesById, adjacency);
  if (cycleNode) {
    errors.push(`cycle detected involving node ${JSON.stringify(cycleNode)} — a workflow must be a DAG`);
  }

  // ── Reachability ────────────────────────────────────────────────────────
  // Only meaningful once the graph is otherwise coherent (single trigger,
  // no unknown edge endpoints) — nested under that guard so a typo'd edge
  // doesn't ALSO drown the author in unreachable-node noise.
  if (triggerNodes.length === 1 && errors.length === 0) {
    const reachable = new Set<string>([triggerNodes[0]!.id]);
    const queue = [triggerNodes[0]!.id];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const next of adjacency.get(cur) ?? []) {
        if (!reachable.has(next)) {
          reachable.add(next);
          queue.push(next);
        }
      }
    }
    for (const id of nodesById.keys()) {
      if (!reachable.has(id)) {
        errors.push(
          `node ${JSON.stringify(id)} is unreachable — add an edge path from the trigger (${JSON.stringify(triggerNodes[0]!.id)}) to it`,
        );
      }
    }
  }

  // ── Per-node field checks ────────────────────────────────────────────────
  for (const node of definition.nodes) {
    if (!SUPPORTED_NODE_TYPES.has(node.type)) continue;
    lintNodeKeys(node, `node ${JSON.stringify(node.id)}`, errors);
    validateNodeFields(node, `node ${JSON.stringify(node.id)}`, refCtx, env, errors);
    if (node.type === 'foreach') {
      validateForeachNode(node, nodesById, refCtx, env, errors);
    }
  }

  validateForeachBodyIdUniqueness(definition, errors);

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// ─── Unknown-key lint ────────────────────────────────────────────────────────

function lintNodeKeys(node: WorkflowNode, label: string, errors: string[]): void {
  const allowed = ALLOWED_KEYS[node.type];
  const record = node as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (allowed.includes(key)) continue;
    if (key === 'config' && typeof record.config === 'object' && record.config !== null) {
      // THE observed LLM mistake: nesting fields under `config`.
      const moved = Object.keys(record.config as Record<string, unknown>).join(', ');
      errors.push(
        `${label}: fields live flat on the node, not under "config" — move { ${moved} } up to the node level`,
      );
      continue;
    }
    errors.push(`${label}: unknown field ${JSON.stringify(key)} on a ${JSON.stringify(node.type)} node${didYouMean(key, allowed)}`);
  }
}

// ─── Per-type field validation ───────────────────────────────────────────────

function validateNodeFields(
  node: WorkflowNode,
  label: string,
  refCtx: RefContext,
  env: ValidateEnvironment,
  errors: string[],
): void {
  switch (node.type) {
    case 'trigger':
      if (node.dataSchema !== undefined && !isPlainObject(node.dataSchema)) {
        errors.push(`${label}: trigger.dataSchema must be an object`);
      }
      break;
    case 'set':
      if (!isPlainObject(node.values)) {
        errors.push(`${label}: set.values must be an object mapping names to values`);
      } else {
        checkJsonTemplates(label, 'values', node.values, refCtx, errors);
      }
      break;
    case 'if':
      validateIfNode(node, label, refCtx, errors);
      break;
    case 'wait':
      if (node.mode !== 'duration') {
        errors.push(`${label}: wait.mode must be the string "duration"`);
      }
      if (typeof node.duration !== 'string' || parseDurationMs(node.duration) === null) {
        errors.push(
          `${label}: unparseable wait.duration ${JSON.stringify(node.duration)} — use a number + unit like "30s", "5m", "2h"`,
        );
      }
      break;
    case 'approval':
      if (!isNonEmptyString(node.prompt)) {
        errors.push(`${label}: approval.prompt must be a non-empty string (shown to the approver)`);
      } else {
        checkTemplate(label, 'prompt', node.prompt, refCtx, errors);
      }
      if (node.summary !== undefined && typeof node.summary === 'string') {
        checkTemplate(label, 'summary', node.summary, refCtx, errors);
      }
      if (node.timeout !== undefined && (typeof node.timeout !== 'string' || parseDurationMs(node.timeout) === null)) {
        errors.push(`${label}: unparseable approval.timeout ${JSON.stringify(node.timeout)}`);
      }
      if (node.onDeny !== undefined && node.onDeny !== 'fail' && node.onDeny !== 'skip') {
        errors.push(`${label}: approval.onDeny must be "fail" or "skip", got ${JSON.stringify(node.onDeny)}`);
      }
      checkJsonTemplates(label, 'details', node.details, refCtx, errors);
      break;
    case 'session':
      if (node.mode !== 'start') {
        errors.push(`${label}: session.mode must be the string "start"`);
      }
      if (!isNonEmptyString(node.prompt)) {
        errors.push(`${label}: session.prompt must be a non-empty string`);
      } else {
        checkTemplate(label, 'prompt', node.prompt, refCtx, errors);
      }
      if (node.title !== undefined && typeof node.title === 'string') {
        checkTemplate(label, 'title', node.title, refCtx, errors);
      }
      if (node.wait?.timeout !== undefined) {
        errors.push(`${label}: session wait.timeout is not implemented — omit it`);
      }
      checkModel(label, 'session.model', node.model, env, errors);
      break;
    case 'stop':
      if (node.outcome !== undefined && node.outcome !== 'success' && node.outcome !== 'failure') {
        errors.push(`${label}: stop.outcome must be "success" or "failure", got ${JSON.stringify(node.outcome)}`);
      }
      if (node.message !== undefined && typeof node.message === 'string') {
        checkTemplate(label, 'message', node.message, refCtx, errors);
      }
      checkJsonTemplates(label, 'output', node.output, refCtx, errors);
      break;
    case 'llm':
      if (!isNonEmptyString(node.model)) {
        errors.push(`${label}: llm.model must be a non-empty string (e.g. "claude-haiku-4-5" or "anthropic/claude-haiku-4-5")`);
      } else {
        checkModel(label, 'llm.model', node.model, env, errors);
      }
      if (!isNonEmptyString(node.prompt)) {
        errors.push(`${label}: llm.prompt must be a non-empty string`);
      } else {
        checkTemplate(label, 'prompt', node.prompt, refCtx, errors);
      }
      if (node.system !== undefined && typeof node.system === 'string') {
        checkTemplate(label, 'system', node.system, refCtx, errors);
      }
      if (node.temperature !== undefined && (typeof node.temperature !== 'number' || node.temperature < 0 || node.temperature > 2)) {
        errors.push(`${label}: llm.temperature must be a number between 0 and 2`);
      }
      if (node.maxOutputTokens !== undefined && !isPositiveInteger(node.maxOutputTokens)) {
        errors.push(`${label}: llm.maxOutputTokens must be a positive integer`);
      }
      break;
    case 'orchestrator':
      if (!isNonEmptyString(node.prompt)) {
        errors.push(`${label}: orchestrator.prompt must be a non-empty string`);
      } else {
        checkTemplate(label, 'prompt', node.prompt, refCtx, errors);
      }
      break;
    case 'tool':
      if (!isNonEmptyString(node.service)) {
        errors.push(`${label}: tool.service must be a non-empty string (the plugin service, e.g. "github")`);
      }
      if (!isNonEmptyString(node.action)) {
        errors.push(`${label}: tool.action must be a non-empty string (the action name, e.g. "create_issue")`);
      }
      if (!isPlainObject(node.params)) {
        errors.push(`${label}: tool.params must be an object (use {} when the action takes no parameters)`);
      } else {
        checkJsonTemplates(label, 'params', node.params, refCtx, errors);
      }
      if (isNonEmptyString(node.service) && isNonEmptyString(node.action) && env.isKnownAction) {
        const verdict = env.isKnownAction(node.service, node.action);
        if (verdict === 'unknown-service') {
          errors.push(`${label}: unknown tool.service ${JSON.stringify(node.service)} — use list_tools to see available services`);
        } else if (verdict === 'unknown-action') {
          errors.push(
            `${label}: service ${JSON.stringify(node.service)} has no action ${JSON.stringify(node.action)} — use list_tools to see its actions`,
          );
        }
      }
      if (node.summary !== undefined && typeof node.summary === 'string') {
        checkTemplate(label, 'summary', node.summary, refCtx, errors);
      }
      break;
    case 'foreach':
      // Field checks live in validateForeachNode (needs nodesById).
      break;
  }
}

function validateIfNode(node: IfNode, label: string, refCtx: RefContext, errors: string[]): void {
  if (node.combinator !== undefined && node.combinator !== 'and' && node.combinator !== 'or') {
    errors.push(`${label}: if.combinator must be "and" or "or", got ${JSON.stringify(node.combinator)}`);
  }
  if (!Array.isArray(node.conditions)) {
    errors.push(
      `${label}: if.conditions must be an array of { left, dataType, operation, right? } objects` +
        (hasKey(node, 'condition') ? ' — you wrote "condition"; the field is "conditions" (an array)' : ''),
    );
    return;
  }
  if (node.conditions.length === 0) {
    errors.push(`${label}: if.conditions must contain at least one condition`);
  }
  for (const [i, cond] of node.conditions.entries()) {
    const cLabel = `${label} conditions[${i}]`;
    if (!isPlainObject(cond)) {
      errors.push(`${cLabel}: must be an object with { left, dataType, operation, right? }`);
      continue;
    }
    for (const key of Object.keys(cond)) {
      if (!IF_CONDITION_KEYS.includes(key)) {
        errors.push(`${cLabel}: unknown field ${JSON.stringify(key)}${didYouMean(key, IF_CONDITION_KEYS)}`);
      }
    }
    if (!isNonEmptyString(cond.left)) {
      errors.push(`${cLabel}: "left" must be a non-empty expression string (e.g. "nodes.classify.result.severity")`);
    } else {
      checkExpression(cLabel, 'left', cond.left, refCtx, errors);
    }
    if (typeof cond.dataType !== 'string' || !IF_DATA_TYPES.has(cond.dataType)) {
      errors.push(
        `${cLabel}: "dataType" must be one of ${[...IF_DATA_TYPES].join(', ')}, got ${JSON.stringify(cond.dataType)}`,
      );
      continue;
    }
    if (!isNonEmptyString(cond.operation)) {
      errors.push(`${cLabel}: "operation" must be a string (e.g. "equals")`);
      continue;
    }
    const dataType = cond.dataType as IfDataType;
    if (!isIfOperationSupported(dataType, cond.operation)) {
      errors.push(
        `${cLabel}: unsupported ${dataType} operation ${JSON.stringify(cond.operation)} — allowed: ${allowedIfOperations(dataType).join(', ')}`,
      );
    } else if (normalizeIfOperation(cond.operation) === 'matchesRegex' && typeof cond.right === 'string') {
      try {
        new RegExp(cond.right);
      } catch (err) {
        errors.push(`${cLabel}: matchesRegex pattern is not a valid regular expression: ${(err as Error).message}`);
      }
    }
  }
}

// ─── foreach ────────────────────────────────────────────────────────────────

/** Reserved template-context keys `itemAlias`/`indexAlias` must not shadow (they're spread last in `resolveTemplateContext`). */
const RESERVED_ALIAS_NAMES: ReadonlySet<string> = new Set(['trigger', 'nodes']);

function validateForeachNode(
  node: ForeachNode,
  nodesById: Map<string, WorkflowNode>,
  refCtx: RefContext,
  env: ValidateEnvironment,
  errors: string[],
): void {
  const label = `node ${JSON.stringify(node.id)}`;
  if (!isNonEmptyString(node.items)) {
    errors.push(`${label}: foreach.items must be a non-empty template string resolving to an array (e.g. "{{nodes.fetch.result.runs}}")`);
  } else {
    checkTemplate(label, 'items', node.items, refCtx, errors);
  }

  if (node.itemAlias !== undefined && RESERVED_ALIAS_NAMES.has(node.itemAlias)) {
    errors.push(`${label}: foreach.itemAlias must not be ${JSON.stringify(node.itemAlias)} (shadows the template context)`);
  }
  if (node.indexAlias !== undefined && RESERVED_ALIAS_NAMES.has(node.indexAlias)) {
    errors.push(`${label}: foreach.indexAlias must not be ${JSON.stringify(node.indexAlias)} (shadows the template context)`);
  }
  if (node.onItemError !== undefined && !['fail', 'skip', 'collect'].includes(node.onItemError)) {
    errors.push(`${label}: foreach.onItemError must be "fail", "skip", or "collect"`);
  }

  if (!isPlainObject(node.body) || typeof node.body.type !== 'string') {
    errors.push(`${label}: foreach.body must be a single inline node object (llm/tool/set/orchestrator/session)`);
    return;
  }
  if (!FOREACH_BODY_TYPES.has(node.body.type)) {
    errors.push(
      `${label}: foreach.body type ${JSON.stringify(node.body.type)} is not allowed ` +
        `(must be one of ${[...FOREACH_BODY_TYPES].join(', ')})`,
    );
  } else {
    const bodyLabel = `node ${JSON.stringify(`${node.id}.body (${node.body.id})`)}`;
    lintNodeKeys(node.body, bodyLabel, errors);
    validateNodeFields(node.body, bodyLabel, refCtx, env, errors);
  }

  if (typeof node.body.id === 'string' && nodesById.has(node.body.id)) {
    errors.push(`${label}: foreach.body id ${JSON.stringify(node.body.id)} collides with a definition node id`);
  }

  if (node.maxItems !== undefined && !isPositiveInteger(node.maxItems)) {
    errors.push(`${label}: foreach.maxItems must be a positive integer`);
  }
  if (node.concurrency !== undefined) {
    if (!isPositiveInteger(node.concurrency)) {
      errors.push(`${label}: foreach.concurrency must be a positive integer`);
    } else if (node.concurrency > 10) {
      errors.push(`${label}: foreach.concurrency must be <= 10`);
    }
  }
}

/**
 * A foreach body id must be unique not just against `definition.nodes`
 * (checked per-node in `validateForeachNode`) but against every OTHER
 * foreach's body id too — two foreach nodes sharing a body id would have
 * their checkpoints collide at `(runId, body.id, i)`, silently merging
 * both foreaches' per-item state.
 */
function validateForeachBodyIdUniqueness(definition: WorkflowDefinition, errors: string[]): void {
  const foreachIdsByBodyId = new Map<string, string[]>();
  for (const node of definition.nodes) {
    if (node.type !== 'foreach') continue;
    if (!isPlainObject(node.body) || typeof node.body.id !== 'string') continue;
    const owners = foreachIdsByBodyId.get(node.body.id) ?? [];
    owners.push(node.id);
    foreachIdsByBodyId.set(node.body.id, owners);
  }
  for (const [bodyId, owners] of foreachIdsByBodyId) {
    if (owners.length < 2) continue;
    errors.push(
      `foreach.body id ${JSON.stringify(bodyId)} is used by multiple foreach nodes: ${owners.map((id) => JSON.stringify(id)).join(', ')}`,
    );
  }
}

// ─── Template / expression / reference checks ────────────────────────────────

interface RefContext {
  referenceableIds: Set<string>;
  aliasRoots: Set<string>;
}

function checkTemplate(label: string, field: string, source: string, refCtx: RefContext, errors: string[]): void {
  let paths: string[][];
  try {
    parseTemplate(source);
    paths = collectTemplatePaths(source);
  } catch (err) {
    errors.push(`${label}: ${field} template does not parse — ${parseMessage(err)}${hyphenHint(source)}`);
    return;
  }
  checkPathRefs(label, field, paths, refCtx, errors);
}

function checkExpression(label: string, field: string, source: string, refCtx: RefContext, errors: string[]): void {
  let paths: string[][];
  try {
    parseExpression(source);
    paths = collectExpressionPaths(source);
  } catch (err) {
    errors.push(`${label}: ${field} expression does not parse — ${parseMessage(err)}${hyphenHint(source)}`);
    return;
  }
  checkPathRefs(label, field, paths, refCtx, errors);
}

/** Walk arbitrary JSON and template-check every string leaf. */
function checkJsonTemplates(label: string, field: string, value: unknown, refCtx: RefContext, errors: string[]): void {
  if (typeof value === 'string') {
    checkTemplate(label, field, value, refCtx, errors);
    return;
  }
  if (Array.isArray(value)) {
    for (const [i, entry] of value.entries()) {
      checkJsonTemplates(label, `${field}[${i}]`, entry, refCtx, errors);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      checkJsonTemplates(label, `${field}.${key}`, entry, refCtx, errors);
    }
  }
}

function checkPathRefs(label: string, field: string, paths: string[][], refCtx: RefContext, errors: string[]): void {
  for (const segments of paths) {
    const root = segments[0];
    if (root === undefined) continue;
    if (root === 'trigger' || refCtx.aliasRoots.has(root)) continue;
    if (root === 'nodes') {
      const target = segments[1];
      if (target === undefined) {
        errors.push(`${label}: ${field} references "nodes" without a node id — use nodes.<id>.result...`);
      } else if (!refCtx.referenceableIds.has(target)) {
        errors.push(
          `${label}: ${field} references unknown node ${JSON.stringify(target)}${didYouMean(target, [...refCtx.referenceableIds])}`,
        );
      }
      continue;
    }
    // Unknown root. The most common author mistake is `{{myNode.x}}`
    // instead of `{{nodes.myNode.x}}` — detect and hint precisely.
    const asNodeRef = refCtx.referenceableIds.has(root) ? ` — node outputs are read via "nodes.${root}..."` : '';
    errors.push(
      `${label}: ${field} references unknown root ${JSON.stringify(root)} (available: trigger, nodes${refCtx.aliasRoots.size > 0 ? ', ' + [...refCtx.aliasRoots].join(', ') : ''})${asNodeRef}`,
    );
  }
}

function parseMessage(err: unknown): string {
  return err instanceof TemplateParseError ? err.message : err instanceof Error ? err.message : 'parse failure';
}

/** Node ids containing "-" need bracket notation inside expressions. */
function hyphenHint(source: string): string {
  const match = source.match(/\bnodes\.([A-Za-z_][A-Za-z0-9_]*-[A-Za-z0-9_-]*)/);
  if (!match) return '';
  return `. Node ids containing "-" must use bracket notation, e.g. nodes["${match[1]}"].result`;
}

// ─── model hook ─────────────────────────────────────────────────────────────

function checkModel(
  label: string,
  field: string,
  model: string | undefined,
  env: ValidateEnvironment,
  errors: string[],
): void {
  if (model === undefined) return;
  if (typeof model !== 'string' || model.trim() === '') {
    errors.push(`${label}: ${field} must be a non-empty string when present`);
    return;
  }
  if (env.isKnownModel && !env.isKnownModel(model)) {
    errors.push(
      `${label}: unknown ${field} ${JSON.stringify(model)} — use a known model id like "claude-haiku-4-5", or "provider/model" form`,
    );
  }
}

// ─── small shared helpers ───────────────────────────────────────────────────

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

function hasKey(value: unknown, key: string): boolean {
  return isPlainObject(value) && key in value;
}

/** ` — did you mean "x"?` when a close match exists, else "". */
export function didYouMean(input: string, candidates: readonly string[]): string {
  let best: string | null = null;
  let bestDist = 3; // only suggest within edit distance 2
  for (const candidate of candidates) {
    const dist = editDistance(input.toLowerCase(), candidate.toLowerCase(), bestDist);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best ? ` — did you mean ${JSON.stringify(best)}?` : '';
}

/** Bounded Levenshtein — bails once the distance exceeds `limit`. */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      rowMin = Math.min(rowMin, cur[j]!);
    }
    if (rowMin > limit) return limit + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

function findCycle(nodesById: Map<string, WorkflowNode>, adjacency: Map<string, string[]>): string | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of nodesById.keys()) color.set(id, WHITE);

  let cycleNode: string | null = null;

  function visit(id: string): boolean {
    color.set(id, GRAY);
    for (const next of adjacency.get(id) ?? []) {
      const c = color.get(next);
      if (c === GRAY) {
        cycleNode = next;
        return true;
      }
      if (c === WHITE && visit(next)) return true;
    }
    color.set(id, BLACK);
    return false;
  }

  for (const id of nodesById.keys()) {
    if (color.get(id) === WHITE && visit(id)) return cycleNode;
  }
  return null;
}
