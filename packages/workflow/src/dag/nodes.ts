/**
 * dag/v1 node interfaces — the eleven node types supported by the workflow
 * run host (`trigger`, `set`, `if`, `wait`, `approval`, `session`, `stop`,
 * `foreach`, `llm`, `orchestrator`, `tool`).
 *
 * Lifted from `main`'s `packages/shared/src/types/workflow-dag/nodes/*.ts`
 * per Phase 5 decision 2 / node-completion-plan decision 1: `NodeDocs`
 * objects and `createDefault*` factories (editor concerns) are dropped,
 * keeping only the interfaces.
 *
 * `SessionNode` is trimmed per decision 3 to start-mode only: `workspace`,
 * `personaId`, `repairModel`, `resultMode`, `repo`, and prompt-mode are all
 * dropped (deferred; repo/persona need Phase 6 platform pieces).
 *
 * `LlmNode`, `OrchestratorNode`, `ToolNode`, `ForeachNode` are trimmed per
 * the node-completion-plan decision 1:
 *   - `LlmNode.model` is REQUIRED (main allowed omitting it and throwing at
 *     runtime; v2 rejects that at validation instead).
 *   - `OrchestratorNode` drops `forceNewThread`/`repairModel`/`resultMode`/
 *     `wait.timeout` (same trims as `SessionNode`).
 *   - `ToolNode` drops `onPolicyDeny`/`retries` (Phase 6 re-adds with
 *     policy).
 *   - `ForeachNode`'s body union drops `StopNode` (v2-specific — stopping a
 *     run from inside a loop iteration interacts badly with the wave
 *     model) and never included `IfNode`/`ApprovalNode`/`ForeachNode`.
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

export interface LlmNode {
  id: string;
  type: 'llm';
  model: string;
  system?: string;
  prompt: string;
  outputSchema?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
}

// Orchestrator node — trimmed per decision 1 (same trims as SessionNode).
export interface OrchestratorNode {
  id: string;
  type: 'orchestrator';
  prompt: string;
  outputSchema?: Record<string, unknown>;
  wait?: {
    mode: 'none' | 'until_idle';
  };
}

// Tool node — trimmed per decision 1: drops onPolicyDeny/retries (Phase 6
// re-adds these with policy).
export interface ToolNode {
  id: string;
  type: 'tool';
  service: string;
  action: string;
  params: Record<string, unknown>;
  summary?: string;
}

/**
 * Body of a foreach is restricted — no nested foreach, no if/approval
 * (control flow lives at the DAG level), no stop (stopping a run from
 * inside a loop iteration interacts badly with the wave model). The
 * runtime executes one body per item.
 */
export type ForeachBodyNode = LlmNode | ToolNode | SetNode | OrchestratorNode | SessionNode;

export interface ForeachNode {
  id: string;
  type: 'foreach';
  items: string;
  body: ForeachBodyNode;
  maxItems?: number;
  concurrency?: number;
  itemAlias?: string;
  indexAlias?: string;
  onItemError?: 'fail' | 'skip' | 'collect';
}

// ─── Discriminated union ─────────────────────────────────────────────────────

export type WorkflowNode =
  | TriggerNode
  | SetNode
  | IfNode
  | WaitNode
  | ApprovalNode
  | SessionNode
  | StopNode
  | ForeachNode
  | LlmNode
  | OrchestratorNode
  | ToolNode;

export type DagNodeType = WorkflowNode['type'];
