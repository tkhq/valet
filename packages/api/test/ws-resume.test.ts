/**
 * WS resume protocol — offset-carrying frames, replay-from-offset, bridge
 * mappings for queue.state / submission.settled.
 *
 * Drives a real `createApp` over @hono/node-ws (via bootTestApi) and appends
 * durable events directly to the shared EventStream — no Anthropic key or
 * agent turn required. Verifies:
 *   (a) no offset → init first, live durable frames carry offset, ephemeral
 *       (text_delta) frames don't;
 *   (b) reconnect with ?fromOffset= replays only events after that offset,
 *       in order, each stamped with its offset;
 *   (c) an event appended during replay is delivered exactly once (offset
 *       uniqueness across the received frame list);
 *   (d) queue.state + submission.settled frames reach the socket.
 */
import { describe, it, expect } from "vitest";
import type { BusEvent, QueueItem } from "@valet/engine";
import { bootTestApi } from "../src/integration/_setup.js";
import type { CreateSessionResponse, WireEvent } from "../src/wire/types.js";

const USER_ID = "local-user";

function statusEvent(sessionId: string, threadId: string): BusEvent {
  return {
    sessionId,
    threadId,
    userId: USER_ID,
    timestamp: Date.now(),
    event: { type: "status", threadId, status: "thinking" },
  };
}

function qi(id: string, threadId: string): QueueItem {
  const now = Date.now();
  return {
    id,
    threadId,
    content: "x",
    status: "queued",
    attemptCount: 0,
    maxAttempts: 10,
    timeoutAt: now + 3_600_000,
    createdAt: now,
    updatedAt: now,
  };
}

interface Conn {
  frames: WireEvent[];
  waitFor(pred: (f: WireEvent) => boolean, timeoutMs?: number): Promise<WireEvent>;
  close(): void;
}

function connect(url: string): Conn {
  const ws = new WebSocket(url);
  const frames: WireEvent[] = [];
  const listeners = new Set<(f: WireEvent) => void>();
  ws.onmessage = (ev) => {
    const data = typeof ev.data === "string" ? ev.data : ev.data.toString();
    const f = JSON.parse(data) as WireEvent;
    frames.push(f);
    for (const l of listeners) l(f);
  };
  return {
    frames,
    waitFor(pred, timeoutMs = 4_000) {
      return new Promise<WireEvent>((resolve, reject) => {
        for (const f of frames) {
          if (pred(f)) return resolve(f);
        }
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(
            new Error(
              `waitFor timed out; frame types seen: ${JSON.stringify(frames.map((f) => f.type))}`,
            ),
          );
        }, timeoutMs);
        const check = (f: WireEvent) => {
          if (pred(f)) {
            clearTimeout(timer);
            listeners.delete(check);
            resolve(f);
          }
        };
        listeners.add(check);
      });
    },
    close() {
      ws.close();
    },
  };
}

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

