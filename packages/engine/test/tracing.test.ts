/**
 * Distributed-tracing coverage: with a real (in-memory) OTel SDK registered,
 * one faux turn with a tool call must produce the linked span tree —
 * submission.run → agent.turn → tool.* → …, with usage attributes on the
 * turn and the admitting context's traceparent linked on the submission.
 * With no SDK registered (every other engine test), all of this is a no-op.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import { context as otelContext, trace as otelTrace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  TRACEPARENT_METADATA_KEY,
  type BusEvent,
  type ToolDef,
} from "../src/index.js";

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let contextManager: AsyncLocalStorageContextManager;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  otelContext.setGlobalContextManager(contextManager);
  otelTrace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  await provider.shutdown();
  otelTrace.disable();
  otelContext.disable();
});

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({
    providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() },
  });
  return { engine, store, events };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function byName(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
  return spans.find((s) => s.name === name);
}

describe("engine distributed tracing", () => {
  it("one turn with a tool call produces the linked span tree", async () => {
    const faux = registerFauxProvider({ provider: "tracing1" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("greet", { who: "world" }, { id: "tc-1" })]),
      fauxAssistantMessage("done"),
    ]);
    const greet: ToolDef = {
      name: "greet",
      description: "greets",
      parameters: Type.Object({ who: Type.String() }),
      execute: async (args) => ({ text: `hello ${(args as { who: string }).who}` }),
    };

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      tools: [greet],
    });

    // Admit INSIDE an active span, as the HTTP middleware would — the
    // submission span must link back to this context.
    const tracer = otelTrace.getTracer("test-http");
    const receipt = await tracer.startActiveSpan("POST /api/sessions/:id/messages", async (span) => {
      const r = await session.prompt("greet the world");
      span.end();
      return r;
    });
    await waitFor(() =>
      events.some((e) => e.event.type === "submission_settled" && e.event.queueItemId === receipt.queueItemId),
    );
    // Spans end asynchronously relative to the settle event; wait for the tree.
    await waitFor(() => exporter.getFinishedSpans().some((s) => s.name === "submission.run"));
    const spans = exporter.getFinishedSpans();

    const run = byName(spans, "submission.run");
    const turn = byName(spans, "agent.turn");
    const tool = byName(spans, "tool.greet");
    const settle = byName(spans, "submission.settle");
    const patch = byName(spans, "patch.capture");
    const http = byName(spans, "POST /api/sessions/:id/messages");
    expect(run).toBeDefined();
    expect(turn).toBeDefined();
    expect(tool).toBeDefined();
    expect(settle).toBeDefined();
    expect(patch).toBeDefined();

    // llm.generate: one span per assistant round (tool round + final round),
    // both under the turn, each carrying per-round usage.
    const llmSpans = spans.filter((s) => s.name === "llm.generate");
    expect(llmSpans).toHaveLength(2);
    for (const l of llmSpans) {
      expect(l.parentSpanContext?.spanId).toBe(turn!.spanContext().spanId);
      expect(l.attributes["gen_ai.usage.input_tokens"]).toBeGreaterThan(0);
    }
    // Round 1 made the tool call; round 2 made none.
    expect(llmSpans.map((l) => l.attributes["valet.llm.tool_calls"]).sort()).toEqual([0, 1]);

    // Parentage: turn + settle under run; tool under turn; patch under settle.
    expect(turn!.parentSpanContext?.spanId).toBe(run!.spanContext().spanId);
    expect(settle!.parentSpanContext?.spanId).toBe(run!.spanContext().spanId);
    expect(tool!.parentSpanContext?.spanId).toBe(turn!.spanContext().spanId);
    expect(patch!.parentSpanContext?.spanId).toBe(settle!.spanContext().spanId);
    // One trace for the whole submission tree, distinct from the HTTP trace…
    expect(turn!.spanContext().traceId).toBe(run!.spanContext().traceId);
    expect(tool!.spanContext().traceId).toBe(run!.spanContext().traceId);
    // …but LINKED to the admitting request.
    expect(run!.links).toHaveLength(1);
    expect(run!.links[0].context.traceId).toBe(http!.spanContext().traceId);
    expect(run!.links[0].context.spanId).toBe(http!.spanContext().spanId);

    // Attributes: usage on the turn, outcome on run+settle, queue wait on run.
    expect(turn!.attributes["gen_ai.usage.input_tokens"]).toBeGreaterThan(0);
    expect(turn!.attributes["gen_ai.request.model"]).toBe(faux.getModel().id);
    expect(run!.attributes["valet.submission.outcome"]).toBe("completed");
    expect(settle!.attributes["valet.submission.outcome"]).toBe("completed");
    expect(typeof run!.attributes["valet.submission.queue_wait_ms"]).toBe("number");
    expect(patch!.attributes["valet.patch.status"]).toBe("skipped");

    faux.unregister();
  });

  it("admission stamps the traceparent onto queue-item metadata (and omits it outside a span)", async () => {
    const faux = registerFauxProvider({ provider: "tracing2" });
    faux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok2")]);
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
    });

    const tracer = otelTrace.getTracer("test-http");
    const inSpan = await tracer.startActiveSpan("req", async (span) => {
      const r = await session.prompt("first");
      span.end();
      return r;
    });
    const item = await store.getQueueItem(session.id, inSpan.queueItemId);
    expect(typeof item?.metadata?.[TRACEPARENT_METADATA_KEY]).toBe("string");
    expect(item?.metadata?.[TRACEPARENT_METADATA_KEY]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);

    await waitFor(() =>
      events.some((e) => e.event.type === "submission_settled" && e.event.queueItemId === inSpan.queueItemId),
    );
    const outside = await session.prompt("second");
    const outsideItem = await store.getQueueItem(session.id, outside.queueItemId);
    expect(outsideItem?.metadata?.[TRACEPARENT_METADATA_KEY]).toBeUndefined();
    await waitFor(() =>
      events.some((e) => e.event.type === "submission_settled" && e.event.queueItemId === outside.queueItemId),
    );
    faux.unregister();
  });
});
