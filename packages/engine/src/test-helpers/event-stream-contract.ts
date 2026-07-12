import { describe, it, expect } from "vitest";
import type { BusEvent, DeliveredBusEvent, EngineEvent, EventStream, QueueState } from "../index.js";

const idleQueueState = (threadId: string): QueueState => ({
  threadId,
  mode: "followup",
  status: "idle",
  pending: [],
});

export interface EventStreamContractContext {
  factory: () => Promise<EventStream> | EventStream;
}

function ev(sessionId: string, overrides: Partial<BusEvent> = {}): BusEvent {
  return {
    sessionId,
    threadId: "th-1",
    event: { type: "turn_end", threadId: "th-1", reason: "end_turn" } as EngineEvent,
    timestamp: 1,
    ...overrides,
  };
}

export function runEventStreamContract(name: string, ctx: EventStreamContractContext) {
  describe(`EventStream contract: ${name}`, () => {
    it("returns monotonic, lexicographically increasing offsets per session; sessions have independent sequences", async () => {
      const stream = await ctx.factory();
      const a1 = await stream.append(ev("sess-a"), "key-a1");
      const a2 = await stream.append(ev("sess-a"), "key-a2");
      const b1 = await stream.append(ev("sess-b"), "key-b1");

      expect(a1.offset < a2.offset).toBe(true);
      expect(a1.offset.length).toBe(16);
      expect(a2.offset.length).toBe(16);
      // Independent sequences: session b's first offset is not required to
      // relate to session a's offsets, but must itself be a valid 16-digit offset.
      expect(b1.offset.length).toBe(16);
    });

    it("appendOnce: same (sessionId, eventKey) twice returns the first offset; read shows one event", async () => {
      const stream = await ctx.factory();
      const first = await stream.append(ev("sess-1"), "dup-key");
      const second = await stream.append(ev("sess-1", { timestamp: 2 }), "dup-key");

      expect(second.offset).toBe(first.offset);

      const { events } = await stream.read("sess-1");
      expect(events.length).toBe(1);
      expect(events[0]?.timestamp).toBe(1);
    });

    it("different sessions may reuse the same eventKey", async () => {
      const stream = await ctx.factory();
      const a = await stream.append(ev("sess-a"), "shared-key");
      const b = await stream.append(ev("sess-b"), "shared-key");

      const readA = await stream.read("sess-a");
      const readB = await stream.read("sess-b");
      expect(readA.events.length).toBe(1);
      expect(readB.events.length).toBe(1);
      expect(readA.events[0]?.offset).toBe(a.offset);
      expect(readB.events[0]?.offset).toBe(b.offset);
    });

    it("read with no fromOffset returns all in order; fromOffset returns strictly after; limit paginates without gaps/dupes", async () => {
      const stream = await ctx.factory();
      const offsets: string[] = [];
      for (let i = 0; i < 5; i++) {
        const { offset } = await stream.append(ev("sess-1", { timestamp: i }), `key-${i}`);
        offsets.push(offset);
      }

      const all = await stream.read("sess-1");
      expect(all.events.map((e) => e.timestamp)).toEqual([0, 1, 2, 3, 4]);
      expect(all.nextOffset).toBe(offsets[4]);

      const after = await stream.read("sess-1", { fromOffset: offsets[1] });
      expect(after.events.map((e) => e.timestamp)).toEqual([2, 3, 4]);

      const page1 = await stream.read("sess-1", { limit: 2 });
      expect(page1.events.map((e) => e.timestamp)).toEqual([0, 1]);
      expect(page1.nextOffset).toBe(offsets[1]);

      const page2 = await stream.read("sess-1", { fromOffset: page1.nextOffset, limit: 2 });
      expect(page2.events.map((e) => e.timestamp)).toEqual([2, 3]);
      expect(page2.nextOffset).toBe(offsets[3]);

      const page3 = await stream.read("sess-1", { fromOffset: page2.nextOffset, limit: 2 });
      expect(page3.events.map((e) => e.timestamp)).toEqual([4]);
      expect(page3.nextOffset).toBe(offsets[4]);
    });

    it("subscribe({ sessionId }) receives appended events with their offsets, in append order; unsubscribe stops delivery", async () => {
      const stream = await ctx.factory();
      const received: DeliveredBusEvent[] = [];
      const unsubscribe = stream.subscribe({ sessionId: "sess-1" }, (e) => received.push(e));

      const a1 = await stream.append(ev("sess-1", { timestamp: 1 }), "k1");
      const a2 = await stream.append(ev("sess-1", { timestamp: 2 }), "k2");

      expect(received.length).toBe(2);
      expect(received[0]?.offset).toBe(a1.offset);
      expect(received[1]?.offset).toBe(a2.offset);

      unsubscribe();
      await stream.append(ev("sess-1", { timestamp: 3 }), "k3");
      expect(received.length).toBe(2);
    });

    it("subscribe with eventTypes filters; different sessionId receives nothing", async () => {
      const stream = await ctx.factory();
      const received: DeliveredBusEvent[] = [];
      stream.subscribe({ sessionId: "sess-1", eventTypes: ["queue_state"] }, (e) => received.push(e));

      await stream.append(ev("sess-1"), "k1"); // turn_end, filtered out
      await stream.append(
        ev("sess-1", {
          event: { type: "queue_state", threadId: "th-1", state: idleQueueState("th-1") } as EngineEvent,
        }),
        "k2",
      );

      expect(received.length).toBe(1);
      expect(received[0]?.event.type).toBe("queue_state");

      const otherSession: DeliveredBusEvent[] = [];
      stream.subscribe({ sessionId: "sess-2" }, (e) => otherSession.push(e));
      await stream.append(
        ev("sess-1", {
          event: { type: "queue_state", threadId: "th-1", state: idleQueueState("th-1") } as EngineEvent,
        }),
        "k3",
      );
      expect(otherSession.length).toBe(0);
    });

    it("publishEphemeral reaches subscribers with offset === undefined and is absent from read", async () => {
      const stream = await ctx.factory();
      const received: DeliveredBusEvent[] = [];
      stream.subscribe({ sessionId: "sess-1" }, (e) => received.push(e));

      stream.publishEphemeral(
        ev("sess-1", { event: { type: "text_delta", threadId: "th-1", text: "hi" } as EngineEvent }),
      );

      expect(received.length).toBe(1);
      expect(received[0]?.offset).toBeUndefined();

      const { events } = await stream.read("sess-1");
      expect(events.length).toBe(0);
    });

    it("prune deletes only events with the matching queueItemId; offsets of survivors unchanged", async () => {
      const stream = await ctx.factory();
      const a = await stream.append(ev("sess-1", { queueItemId: "itemA" }), "k1");
      const b = await stream.append(ev("sess-1", { queueItemId: "itemB" }), "k2");
      const c = await stream.append(ev("sess-1"), "k3"); // no queueItemId

      const deleted = await stream.prune("sess-1", ["itemA"]);
      expect(deleted).toBe(1);

      const { events } = await stream.read("sess-1");
      expect(events.map((e) => e.offset)).toEqual([b.offset, c.offset]);
    });

    it("deleteSession empties read for that session and only that session", async () => {
      const stream = await ctx.factory();
      await stream.append(ev("sess-1"), "k1");
      await stream.append(ev("sess-2"), "k2");

      await stream.deleteSession("sess-1");

      const readA = await stream.read("sess-1");
      const readB = await stream.read("sess-2");
      expect(readA.events.length).toBe(0);
      expect(readB.events.length).toBe(1);
    });

    it("gap-refetch invariant: read(fromOffset: offsets[1]) after 5 appends returns exactly events 3..5", async () => {
      const stream = await ctx.factory();
      const offsets: string[] = [];
      for (let i = 0; i < 5; i++) {
        const { offset } = await stream.append(ev("sess-1", { timestamp: i }), `key-${i}`);
        offsets.push(offset);
      }

      const { events } = await stream.read("sess-1", { fromOffset: offsets[1] });
      expect(events.map((e) => e.timestamp)).toEqual([2, 3, 4]);
    });
  });
}
