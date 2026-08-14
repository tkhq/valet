/**
 * Top-level shape of a workflow definition and its non-node primitives.
 * Node type interfaces live in `./nodes.ts`.
 *
 * Lifted from `main`'s `packages/shared/src/types/workflow-dag/shape.ts`.
 * Phase 5 dropped the editor-only `ui`/`WorkflowEditorState` field (no
 * visual editor that phase); the node-completion-plan re-adds it
 * (decision 2) — the interpreter and validator both tolerate it
 * structurally without interpreting its contents.
 */

import type { WorkflowNode } from './nodes.js';

export interface WorkflowDefinition {
  version: 'dag/v1';
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  policy?: WorkflowPolicy;
  ui?: WorkflowEditorState;
}

export interface WorkflowEditorState {
  nodes: Record<
    string,
    {
      position: { x: number; y: number };
      collapsed?: boolean;
    }
  >;
  viewport?: { x: number; y: number; zoom: number };
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
  type: 'manual' | 'schedule' | 'webhook' | 'event' | 'workflow';
  triggerId?: string;
  timestamp: string;
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
}
