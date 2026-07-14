/**
 * Lean dag/v1 validator (Phase 5 decision 5). Deliberately not a port of
 * main's 1349-line validator — just the checks the run host actually
 * depends on to interpret a definition safely.
 */

import { parseDurationMs } from './duration.js';
import type { WorkflowDefinition } from './shape.js';
import type { DagNodeType, ForeachNode, WorkflowNode } from './nodes.js';

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

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

export function validateWorkflowDefinition(definition: WorkflowDefinition): ValidationResult {
  const errors: string[] = [];

  if (definition.version !== 'dag/v1') {
    errors.push(`unsupported version ${JSON.stringify(definition.version)}: expected "dag/v1"`);
  }

  const nodesById = new Map<string, WorkflowNode>();
  for (const node of definition.nodes) {
    if (!SUPPORTED_NODE_TYPES.has(node.type)) {
      errors.push(`node ${JSON.stringify(node.id)}: unsupported node type ${JSON.stringify(node.type)}`);
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

  // Edges: reference known nodes, fromOutput only on if/approval sources.
  for (const [i, edge] of definition.edges.entries()) {
    const fromNode = nodesById.get(edge.from);
    const toNode = nodesById.get(edge.to);
    if (!fromNode) {
      errors.push(`edge[${i}]: unknown source node ${JSON.stringify(edge.from)}`);
    }
    if (!toNode) {
      errors.push(`edge[${i}]: unknown target node ${JSON.stringify(edge.to)}`);
    }
    if (triggerIds.has(edge.to)) {
      errors.push(`edge[${i}]: trigger node ${JSON.stringify(edge.to)} cannot have incoming edges`);
    }
    if (edge.fromOutput !== undefined && fromNode && fromNode.type !== 'if' && fromNode.type !== 'approval') {
      errors.push(
        `edge[${i}]: fromOutput is only valid on edges leaving "if" or "approval" nodes, ` +
          `not ${JSON.stringify(fromNode.type)}`,
      );
    }
  }

  // Cycle detection (DFS over nodes that resolved to a known id on both ends).
  const adjacency = new Map<string, string[]>();
  for (const edge of definition.edges) {
    if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) continue;
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }
  const cycleNode = findCycle(nodesById, adjacency);
  if (cycleNode) {
    errors.push(`cycle detected involving node ${JSON.stringify(cycleNode)}`);
  }

  // Node-level field checks.
  for (const node of definition.nodes) {
    if (node.type === 'wait') {
      if (parseDurationMs(node.duration) === null) {
        errors.push(`node ${JSON.stringify(node.id)}: unparseable wait.duration ${JSON.stringify(node.duration)}`);
      }
    }
    if (node.type === 'approval' && node.timeout !== undefined) {
      if (parseDurationMs(node.timeout) === null) {
        errors.push(`node ${JSON.stringify(node.id)}: unparseable approval.timeout ${JSON.stringify(node.timeout)}`);
      }
    }
    validateStepNodeFields(node, errors, node.id);

    if (node.type === 'foreach') {
      validateForeachNode(node, nodesById, errors);
    }
  }

  validateForeachBodyIdUniqueness(definition, errors);

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
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

/**
 * Field-level rules shared by `llm`/`orchestrator`/`tool`/`session` nodes,
 * whether they appear at the top level of `definition.nodes` or as a foreach
 * body. `label` names the node (and, for a body, its owning foreach) in
 * error messages.
 */
function validateStepNodeFields(node: WorkflowNode, errors: string[], label: string): void {
  if (node.type === 'session' && node.wait?.timeout !== undefined) {
    errors.push(`node ${JSON.stringify(label)}: session wait.timeout is not implemented — omit it`);
  }
  if (node.type === 'llm') {
    if (node.model.trim() === '') {
      errors.push(`node ${JSON.stringify(label)}: llm.model must be a non-empty string`);
    }
    if (node.prompt.trim() === '') {
      errors.push(`node ${JSON.stringify(label)}: llm.prompt must be a non-empty string`);
    }
  }
  if (node.type === 'orchestrator') {
    if (node.prompt.trim() === '') {
      errors.push(`node ${JSON.stringify(label)}: orchestrator.prompt must be a non-empty string`);
    }
  }
  if (node.type === 'tool') {
    if (node.service.trim() === '') {
      errors.push(`node ${JSON.stringify(label)}: tool.service must be a non-empty string`);
    }
    if (node.action.trim() === '') {
      errors.push(`node ${JSON.stringify(label)}: tool.action must be a non-empty string`);
    }
  }
}

/** Reserved template-context keys `itemAlias`/`indexAlias` must not shadow (they're spread last in `resolveTemplateContext`). */
const RESERVED_ALIAS_NAMES: ReadonlySet<string> = new Set(['trigger', 'nodes']);

function validateForeachNode(node: ForeachNode, nodesById: Map<string, WorkflowNode>, errors: string[]): void {
  if (node.items.trim() === '') {
    errors.push(`node ${JSON.stringify(node.id)}: foreach.items must be a non-empty string`);
  }

  if (node.itemAlias !== undefined && RESERVED_ALIAS_NAMES.has(node.itemAlias)) {
    errors.push(
      `node ${JSON.stringify(node.id)}: foreach.itemAlias must not be ${JSON.stringify(node.itemAlias)} (shadows the template context)`,
    );
  }
  if (node.indexAlias !== undefined && RESERVED_ALIAS_NAMES.has(node.indexAlias)) {
    errors.push(
      `node ${JSON.stringify(node.id)}: foreach.indexAlias must not be ${JSON.stringify(node.indexAlias)} (shadows the template context)`,
    );
  }

  if (!FOREACH_BODY_TYPES.has(node.body.type)) {
    errors.push(
      `node ${JSON.stringify(node.id)}: foreach.body type ${JSON.stringify(node.body.type)} is not allowed ` +
        `(must be one of ${[...FOREACH_BODY_TYPES].join(', ')})`,
    );
  } else {
    const bodyLabel = `${node.id}.body (${node.body.id})`;
    validateStepNodeFields(node.body, errors, bodyLabel);
  }

  if (nodesById.has(node.body.id)) {
    errors.push(
      `node ${JSON.stringify(node.id)}: foreach.body id ${JSON.stringify(node.body.id)} collides with a definition node id`,
    );
  }

  if (node.maxItems !== undefined && !isPositiveInteger(node.maxItems)) {
    errors.push(`node ${JSON.stringify(node.id)}: foreach.maxItems must be a positive integer`);
  }
  if (node.concurrency !== undefined) {
    if (!isPositiveInteger(node.concurrency)) {
      errors.push(`node ${JSON.stringify(node.id)}: foreach.concurrency must be a positive integer`);
    } else if (node.concurrency > 10) {
      errors.push(`node ${JSON.stringify(node.id)}: foreach.concurrency must be <= 10`);
    }
  }
}

function isPositiveInteger(n: number): boolean {
  return Number.isInteger(n) && n > 0;
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
