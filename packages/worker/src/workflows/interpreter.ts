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
    const result = await runWorkflowDag(this.env, event, step, { traceWriter });

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
