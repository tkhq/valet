import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { context as otelContext, trace as otelTrace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  Engine,
  InMemoryBlobStore,
  InMemoryEventStream,
  InMemorySessionStore,
  ValidationError,
  VirtualSandboxProvider,
  patchBlobKey,
  type BusEvent,
  type ExecResult,
  type Sandbox,
  type SessionStartRef,
} from "../src/index.js";

function makeEngine(blobs?: InMemoryBlobStore) {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const sandboxProvider = new VirtualSandboxProvider();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({
    providers: { store, stream: bus, sandboxProvider, ...(blobs ? { blobs } : {}) },
  });
  return { engine, store, bus, events };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const startRef: SessionStartRef = {
  repoUrl: "https://github.com/tkhq/valet.git",
  branch: "dev-v2",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  capturedAt: 1,
};

/** Exec-capable sandbox stub for the settle-patch round trip. */
function gitSandbox(diffText: string): Sandbox {
  const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", exitCode: 0 });
  const unused = () => {
    throw new Error("not used");
  };
  return {
    id: "sb-git",
    readFile: unused,
    readBinary: unused,
    writeFile: unused,
    writeBinary: unused,
    readdir: async () => [],
    stat: unused,
    mkdir: async () => undefined,
    rm: async () => undefined,
    exec: async (command: string) => {
      if (command.startsWith("git diff")) return ok(diffText);
      return ok("true");
    },
  };
}

describe("engine traces: per-turn usage/cost", () => {
  // The faux provider computes real (non-zero) usage from the streamed prompt
  // but never prices it (cost stays all-zero) — so one real turn exercises
  // BOTH rules: usage lands on the entry and the event from one snapshot, and
  // zero cost is omitted, never written as "$0".
  it("turn_end persists usage on the assistant entry, enriches the turn_end event, omits zero cost", async () => {
    const faux = registerFauxProvider({ provider: "traces1" });
    faux.setResponses([fauxAssistantMessage("traced reply")]);

    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
    });
    const receipt = await session.prompt("trace me");
    await waitFor(() =>
      events.some((e) => e.event.type === "submission_settled" && e.event.queueItemId === receipt.queueItemId),
    );

    // Entry: the persisted assistant row carries real usage, no fabricated cost.
    const entries = await store.getEntries(session.id, receipt.threadId);
    const assistant = entries.find((e) => e.type === "message" && e.role === "assistant");
    if (assistant?.type !== "message") throw new Error("no assistant entry");
    expect(assistant.usage).toBeDefined();
    expect(assistant.usage!.total).toBeGreaterThan(0);
    expect(assistant.usage!.input).toBeGreaterThan(0);
    expect(assistant.cost).toBeUndefined(); // faux is unpriced — null, not $0

    // Event: turn_end carries the SAME snapshot plus model + duration.
    const turnEnd = events.find((e) => e.event.type === "turn_end")?.event;
    if (turnEnd?.type !== "turn_end") throw new Error("no turn_end event");
    expect(turnEnd.usage).toEqual(assistant.usage);
    expect(turnEnd.cost).toBeUndefined();
    expect(turnEnd.model).toBe(faux.getModel().id);
    expect(typeof turnEnd.turnDurationMs).toBe("number");

    faux.unregister();
  });
});

describe("engine traces: start-ref stamping", () => {
  it("setStartRef persists, is idempotent for identical refs, and refuses divergence", async () => {
    const faux = registerFauxProvider({ provider: "traces3" });
    faux.setResponses([fauxAssistantMessage("ok")]);
    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
    });

    await session.setStartRef(startRef);
    expect((await store.getSession(session.id))?.startRef).toEqual(startRef);

    // Identical repeat (capturedAt may differ) → no-op.
    await session.setStartRef({ ...startRef, capturedAt: 999 });
    expect((await store.getSession(session.id))?.startRef).toEqual(startRef);

    // Divergent ref → host bug, refused loudly.
    await expect(
      session.setStartRef({ ...startRef, commitSha: "f".repeat(40) }),
    ).rejects.toBeInstanceOf(ValidationError);

    faux.unregister();
  });

  it("createSession(startRef) persists it; restore without re-supplying preserves it", async () => {
    const faux = registerFauxProvider({ provider: "traces4" });
    faux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok again")]);
    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      startRef,
    });
    expect((await store.getSession(session.id))?.startRef).toEqual(startRef);

    const restored = await engine.restoreSession({
      sessionId: session.id,
      options: {
        userId: "u1",
        orgId: "o1",
        workspace: "/workspace",
        sandbox: {},
        model: faux.getModel(),
      },
    });
    expect(restored.options.startRef).toEqual(startRef);
    // The next save must not stomp it back to NULL: toData() (what every
    // saveSession call serializes) still carries the persisted ref.
    expect((await restored.toData()).startRef).toEqual(startRef);
    await store.saveSession(await restored.toData());
    expect((await store.getSession(session.id))?.startRef).toEqual(startRef);

    faux.unregister();
  });
});

