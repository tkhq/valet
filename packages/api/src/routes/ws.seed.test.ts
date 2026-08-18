/**
 * WS handshake seeding — after `init`, the socket sends one `queue.state`
 * frame per thread (from durable queue rows) plus a `status` frame for any
 * thread that is mid-turn.
 *
 * Why: the client derives its Stop button and Escape interrupt from these
 * signals. Before the seed, a client that connected mid-turn (page load or
 * reconnect during a long tool call) saw the thread as idle until the NEXT
 * transition event — no Stop button, Escape inert — sometimes for minutes.
 *
 * These tests never run a model turn: a paused thread holds its submission
 * durably `queued`, which is exactly the state the seed must surface.
 */
import { describe, it, expect, afterEach } from "vitest";
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
): Promise<WireEvent[]> {
  const ws = new WebSocket(`${wsUrl}/api/sessions/${sessionId}/ws`);
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
});
