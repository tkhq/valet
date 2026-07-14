/**
 * Lean dag/v1 validator (Phase 5 decision 5). Deliberately not a port of
 * main's 1349-line validator — just the checks the run host actually
 * depends on to interpret a definition safely.
 */

import { parseDurationMs } from './duration.js';
import type { WorkflowDefinition } from './shape.js';
import type { DagNodeType, WorkflowNode } from './nodes.js';

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
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
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