describe("engine traces: settle-time patch capture", () => {
  it("a settled turn captures the workspace diff: blob + queue-item record + event payload", async () => {
    const faux = registerFauxProvider({ provider: "traces5" });
    faux.setResponses([fauxAssistantMessage("did the work")]);
    const blobs = new InMemoryBlobStore();
    const { engine, store, events } = makeEngine(blobs);
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: gitSandbox("diff --git a/x b/x\n+changed\n"),
      model: faux.getModel(),
      startRef,
    });
    const receipt = await session.prompt("change something");
    await waitFor(() =>
      events.some((e) => e.event.type === "submission_settled" && e.event.queueItemId === receipt.queueItemId),
    );

    const item = await store.getQueueItem(session.id, receipt.queueItemId);
    expect(item?.settlePatch?.status).toBe("captured");
    const key = patchBlobKey(session.id, receipt.queueItemId);
    expect(item?.settlePatch?.blobKey).toBe(key);

    const settled = events.find(
      (e) => e.event.type === "submission_settled" && e.event.queueItemId === receipt.queueItemId,
    )?.event;
    if (settled?.type !== "submission_settled") throw new Error("unreachable");
    expect(settled.patch).toMatchObject({ status: "captured", blobKey: key });

    const blob = await blobs.get(key);
    expect(blob).not.toBeNull();

    faux.unregister();
  });

  it("no blob store → settle succeeds with skipped:no_blob_store", async () => {
    const faux = registerFauxProvider({ provider: "traces6" });
    faux.setResponses([fauxAssistantMessage("ok")]);
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: gitSandbox(""),
      model: faux.getModel(),
      startRef,
    });
    const receipt = await session.prompt("hi");
    await waitFor(() =>
      events.some((e) => e.event.type === "submission_settled" && e.event.queueItemId === receipt.queueItemId),
    );
    const item = await store.getQueueItem(session.id, receipt.queueItemId);
    expect(item?.outcome?.outcome).toBe("completed");
    expect(item?.settlePatch).toEqual({ status: "skipped", reason: "no_blob_store" });
    faux.unregister();
  });

  it("no start-ref → settle succeeds with skipped:no_start_ref", async () => {
    const faux = registerFauxProvider({ provider: "traces7" });
    faux.setResponses([fauxAssistantMessage("ok")]);
    const blobs = new InMemoryBlobStore();
    const { engine, store, events } = makeEngine(blobs);
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: gitSandbox(""),
      model: faux.getModel(),
    });
    const receipt = await session.prompt("hi");
    await waitFor(() =>
      events.some((e) => e.event.type === "submission_settled" && e.event.queueItemId === receipt.queueItemId),
    );
    const item = await store.getQueueItem(session.id, receipt.queueItemId);
    expect(item?.outcome?.outcome).toBe("completed");
    expect(item?.settlePatch).toEqual({ status: "skipped", reason: "no_start_ref" });
    faux.unregister();
  });
});

describe("engine traces: transcript.shape on rehydrate", () => {
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

  it("rehydrate emits one transcript.shape event carrying source rehydrate", async () => {
    const faux = registerFauxProvider({ provider: "traces-fp" });
    faux.setResponses([fauxAssistantMessage("ok")]);
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
    });
    const receipt = await session.prompt("hi");
    await waitFor(() =>
      events.some((e) => e.event.type === "submission_settled" && e.event.queueItemId === receipt.queueItemId),
    );

    const entries = await store.getEntries(session.id, receipt.threadId);
    session.thread().rehydrateTranscript(entries);

    const rehydrateEvents = exporter
      .getFinishedSpans()
      .flatMap((s) => s.events)
      .filter(
        (e) =>
          e.name === "transcript.shape" && e.attributes?.["valet.transcript.source"] === "rehydrate",
      );
    expect(rehydrateEvents).toHaveLength(1);
    expect(String(rehydrateEvents[0]?.attributes?.["valet.pi_ai.version"])).toMatch(/^\d+\.\d+/);

    faux.unregister();
  });
});
