/**
 * Cloudflare Workflow entrypoint for the DAG interpreter.
 *
 * The wrangler `[[workflows]]` binding instantiates this class. Each
 * execution gets one instance whose `run` method drives the wave loop
 * in runtime.ts.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { runWorkflowDag } from './runtime.js';
import { finalizeAbandonedExecution } from './execution-status.js';
import { createD1TraceWriter } from './trace-writer.js';
import { emitWorkflowRunSpans } from '../lib/workflow-tracing.js';
import { isTracingEnabled } from '../lib/tracing.js';
import { NO_RETRY, type WorkflowRunParams, type WorkflowRunResult } from './types.js';

export class ValetWorkflowInterpreter extends WorkflowEntrypoint<Env, WorkflowRunParams> {
  override async run(
    event: Readonly<WorkflowEvent<WorkflowRunParams>>,
    step: WorkflowStep,
  ): Promise<WorkflowRunResult> {
    const traceWriter = createD1TraceWriter({
      env: this.env,
      mode: event.payload.mode ?? 'production',
    });
    let result: WorkflowRunResult;
    try {
      result = await runWorkflowDag(this.env, event, step, { traceWriter });
    } catch (err) {
      // A throw escaping the wave loop — a step that exhausted its retries,
      // a bug outside any step.do — errors this instance permanently. The
      // runtime's own terminal write lives at the end of runWorkflowDag and
      // is exactly what we just skipped, so without this the row keeps
      // whatever ACTIVE status it held and consumes one of the user's
      // concurrency slots for good. Ordinary node failures do NOT come
      // through here: those return a 'failed' result and persist their own
      // terminal status.
      //
      // Best-effort by construction. When D1 is the thing that broke, this
      // write fails too and the stale-execution sweep reclaims the row
      // later. What it must never do is replace the original error with its
      // own — that would turn a diagnosable failure into a mystery.
      const message = err instanceof Error ? err.message : String(err);
      try {
        await finalizeAbandonedExecution(this.env, event.payload.executionId, {
          status: 'failed',
          error: `workflow instance failed: ${message}`,
        });
      } catch (finalizeErr) {
        console.warn(
          `[workflow] could not finalize abandoned execution ${event.payload.executionId}:`,
          finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr),
        );
      }
      throw err;
    }

    // Retroactive span emission (see workflow-tracing.ts). step.do makes the
    // emit at-most-once per PERSISTED attempt — a crash between a successful
    // OTLP POST and the step checkpoint can still replay it (at-least-once
    // steps), which duplicates telemetry but never corrupts the run. NO_RETRY
    // keeps CF's default 5x policy off this non-idempotent side effect. Gated
    // up front so disabled deployments don't accrue a no-op step per run, and
    // try/caught because observability must never fail a completed run —
    // emitWorkflowRunSpans itself never throws, this guards step.do.
    if (isTracingEnabled(this.env)) {
      try {
        await step.do(`otel-emit:${event.payload.executionId}`, { retries: { ...NO_RETRY } }, () =>
          emitWorkflowRunSpans(this.env, event.payload, result));
      } catch (err) {
        console.warn(`[workflow-tracing] emit step failed for ${event.payload.executionId}:`, err instanceof Error ? err.message : String(err));
      }
    }

    return result;
  }
}
