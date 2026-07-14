/**
 * The `WorkflowEngineDeps` port (Phase 5 plan decision 15) — the sliver of
 * `@valet/engine`'s Workflow Caller Contract the interpreter and node
 * executors are allowed to touch. Interface only this task; implemented
 * over `EngineHost` in `packages/api/src/workflows/engine-deps.ts` (Task
 * 10) and stubbed for unit tests here.
 *
 * Deliberately narrower than the engine's own `CreateSessionOptions` /
 * `PromptOptions` — workflow nodes never need workspace wiring, channel
 * targets, or queue-mode steering beyond what the session/wait/approval
 * executors (Tasks 5, 7) require.
 */

import type { QueueMode, SessionPurpose, SubmissionResult } from '@valet/engine';
import type { TSchema } from 'typebox';

export interface WorkflowCreateSessionOptions {
  id: string;
  title?: string;
  purpose: SessionPurpose;
}

export interface WorkflowPromptOptions {
  /** Idempotent admission key: `workflow:{runId}:{nodeId}[:{iteration}][:repair]`. */
  dispatchId: string;
  model?: string;
  queueMode?: QueueMode;
}

export interface WorkflowPromptReceipt {
  threadId: string;
  queueItemId: string;
}

export interface WorkflowAwaitResultOptions {
  resultSchema?: TSchema;
}

/**
 * Engine surface available to node executors and the interpreter's cancel
 * path. All calls are idempotent by the ids the caller supplies (session
 * id, dispatchId) — re-issuing after a crash-between-dispatch-and-checkpoint
 * must return the original effect, never a duplicate or an error.
 */
export interface WorkflowEngineDeps {
  /** Idempotent by `opts.id`: creating an already-existing session returns it unchanged. */
  createSession(opts: WorkflowCreateSessionOptions): Promise<{ id: string }>;

  /** Idempotent by `opts.dispatchId`: a duplicate dispatch returns the original receipt. */
  prompt(sessionId: string, text: string, opts: WorkflowPromptOptions): Promise<WorkflowPromptReceipt>;

  /** Resumable: returns immediately for an already-settled submission. */
  awaitResult(
    sessionId: string,
    threadId: string,
    queueItemId: string,
    opts?: WorkflowAwaitResultOptions,
  ): Promise<SubmissionResult>;

  /** Withdraws in-flight engine work for a run being cancelled. */
  abort(sessionId: string, threadId: string): Promise<void>;

  /** Non-blocking settlement check, used by the lost-wake sweep (Task 8). */
  isSettled(sessionId: string, queueItemId: string): Promise<boolean>;
}
