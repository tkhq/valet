/**
 * Node executor contract + registry (Phase 5 plan decisions 8, 10).
 *
 * An executor owns the full checkpoint lifecycle for its node: it writes
 * its own `intent` checkpoint (via `store.putIntent`) before doing
 * anything externally visible, then either completes it
 * (`store.completeCheckpoint`, terminal `completed`/`failed`/`skipped`) or
 * — for effectful nodes not implemented this task (`wait`, `approval`,
 * `session`) — leaves the intent in place and returns `parked` with the
 * `RunWaitCondition`(s) it is now blocked on. All writes are fenced by
 * `attempt`; a `WorkflowFenceError` from the store means this executor's
 * attempt has been superseded and it must stop (the interpreter propagates
 * the throw, aborting the current `driveUntilPark` call — the next claim
 * re-drives from checkpoints).
 *
 * `trigger`/`set`/`if`/`stop` (this task) never park: they are pure,
 * synchronous, and complete in one call. `wait`/`approval`/`session`
 * (Tasks 5, 7) plug into the same `NodeExecutor` interface and this same
 * registry — no interpreter changes required when they land.
 */

import type { DagNodeType, WorkflowNode } from '../dag/nodes.js';
import type { TemplateContext } from '../dag/expression.js';
import type { WorkflowEngineDeps } from '../engine-deps.js';
import type { NodeCheckpoint, RunWaitCondition, WorkflowRun, WorkflowStore } from '../store.js';

/** What a workflow-approval-raising node calls when it first parks on an approval. */
export type OnApprovalPending = (info: {
  runId: string;
  nodeId: string;
  prompt: string;
  summary?: string;
  details?: unknown;
}) => Promise<void> | void;

export interface NodeExecutorArgs<TNode extends WorkflowNode = WorkflowNode> {
  run: WorkflowRun;
  node: TNode;
  /** The claimed attempt driving this run; every store write this executor makes must carry it. */
  attempt: number;
  /** Always 0 this phase (no `foreach` executor yet — the checkpoint PK already carries it for later). */
  iteration: number;
  /** `{ trigger, nodes }` — `nodes.<id>.output` is each resolved node's checkpoint result. */
  templateContext: TemplateContext;
  /** This node's checkpoint row from the current drive pass, if one already exists (resumption). */
  existingCheckpoint?: NodeCheckpoint;
  store: WorkflowStore;
  clock: () => number;
  engine: WorkflowEngineDeps;
  onApprovalPending?: OnApprovalPending;
}

export type NodeExecuteResult =
  | { status: 'completed'; result: unknown; terminate?: 'completed' | 'failed' }
  | { status: 'skipped'; result?: unknown }
  | { status: 'failed'; error: string; terminate?: 'completed' | 'failed' }
  | { status: 'parked'; waitingOn: RunWaitCondition[] };

export interface NodeExecutor<TNode extends WorkflowNode = WorkflowNode> {
  execute(args: NodeExecutorArgs<TNode>): Promise<NodeExecuteResult>;
}

export type NodeExecutorRegistry = {
  [K in DagNodeType]?: NodeExecutor<Extract<WorkflowNode, { type: K }>>;
};

export { executeTrigger } from './trigger.js';
export { executeSet } from './set.js';
export { executeIf } from './if.js';
export { executeStop } from './stop.js';

import { executeTrigger } from './trigger.js';
import { executeSet } from './set.js';
import { executeIf } from './if.js';
import { executeStop } from './stop.js';

/** The pure executors this task implements. `wait`/`approval`/`session` are added by later tasks. */
export function createDefaultNodeExecutors(): NodeExecutorRegistry {
  return {
    trigger: { execute: executeTrigger },
    set: { execute: executeSet },
    if: { execute: executeIf },
    stop: { execute: executeStop },
  };
}
