/**
 * dag/v1 node interfaces — the seven node types supported by Phase 5's
 * workflow run host (`trigger`, `set`, `if`, `wait`, `approval`, `session`,
 * `stop`).
 *
 * Lifted from `main`'s `packages/shared/src/types/workflow-dag/nodes/*.ts`
 * per Phase 5 decision 2: `NodeDocs` objects and `createDefault*` factories
 * (editor concerns) are dropped, keeping only the interfaces. Node types
 * `llm`, `tool`, `foreach`, `orchestrator` are out of this phase (see plan
 * Global Constraints) and are not part of the `WorkflowNode` union.
 *
 * `SessionNode` is trimmed per decision 3 to start-mode only: `workspace`,
 * `personaId`, `repairModel`, `resultMode`, `repo`, and prompt-mode are all
 * dropped (deferred; repo/persona need Phase 6 platform pieces).
 */

import type { WorkflowInputDefinition } from './shape.js';

export interface TriggerNode {
  id: string;
  type: 'trigger';
  dataSchema?: Record<string, WorkflowInputDefinition>;
}

export interface SetNode {
  id: string;
  type: 'set';
  values: unknown;
}

export interface IfCondition {
  left: string;
  dataType: 'string' | 'number' | 'date' | 'boolean' | 'array' | 'object';
  operation: string;
  right?: unknown;
}

export interface IfNode {
  id: string;
  type: 'if';
  combinator?: 'and' | 'or';
  conditions: IfCondition[];
}

export interface WaitNode {
  id: string;
  type: 'wait';
  mode: 'duration';
  duration: string;
}

export interface ApprovalNode {
  id: string;
  type: 'approval';
  prompt: string;
  summary?: string;
  details?: unknown;
  timeout?: string;
  onDeny?: 'fail' | 'skip';
}

// Session node — start-mode only this phase (decision 3).
export interface SessionNode {
  id: string;
  type: 'session';
  mode: 'start';
  prompt: string;
  title?: string;
  model?: string;
  outputSchema?: Record<string, unknown>;
  wait?: {
    mode: 'none' | 'until_idle';
    timeout?: string;
  };
}

export interface StopNode {
  id: string;
  type: 'stop';
  outcome?: 'success' | 'failure';
  output?: unknown;
  message?: string;
}

// ─── Discriminated union ─────────────────────────────────────────────────────

export type WorkflowNode = TriggerNode | SetNode | IfNode | WaitNode | ApprovalNode | SessionNode | StopNode;

export type DagNodeType = WorkflowNode['type'];