describe("ws resume protocol", () => {
  it("(a) no offset: init first, durable frames carry offset, ephemeral frames don't", async () => {
    const api = await bootTestApi();
    try {
      const sessionId = await createSession(api.baseUrl);
      const c = connect(`${api.wsUrl}/api/sessions/${sessionId}/ws`);
      await c.waitFor((f) => f.type === "init");
      expect(c.frames[0].type).toBe("init");

      // Durable append → live durable frame carries offset.
      await api.providers.eventStream.append(statusEvent(sessionId, "t-durable"), "ek-a1");
      // Ephemeral publish (text_delta) → no offset.
      api.providers.eventStream.publishEphemeral({
        sessionId,
        threadId: "t-durable",
        userId: USER_ID,
        timestamp: Date.now(),
        event: { type: "text_delta", threadId: "t-durable", text: "hi" },
      });

      const statusFrame = await c.waitFor((f) => f.type === "status");
      const deltaFrame = await c.waitFor((f) => f.type === "text_delta");
      expect(typeof (statusFrame as { offset?: string }).offset).toBe("string");
      expect((deltaFrame as { offset?: string }).offset).toBeUndefined();
      c.close();
    } finally {
      await api.cleanup();
    }
  });

  it("(b) reconnect with fromOffset replays only later events, in order, each with its offset", async () => {
    const api = await bootTestApi();
    try {
      const sessionId = await createSession(api.baseUrl);
      const offsets: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const { offset } = await api.providers.eventStream.append(
          statusEvent(sessionId, `t${i}`),
          `ek-b${i}`,
        );
        offsets.push(offset);
      }
      // fromOffset = offset of event 2 → replay events 3,4,5.
      const c = connect(
        `${api.wsUrl}/api/sessions/${sessionId}/ws?fromOffset=${offsets[1]}`,
      );
      await c.waitFor((f) => f.type === "status" && f.threadId === "t5");

      expect(c.frames[0].type).toBe("init");
      const statuses = c.frames.filter((f) => f.type === "status");
      expect(statuses.map((f) => (f as { threadId: string }).threadId)).toEqual([
        "t3",
        "t4",
        "t5",
      ]);
      for (const s of statuses) {
        expect(typeof (s as { offset?: string }).offset).toBe("string");
      }
      c.close();
    } finally {
      await api.cleanup();
    }
  });

  it("(c) an event appended during replay is delivered exactly once (offset uniqueness)", async () => {
    const api = await bootTestApi();
    try {
      const sessionId = await createSession(api.baseUrl);
      for (let i = 1; i <= 5; i++) {
        await api.providers.eventStream.append(statusEvent(sessionId, `t${i}`), `ek-c${i}`);
      }
      // Replay everything from the start, then append more live.
      const c = connect(`${api.wsUrl}/api/sessions/${sessionId}/ws?fromOffset=0`);
      await c.waitFor((f) => f.type === "init");
      for (let i = 6; i <= 8; i++) {
        await api.providers.eventStream.append(statusEvent(sessionId, `t${i}`), `ek-c${i}`);
      }
      await c.waitFor((f) => f.type === "status" && f.threadId === "t8", 6_000);

      const offsets = c.frames
        .filter((f) => f.type === "status")
        .map((f) => (f as { offset?: string }).offset);
      expect(offsets.length).toBeGreaterThanOrEqual(8);
      expect(offsets.every((o) => typeof o === "string")).toBe(true);
      expect(new Set(offsets).size).toBe(offsets.length);
      c.close();
    } finally {
      await api.cleanup();
    }
  });

  it("(d) queue.state and submission.settled frames reach the socket", async () => {
    const api = await bootTestApi();
    try {
      const sessionId = await createSession(api.baseUrl);
      await api.providers.eventStream.append(
        {
          sessionId,
          threadId: "t1",
          userId: USER_ID,
          timestamp: Date.now(),
          event: {
            type: "queue_state",
            threadId: "t1",
            state: {
              threadId: "t1",
              mode: "followup",
              status: "running",
              activeItemId: "q1",
              pending: [qi("q2", "t1")],
              collectBuffer: [qi("q3", "t1")],
            },
          },
        },
        "ek-d-qs",
      );
      await api.providers.eventStream.append(
        {
          sessionId,
          threadId: "t1",
          queueItemId: "q1",
          userId: USER_ID,
          timestamp: Date.now(),
          event: {
            type: "submission_settled",
            sessionId,
            threadId: "t1",
            queueItemId: "q1",
            outcome: { outcome: "completed" },
          },
        },
        "ek-d-ss",
      );

      const c = connect(`${api.wsUrl}/api/sessions/${sessionId}/ws?fromOffset=0`);
      const settled = await c.waitFor((f) => f.type === "submission.settled");
      const queueState = c.frames.find((f) => f.type === "queue.state");

      expect(queueState).toBeDefined();
      const qsState = (queueState as { state: { pendingIds: string[]; collectingIds: string[]; activeItemId?: string } })
        .state;
      expect(qsState.activeItemId).toBe("q1");
      expect(qsState.pendingIds).toEqual(["q2"]);
      expect(qsState.collectingIds).toEqual(["q3"]);

      const ss = settled as { queueItemId: string; outcome: string };
      expect(ss.queueItemId).toBe("q1");
      expect(ss.outcome).toBe("completed");
      c.close();
    } finally {
      await api.cleanup();
    }
  });
});
