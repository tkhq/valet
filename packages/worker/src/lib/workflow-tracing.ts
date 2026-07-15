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
    // Cancel-path nodes land in state.nodes with an envelope status of
    // 'skipped'; count them with the edge-skips so node_count means "ran".
    const ranCount = executed.filter(([, n]) => n.status !== 'skipped').length;
    const skippedTotal = skipped.length + (executed.length - ranCount);
    // Defensive cap: a pathological definition can't overflow the batch
    // processor's queue (2048) into silent drops. Root carries the loss.
    const CAP = 1500;
    const truncated = Math.max(0, executed.length + skipped.length - CAP);

    // Run bounds from the replay-stable per-node timestamps; a run with no
    // executed nodes (early cancel) collapses to a zero-length span at now.
    const starts = executed.map(([, n]) => Date.parse(n.startedAt)).filter(Number.isFinite);
    const ends = executed.map(([, n]) => Date.parse(n.completedAt)).filter(Number.isFinite);
    const runStart = starts.length > 0 ? Math.min(...starts) : Date.now();
    const runEnd = ends.length > 0 ? Math.max(...ends, runStart) : runStart;

    // Parent to the dispatching request's trace when the trigger path stamped
    // a SAMPLED traceparent. An unsampled parent (flags 00 — proxies and
    // upstream clients stamp these routinely) would make the default
    // ParentBased sampler drop every span here while we still report a
    // count, so those runs get a fresh sampled root instead, with the
    // dispatching trace id kept as an attribute for manual correlation.
    const tpParts = params.traceparent?.trim().split('-') ?? [];
    const tpValid = tpParts.length >= 4 && /^[0-9a-f]{32}$/.test(tpParts[1] ?? '');
    const parentSampled = tpValid && (parseInt(tpParts[3]!, 16) & 1) === 1;
    const parent: Context = parentSampled ? parseTraceparent(params.traceparent) : parseTraceparent(undefined);
    const dispatchTraceId = tpValid && !parentSampled ? tpParts[1] : undefined;
    const root = tracer.startSpan('workflow.run', {
      startTime: runStart,
      attributes: {
        'valet.execution.id': params.executionId,
        'valet.workflow.id': params.workflowId,
        'valet.user.id': params.userId,
        'valet.workflow.mode': params.mode ?? 'production',
        'valet.workflow.trigger_type': params.trigger.type,
        'valet.workflow.status': result.status,
        'valet.workflow.node_count': ranCount,
        'valet.workflow.skipped_count': skippedTotal,
        'valet.workflow.failed_count': result.failures?.length ?? 0,
        ...(truncated > 0 ? { 'valet.spans.truncated': truncated } : {}),
        ...(dispatchTraceId ? { 'valet.dispatch.trace_id': dispatchTraceId } : {}),
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
    let budget = CAP;
    for (const [nodeId, node] of executed) {
      if (budget-- <= 0) break;
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
      if (budget-- <= 0) break;
      // Skip reasons stay off the span: edge-eval failures embed expression
      // text. The workflow_execution_nodes row carries the full reason.
      // Skips carry no runtime timestamp (only the D1 trace row does), so
      // they're stamped at runEnd — a known approximation.
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
    // Bound the export so a black-holed collector can't hold the workflow
    // instance open for the full 15s export timeout. If the bound wins the
    // race the export may never land, so log it here — the isolate can be
    // reclaimed the moment this step returns, before the drop counter would
    // ever observe the failed export.
    const TIMED_OUT = Symbol('flush-timeout');
    const flushed = await Promise.race([
      provider.forceFlush().then(() => provider.shutdown()).then(() => 'flushed' as const),
      new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), 5_000)),
    ]);
    if (flushed === TIMED_OUT) {
      console.warn(`[workflow-tracing] flush exceeded 5s bound for ${params.executionId}; ${count} span(s) may not have exported`);
    }
    return count;
  } catch (err) {
    console.warn('[workflow-tracing] span emission failed:', err instanceof Error ? err.message : String(err));
    return 0;
  }
}
