/**
 * WS handshake seeding — after `init`, the socket sends each thread's queue,
 * non-idle status, and authoritative active model state.
 *
 * Why: the client derives its Stop button and Escape interrupt from these
 * signals. Before the seed, a client that connected mid-turn (page load or
 * reconnect during a long tool call) saw the thread as idle until the NEXT
 * transition event — no Stop button, Escape inert — sometimes for minutes.
 *
 * These tests never run a model turn: a paused thread holds its submission
 * durably `queued`, which is exactly the state the seed must surface.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import type { BusEvent } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { CreateSessionResponse, WireEvent } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function createSession(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: "/tmp" }),
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as CreateSessionResponse;
  return id;
}

/**
 * Connect, collect frames until `predicate` matches one (resolving with all
 * frames seen so far), then close. Rejects on timeout with the frames seen,
 * for a readable failure.
 */
async function collectUntil(
  wsUrl: string,
  sessionId: string,
  predicate: (ev: WireEvent) => boolean,
  timeoutMs = 5_000,
  fromOffset?: string,
): Promise<WireEvent[]> {
  const suffix = fromOffset === undefined ? "" : `?fromOffset=${encodeURIComponent(fromOffset)}`;
  const ws = new WebSocket(`${wsUrl}/api/sessions/${sessionId}/ws${suffix}`);
  const frames: WireEvent[] = [];
  return await new Promise<WireEvent[]>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(
        new Error(
          `collectUntil: timed out; saw ${frames.map((f) => f.type).join(", ") || "(none)"}`,
        ),
      );
    }, timeoutMs);
    ws.onmessage = (ev) => {
      const data = typeof ev.data === "string" ? ev.data : ev.data.toString();
      const wire = JSON.parse(data) as WireEvent;
      frames.push(wire);
      if (predicate(wire)) {
        clearTimeout(timeout);
        ws.close();
        resolve(frames);
      }
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("ws error during collectUntil"));
    };
  });
}

