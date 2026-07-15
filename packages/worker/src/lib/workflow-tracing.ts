import { SpanStatusCode, trace, type Context } from '@opentelemetry/api';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { createTraceProvider, parseTraceparent } from './do-tracing.js';
import { isTracingEnabled, type TracingEnv } from './tracing.js';
import type { WorkflowRunParams, WorkflowRunResult } from '../workflows/types.js';

/**
 * Retroactive span emission for Cloudflare Workflow runs.
 *
 * The interpreter's run() replays from the top on every hibernate/wake, so a
 * live span cannot straddle a step boundary (approval/wait nodes suspend for
 * hours and the in-memory span would be lost). Instead the entire span tree is
 * reconstructed once at run completion from the replay-stable timestamps the
 * runtime already caches per node, then flushed in a single export. The caller
 * wraps this in step.do so the emit itself fires once per execution.
 *
 * Spans carry identifiers and statuses only — node error strings can embed
 * user data and backend response text, so they never become span attributes
 * (the same rule as lifecycle tracing: fixed classifications, no raw text).
 */

const SERVICE_NAME = 'valet-workflow-interpreter';

export interface WorkflowTracingOptions {
  /** Test seam: replaces only the terminal OTLP exporter; the redact →
   *  drop-count → batch chain stays in the exercised path. */
  exporter?: SpanExporter;
}

/**
 * Emit one `workflow.run` root span plus a child span per executed/skipped
 * node. Returns the number of spans emitted (JSON-serializable so callers can
 * step.do-cache it). Never throws: observability must not fail a run.
 */
export async function emitWorkflowRunSpans(
  env: TracingEnv,
  params: WorkflowRunParams,
  result: WorkflowRunResult,
  options?: WorkflowTracingOptions,
): Promise<number> {
  try {
    if (!isTracingEnabled(env) && !options?.exporter) return 0;
    const created = await createTraceProvider(env, SERVICE_NAME, options?.exporter);
    if (!created) return 0;
    const { provider } = created;
    const tracer = provider.getTracer(SERVICE_NAME);

    const nodeTypes = new Map(params.definition.nodes.map((n) => [n.id, n.type]));
    const executed = Object.entries(result.state.nodes ?? {});
    const skipped = Object.entries(result.state.skipped ?? {});

    // Run bounds from the replay-stable per-node timestamps; a run with no
    // executed nodes (early cancel) collapses to a zero-length span at now.
    const starts = executed.map(([, n]) => Date.parse(n.startedAt)).filter(Number.isFinite);
    const ends = executed.map(([, n]) => Date.parse(n.completedAt)).filter(Number.isFinite);
    const runStart = starts.length > 0 ? Math.min(...starts) : Date.now();
    const runEnd = ends.length > 0 ? Math.max(...ends, runStart) : runStart;

    // Parent to the dispatching request's trace when the trigger path stamped
    // one; parseTraceparent falls back to a fresh root on missing/malformed.
    const parent: Context = parseTraceparent(params.traceparent);
    const root = tracer.startSpan('workflow.run', {
      startTime: runStart,
      attributes: {
        'valet.execution.id': params.executionId,
        'valet.workflow.id': params.workflowId,
        'valet.user.id': params.userId,
        'valet.workflow.mode': params.mode ?? 'production',
        'valet.workflow.trigger_type': params.trigger.type,
        'valet.workflow.status': result.status,
        'valet.workflow.node_count': executed.length,
        'valet.workflow.skipped_count': skipped.length,
        'valet.workflow.failed_count': result.failures?.length ?? 0,
      },
    }, parent);
    if (result.status === 'failed') {
      const firstFailure = result.failures?.[0];
      root.setStatus({
        code: SpanStatusCode.ERROR,
        ...(firstFailure ? { message: `node ${firstFailure.nodeId} failed` } : {}),
      });
    }

    const runCtx = trace.setSpan(parent, root);
    let count = 1;
    for (const [nodeId, node] of executed) {
      const start = Date.parse(node.startedAt);
      const end = Date.parse(node.completedAt);
      const span = tracer.startSpan(`workflow.node.${nodeTypes.get(nodeId) ?? 'unknown'}`, {
        startTime: Number.isFinite(start) ? start : runStart,
        attributes: {
          'valet.execution.id': params.executionId,
          'valet.node.id': nodeId,
          'valet.node.status': node.status,
        },
      }, runCtx);
      if (node.status === 'failed') span.setStatus({ code: SpanStatusCode.ERROR });
      span.end(Number.isFinite(end) ? end : runEnd);
      count += 1;
    }
    for (const [nodeId] of skipped) {
      // Skip reasons stay off the span: edge-eval failures embed expression
      // text. The workflow_execution_nodes row carries the full reason.
      const span = tracer.startSpan(`workflow.node.${nodeTypes.get(nodeId) ?? 'unknown'}`, {
        startTime: runEnd,
        attributes: {
          'valet.execution.id': params.executionId,
          'valet.node.id': nodeId,
          'valet.node.status': 'skipped',
        },
      }, runCtx);
      span.end(runEnd);
      count += 1;
    }

    root.end(runEnd);
    await provider.forceFlush();
    await provider.shutdown();
    return count;
  } catch (err) {
    console.warn('[workflow-tracing] span emission failed:', err instanceof Error ? err.message : String(err));
    return 0;
  }
}
