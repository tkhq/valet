/**
 * Top-level shape of a workflow definition and its non-node primitives.
 * Node type interfaces live in `./nodes.ts`.
 *
 * Lifted from `main`'s `packages/shared/src/types/workflow-dag/shape.ts`
 * per Phase 5 decision 2: the editor-only `ui`/`WorkflowEditorState` field
 * is dropped — this package has no visual editor this phase.
 */

import type { WorkflowNode } from './nodes.js';

export interface WorkflowDefinition {
  version: 'dag/v1';
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  policy?: WorkflowPolicy;
}

export interface WorkflowInputDefinition {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  default?: unknown;
  description?: string;
  enum?: unknown[];
}

export interface WorkflowPolicy {
  maxNodes?: number;
  maxConcurrentNodes?: number;
  maxWaitDurationMs?: number;
  maxForeachItems?: number;
  maxForeachConcurrency?: number;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  fromOutput?: 'true' | 'false';
  when?: string;
}

// ─── Runtime payloads ────────────────────────────────────────────────────────

export interface WorkflowTriggerPayload {
  type: 'manual' | 'schedule' | 'webhook';
  triggerId?: string;
  timestamp: string;
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
}