describe("WS handshake seeds per-thread state after init", () => {
  it("seeds an idle thread's queue.state", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);

    const frames = await collectUntil(api.wsUrl, sessionId, (ev) => ev.type === "queue.state");
    expect(frames[0]?.type).toBe("init");
    const queueFrame = frames.find((ev) => ev.type === "queue.state");
    if (queueFrame?.type !== "queue.state") throw new Error("unreachable");
    expect(queueFrame.state.status).toBe("idle");
    expect(queueFrame.state.pendingIds).toEqual([]);
  });

  it("seeds the pending submission of a paused thread on a fresh connect", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);

    const engineSession = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const thread = await engineSession.ensureDefaultThread();

    // Paused, the claim loop leaves the submission durably `queued` — the
    // seed must report it to a client that connects only now.
    await thread.pause();
    const receipt = await thread.submitPrompt("say hello", {});

    try {
      const frames = await collectUntil(
        api.wsUrl,
        sessionId,
        (ev) => ev.type === "queue.state" && ev.threadId === thread.id,
      );
      const queueFrame = frames.find(
        (ev) => ev.type === "queue.state" && ev.threadId === thread.id,
      );
      if (queueFrame?.type !== "queue.state") throw new Error("unreachable");
      expect(queueFrame.state.status).toBe("paused");
      expect(queueFrame.state.pendingIds).toContain(receipt.queueItemId);
    } finally {
      // Settle the parked submission so teardown doesn't race a live claim loop.
      await thread.abort();
    }
  });

  it("sends the queue seed before durable replay can advance it", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const engineSession = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const thread = await engineSession.ensureDefaultThread();
    const replayedQueue: BusEvent = {
      sessionId,
      threadId: thread.id,
      userId: "local-user",
      timestamp: 100,
      event: {
        type: "queue_state",
        threadId: thread.id,
        state: {
          threadId: thread.id,
          mode: "followup",
          status: "running",
          activeItemId: "q-newer",
          pending: [],
        },
      },
    };
    const { offset } = await api.providers.eventStream.append(
      replayedQueue,
      "queue:replayed",
    );

    let queueStateCount = 0;
    const frames = await collectUntil(
      api.wsUrl,
      sessionId,
      (event) => event.type === "queue.state" && ++queueStateCount === 2,
      5_000,
      "0",
    );

    expect(frames[0]?.type).toBe("init");
    const queueStates = frames.filter((event) => event.type === "queue.state");
    expect(queueStates.map((event) => event.state.status)).toEqual(["idle", "running"]);
    expect(queueStates.map((event) => event.offset)).toEqual([undefined, offset]);
    expect(queueStates.at(-1)?.state.activeItemId).toBe("q-newer");
  });

  it("subscribes before it reads one active or idle model snapshot per thread", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const engineSession = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const activeThread = await engineSession.ensureDefaultThread();
    const idleThread = await engineSession.createThread("web:idle");
    const calls: string[] = [];
    const subscribe = api.providers.eventStream.subscribe.bind(api.providers.eventStream);
    vi.spyOn(api.providers.eventStream, "subscribe").mockImplementation((filter, callback) => {
      calls.push("subscribe");
      return subscribe(filter, callback);
    });
    vi.spyOn(activeThread, "currentModelState").mockImplementation(async () => {
      calls.push("active getter");
      return { queueItemId: "q-active", model: "anthropic/claude-opus-4-7" };
    });
    vi.spyOn(idleThread, "currentModelState").mockImplementation(async () => {
      calls.push("idle getter");
      return null;
    });

    let modelStateCount = 0;
    const frames = await collectUntil(
      api.wsUrl,
      sessionId,
      (event) => event.type === "model.state" && ++modelStateCount === 2,
    );

    expect(frames[0]?.type).toBe("init");
    expect(calls).toEqual(["subscribe", "active getter", "idle getter"]);
    const modelStates = frames.filter((event) => event.type === "model.state");
    expect(modelStates).toHaveLength(2);
    const active = modelStates.find((event) => event.threadId === activeThread.id);
    if (active?.type !== "model.state") throw new Error("missing active model seed");
    expect(active.queueItemId).toBe("q-active");
    expect(active.model).toBe("anthropic/claude-opus-4-7");
    const idle = modelStates.find((event) => event.threadId === idleThread.id);
    if (idle?.type !== "model.state") throw new Error("missing idle model seed");
    expect(idle.queueItemId).toBeNull();
    expect(idle.model).toBeNull();
  });

  it("sends the model snapshot after replay and subscription-buffered live events", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const engineSession = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const thread = await engineSession.ensureDefaultThread();
    vi.spyOn(thread, "currentModelState").mockResolvedValue({
      queueItemId: "q-snapshot",
      model: "anthropic/claude-opus-4-7",
    });

    const replayed: BusEvent = {
      sessionId,
      threadId: thread.id,
      userId: "local-user",
      timestamp: 100,
      event: {
        type: "model_state",
        threadId: thread.id,
        queueItemId: "q-replayed",
        model: "anthropic/claude-haiku-4-5",
      },
    };
    await api.providers.eventStream.append(replayed, "model:replayed");

    const eventStream = api.providers.eventStream;
    const read = eventStream.read.bind(eventStream);
    let injectedLiveEvent = false;
    vi.spyOn(eventStream, "read").mockImplementation(async (id, options) => {
      const result = await read(id, options);
      if (!injectedLiveEvent) {
        injectedLiveEvent = true;
        const live: BusEvent = {
          sessionId,
          threadId: thread.id,
          userId: "local-user",
          timestamp: 200,
          event: {
            type: "model_state",
            threadId: thread.id,
            queueItemId: "q-buffered",
            model: "anthropic/claude-sonnet-4-6",
          },
        };
        await eventStream.append(live, "model:buffered");
      }
      return result;
    });

    const frames = await collectUntil(
      api.wsUrl,
      sessionId,
      (event) => event.type === "model.state" && event.queueItemId === "q-snapshot",
      5_000,
      "0",
    );

    expect(frames[0]?.type).toBe("init");
    const modelStates = frames.filter((event) => event.type === "model.state");
    expect(modelStates.map((event) => event.queueItemId)).toEqual([
      "q-replayed",
      "q-buffered",
      "q-snapshot",
    ]);
    expect(modelStates.at(-1)?.model).toBe("anthropic/claude-opus-4-7");
    expect(modelStates.at(-1)?.offset).toBeUndefined();
  });
});
