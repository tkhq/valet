import { describe, it, expect, beforeEach } from "vitest";
import type {
  DecisionGate,
  Lease,
  MessageEntry,
  QueueItem,
  SessionData,
  SessionStore,
  SuspendedTurnState,
  ThreadData,
  Wakeup,
} from "../index.js";

export interface StoreContractContext {
  factory: () => SessionStore | Promise<SessionStore>;
  teardown?: (store: SessionStore) => void | Promise<void>;
}

export function runSessionStoreContract(name: string, ctx: StoreContractContext) {
  describe(`SessionStore contract: ${name}`, () => {
    let store: SessionStore;

    beforeEach(async () => {
      store = await ctx.factory();
    });

    function newSession(overrides: Partial<SessionData> = {}): SessionData {
      return {
        id: "sess-1",
        owner: { type: "user", id: "u1" },
        userId: "u1",
        orgId: "o1",
        workspace: "/",
        purpose: "interactive",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
      };
    }

    function newThread(sessionId: string, key = "web:default", id = "th-1"): ThreadData {
      return {
        id,
        sessionId,
        key,
        status: "active",
        queueMode: "followup",
        createdAt: 1,
        updatedAt: 1,
      };
    }

    function queueItem(id: string, createdAt: number, updatedAt: number): QueueItem {
      return {
        id,
        threadId: "th-1",
        content: "hello",
        status: "queued",
        attemptCount: 0,
        maxAttempts: 10,
        timeoutAt: createdAt + 3_600_000,
        createdAt,
        updatedAt,
      };
    }

    function msg(id: string, role: "user" | "assistant", content: string, ts: number): MessageEntry {
      return {
        id,
        sessionId: "sess-1",
        threadId: "th-1",
        parentId: null,
        type: "message",
        role,
        content,
        createdAt: ts,
      };
    }

    it("saveSession + getSession round-trips", async () => {
      const s = newSession();
      await store.saveSession(s);
      const loaded = await store.getSession(s.id);
      expect(loaded).toMatchObject({ id: "sess-1", userId: "u1", status: "running" });
    });

    it("listSessions filters by userId", async () => {
      await store.saveSession(newSession({ id: "a", userId: "u1" }));
      await store.saveSession(newSession({ id: "b", userId: "u2" }));
      const list = await store.listSessions("u1");
      expect(list.map((s) => s.id)).toEqual(["a"]);
    });

    it("saveSession round-trips the reasoning level", async () => {
      // The session-default reasoning level is a persisted column, not a
      // derived value: a restart must return the level the user chose.
      await store.saveSession(newSession({ reasoning: "high" }));
      expect((await store.getSession("sess-1"))?.reasoning).toBe("high");
      // Clearing it persists as absent, not as a stale "high".
      await store.saveSession(newSession({ reasoning: undefined }));
      expect((await store.getSession("sess-1"))?.reasoning).toBeUndefined();
    });

    it("saveThread round-trips the reasoning pin", async () => {
      await store.saveSession(newSession());
      const t = newThread("sess-1");
      await store.saveThread("sess-1", { ...t, reasoning: "low" });
      expect((await store.getThread("sess-1", "th-1"))?.reasoning).toBe("low");
      await store.saveThread("sess-1", { ...t, reasoning: undefined });
      expect((await store.getThread("sess-1", "th-1"))?.reasoning).toBeUndefined();
    });

    it("saveThread + listThreads round-trips", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1", "task:A", "th-1"));
      await store.saveThread("sess-1", newThread("sess-1", "task:B", "th-2"));
      const threads = await store.listThreads("sess-1");
      expect(threads.length).toBe(2);
      expect(threads.map((t) => t.key).sort()).toEqual(["task:A", "task:B"]);
    });

    it("getThreadSnapshot keeps its active leaf in the returned entries", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      await store.appendEntries("sess-1", "th-1", [msg("e-base", "user", "base", 1)]);

      for (let index = 0; index < 10; index++) {
        const entry = msg(`e-race-${index}`, "assistant", "race", index + 2);
        const [snapshot] = await Promise.all([
          store.getThreadSnapshot("sess-1", "th-1"),
          store.appendEntries("sess-1", "th-1", [entry]),
        ]);
        expect(snapshot).not.toBeNull();
        const ids = new Set(snapshot?.entries.map((item) => item.id));
        expect(ids.has(snapshot?.thread.activeLeafEntryId ?? "")).toBe(true);
      }
    });

    it("saveThread cannot rewind the leaf advanced by appendEntries", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      await store.appendEntries("sess-1", "th-1", [msg("e-1", "user", "one", 1)]);
      const stale = await store.getThread("sess-1", "th-1");
      if (!stale) throw new Error("thread missing");
      await store.appendEntries("sess-1", "th-1", [msg("e-2", "assistant", "two", 2)]);

      await store.saveThread("sess-1", { ...stale, status: "paused" });

      expect(await store.getThread("sess-1", "th-1")).toMatchObject({
        status: "paused",
        activeLeafEntryId: "e-2",
      });
    });

    it("appendEntries + getEntries returns entries in insertion order", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      await store.appendEntries("sess-1", "th-1", [
        msg("e-1", "user", "hi", 10),
        msg("e-2", "assistant", "hello", 20),
      ]);
      const loaded = await store.getEntries("sess-1", "th-1");
      expect(loaded).toHaveLength(2);
      expect(loaded[0]).toMatchObject({ id: "e-1", type: "message", role: "user", content: "hi" });
      expect(loaded[1]).toMatchObject({ id: "e-2", type: "message", role: "assistant" });
    });

    it("filters submission logs before taking the ordered tail", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      await store.appendEntries("sess-1", "th-1", [
        { ...msg("e-1", "user", "step input", 10), queueItemId: "q-step" },
        { ...msg("e-2", "assistant", "step output", 20), queueItemId: "q-step" },
        { ...msg("e-3", "user", "unrelated input", 30), queueItemId: "q-other" },
        { ...msg("e-4", "assistant", "unrelated output", 40), queueItemId: "q-other" },
      ]);
      const loaded = await store.getEntries("sess-1", "th-1", { queueItemId: "q-step", limit: 1 });
      expect(loaded.map((e) => e.id)).toEqual(["e-2"]);
      expect(await store.getEntries("sess-1", "th-1", { queueItemId: "missing" })).toEqual([]);
    });

    it("getEntries breaks a same-millisecond tie by insertion order (TKAI-303)", async () => {
      // Two entries in one turn are frequently written inside the same
      // millisecond (a tool result and the assistant reply that follows it).
      // created_at alone cannot order them, so the read needs a tiebreaker
      // that is monotonic in insertion order.
      //
      // A later updateEntry on the FIRST row is what makes the bug bite on a
      // real backend: an in-place update rewrites the row to a new physical
      // location, so a created_at-only read can return the rewritten first
      // entry AFTER the untouched second one. The parts of an assistant entry
      // are re-persisted this way after message_end, so this is the exact
      // production path, not a contrived one. The read must still return the
      // pair in insertion order.
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      await store.appendEntries("sess-1", "th-1", [
        msg("e-first", "user", "first", 1000),
        msg("e-second", "assistant", "second", 1000),
      ]);
      await store.updateEntry("sess-1", "th-1", msg("e-first", "user", "first (edited)", 1000));
      const loaded = await store.getEntries("sess-1", "th-1");
      expect(loaded.map((e) => e.id)).toEqual(["e-first", "e-second"]);
      expect(loaded[0]).toMatchObject({ id: "e-first", content: "first (edited)" });
    });

    it("updateEntry replaces an existing entry in place", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      await store.appendEntries("sess-1", "th-1", [
        msg("e-1", "user", "original", 10),
      ]);
      const updated: MessageEntry = {
        id: "e-1",
        sessionId: "sess-1",
        threadId: "th-1",
        parentId: null,
        type: "message",
        role: "user",
        content: "rewritten",
        createdAt: 10,
      };
      await store.updateEntry("sess-1", "th-1", updated);
      const loaded = await store.getEntries("sess-1", "th-1");
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toMatchObject({ id: "e-1", content: "rewritten" });
    });

    it("round-trips tool_call parts with full fidelity (args, status, result)", async () => {
      // Regression guard: tool_call parts must survive serialization with
      // their nested args + result intact. A bug in a store impl that
      // dropped or coerced these fields would manifest as tool cards going
      // missing on reload.
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const entry: MessageEntry = {
        id: "e-1",
        sessionId: "sess-1",
        threadId: "th-1",
        parentId: null,
        type: "message",
        role: "assistant",
        content: "running write",
        parts: [
          { type: "text", text: "running write" },
          {
            type: "tool_call",
            callId: "tc1",
            toolName: "write",
            status: "running",
            args: { path: "/tmp/x.txt", content: "ok" },
          },
        ],
        createdAt: 10,
      };
      await store.appendEntries("sess-1", "th-1", [entry]);
      const loaded = await store.getEntries("sess-1", "th-1");
      expect(loaded).toHaveLength(1);
      const reloaded = loaded[0];
      expect(reloaded.type).toBe("message");
      if (reloaded.type !== "message") throw new Error("unreachable");
      expect(reloaded.parts).toHaveLength(2);
      const tcPart = reloaded.parts?.[1];
      expect(tcPart).toMatchObject({
        type: "tool_call",
        callId: "tc1",
        toolName: "write",
        status: "running",
        args: { path: "/tmp/x.txt", content: "ok" },
      });
    });

    it("updateEntry transitions a tool_call from running → completed (with result)", async () => {
      // The bug we're guarding: engine persists at message_end with
      // status="running", then tool_execution_end mutates the in-memory
      // part — without an updateEntry call, the store stays stale.
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const before: MessageEntry = {
        id: "e-1",
        sessionId: "sess-1",
        threadId: "th-1",
        parentId: null,
        type: "message",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool_call",
            callId: "tc1",
            toolName: "bash",
            status: "running",
            args: { command: "echo hi" },
          },
        ],
        createdAt: 10,
      };
      await store.appendEntries("sess-1", "th-1", [before]);

      // Mirror what the engine does: mutate the part, persist via updateEntry.
      const after: MessageEntry = {
        ...before,
        parts: [
          {
            type: "tool_call",
            callId: "tc1",
            toolName: "bash",
            status: "completed",
            args: { command: "echo hi" },
            result: { text: "hi\n" },
          },
        ],
      };
      await store.updateEntry("sess-1", "th-1", after);

      const loaded = await store.getEntries("sess-1", "th-1");
      expect(loaded).toHaveLength(1);
      const reloaded = loaded[0];
      if (reloaded.type !== "message") throw new Error("unreachable");
      const tc = reloaded.parts?.[0];
      expect(tc).toMatchObject({
        type: "tool_call",
        status: "completed",
        result: { text: "hi\n" },
      });
    });

    it("updateEntry throws NotFoundError when no matching entry exists", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const ghost: MessageEntry = {
        id: "ghost",
        sessionId: "sess-1",
        threadId: "th-1",
        parentId: null,
        type: "message",
        role: "user",
        content: "x",
        createdAt: 1,
      };
      await expect(store.updateEntry("sess-1", "th-1", ghost)).rejects.toThrow(
        /not found/,
      );
    });

    it("appendEntries persists decision_gate entries", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const gate: DecisionGate = {
        id: "g-1",
        sessionId: "sess-1",
        threadId: "th-1",
        queueItemId: "q-1",
        resumeKey: "rk",
        ordinal: 0,
        type: "approval",
        status: "pending",
        title: "ok?",
        actions: [{ id: "approve", label: "Approve" }],
        createdAt: 100,
        updatedAt: 100,
      };
      await store.saveDecisionGate("sess-1", "th-1", gate);
      await store.appendEntries("sess-1", "th-1", [
        {
          id: "e-g",
          sessionId: "sess-1",
          threadId: "th-1",
          parentId: null,
          type: "decision_gate",
          gate,
          createdAt: 100,
        },
      ]);
      const loaded = await store.getEntries("sess-1", "th-1");
      const gateEntry = loaded.find((e) => e.type === "decision_gate");
      expect(gateEntry).toBeDefined();
      expect(gateEntry && gateEntry.type === "decision_gate" && gateEntry.gate.id).toBe("g-1");
    });

    it("entry queueItemId + stopReason round-trip through appendEntries/getEntries", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const entry: MessageEntry = {
        id: "e-1",
        sessionId: "sess-1",
        threadId: "th-1",
        parentId: null,
        type: "message",
        role: "assistant",
        content: "done",
        queueItemId: "q-1",
        stopReason: "end_turn",
        createdAt: 10,
      };
      await store.appendEntries("sess-1", "th-1", [entry]);
      const loaded = await store.getEntries("sess-1", "th-1");
      expect(loaded).toHaveLength(1);
      expect(loaded[0].queueItemId).toBe("q-1");
      const reloaded = loaded[0];
      if (reloaded.type !== "message") throw new Error("unreachable");
      expect(reloaded.stopReason).toBe("end_turn");
    });

    it("session owner/parentThreadId round-trips", async () => {
      const s = newSession({
        owner: { type: "team", id: "team-1" },
        parentThreadId: "parent-th-1",
      });
      await store.saveSession(s);
      const loaded = await store.getSession(s.id);
      expect(loaded?.owner).toEqual({ type: "team", id: "team-1" });
      expect(loaded?.parentThreadId).toBe("parent-th-1");
    });

    it("saveDecisionGate + listDecisionGates + getDecisionGate", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const gate: DecisionGate = {
        id: "g-1",
        sessionId: "sess-1",
        threadId: "th-1",
        queueItemId: "q-1",
        resumeKey: "rk",
        ordinal: 0,
        type: "approval",
        status: "pending",
        title: "x",
        actions: [],
        createdAt: 1,
        updatedAt: 1,
      };
      await store.saveDecisionGate("sess-1", "th-1", gate);
      const list = await store.listDecisionGates("sess-1");
      expect(list).toHaveLength(1);
      const single = await store.getDecisionGate("sess-1", "g-1");
      expect(single?.title).toBe("x");
      await store.saveDecisionGate("sess-1", "th-1", { ...gate, id: "resolved-gate", status: "resolved" });
      expect((await store.listDecisionGates("sess-1", undefined, "pending")).map((g) => g.id)).toEqual(["g-1"]);
      expect(await store.listDecisionGates("sess-1", "other-thread", "pending")).toEqual([]);
      expect((await store.listDecisionGates("sess-1", "th-1", "resolved")).map((g) => g.id)).toEqual(["resolved-gate"]);
    });

    it("gate resolution round-trips on the row (sticky-denial source of truth)", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const pending: DecisionGate = {
        id: "g-res",
        sessionId: "sess-1",
        threadId: "th-1",
        queueItemId: "q-1",
        resumeKey: "rk",
        ordinal: 0,
        type: "approval",
        status: "pending",
        title: "x",
        actions: [],
        createdAt: 1,
        updatedAt: 1,
      };
      await store.saveDecisionGate("sess-1", "th-1", pending);
      expect((await store.getDecisionGate("sess-1", "g-res"))?.resolution).toBeFalsy();

      const resolution = {
        actionId: "deny",
        resolvedBy: "u-1",
        resolvedAt: 42,
        gateOrdinal: 0,
      };
      // Same upsert path persistTerminalGate uses: the resolution must
      // survive the ON CONFLICT update, not only the initial insert.
      await store.saveDecisionGate("sess-1", "th-1", {
        ...pending,
        status: "resolved",
        resolution,
        updatedAt: 2,
      });
      const reloaded = await store.getDecisionGate("sess-1", "g-res");
      expect(reloaded?.status).toBe("resolved");
      expect(reloaded?.resolution).toEqual(resolution);
      const viaResume = await store.getLatestGateForResume("sess-1", "th-1", "q-1", "rk");
      expect(viaResume?.resolution?.actionId).toBe("deny");
    });

    it("listDecisionGatesForQueueItem returns only that queue item's gates", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const base = {
        sessionId: "sess-1",
        threadId: "th-1",
        type: "approval" as const,
        status: "pending" as const,
        title: "x",
        actions: [],
        createdAt: 1,
        updatedAt: 1,
      };
      await store.saveDecisionGate("sess-1", "th-1", {
        ...base,
        id: "g-q1-a",
        queueItemId: "q-1",
        resumeKey: "rk-a",
        ordinal: 0,
      });
      await store.saveDecisionGate("sess-1", "th-1", {
        ...base,
        id: "g-q1-b",
        queueItemId: "q-1",
        resumeKey: "rk-b",
        ordinal: 0,
      });
      await store.saveDecisionGate("sess-1", "th-1", {
        ...base,
        id: "g-q2",
        queueItemId: "q-2",
        resumeKey: "rk-a",
        ordinal: 0,
      });

      const q1 = await store.listDecisionGatesForQueueItem("sess-1", "th-1", "q-1");
      expect(q1.map((g) => g.id).sort()).toEqual(["g-q1-a", "g-q1-b"]);
      const q3 = await store.listDecisionGatesForQueueItem("sess-1", "th-1", "q-3");
      expect(q3).toEqual([]);
    });

    it("getLatestGateForResume returns the highest ordinal for a (queueItem, resumeKey)", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const base = {
        sessionId: "sess-1",
        threadId: "th-1",
        type: "approval" as const,
        status: "resolved" as const,
        title: "x",
        actions: [],
        createdAt: 1,
        updatedAt: 1,
      };
      const g0: DecisionGate = {
        ...base,
        id: "gate:sess-1:th-1:q-1:rk:0",
        queueItemId: "q-1",
        resumeKey: "rk",
        ordinal: 0,
      };
      const g1: DecisionGate = {
        ...base,
        id: "gate:sess-1:th-1:q-1:rk:1",
        queueItemId: "q-1",
        resumeKey: "rk",
        ordinal: 1,
      };
      // A gate for a different resumeKey must not leak into the lookup.
      const other: DecisionGate = {
        ...base,
        id: "gate:sess-1:th-1:q-1:other:0",
        queueItemId: "q-1",
        resumeKey: "other",
        ordinal: 0,
      };
      await store.saveDecisionGate("sess-1", "th-1", g0);
      await store.saveDecisionGate("sess-1", "th-1", g1);
      await store.saveDecisionGate("sess-1", "th-1", other);

      const latest = await store.getLatestGateForResume("sess-1", "th-1", "q-1", "rk");
      expect(latest?.id).toBe("gate:sess-1:th-1:q-1:rk:1");
      expect(latest?.ordinal).toBe(1);

      const none = await store.getLatestGateForResume("sess-1", "th-1", "q-1", "missing");
      expect(none).toBeNull();
    });

    it("getLatestGateForResume does not collide on colon-prefixed resumeKeys", async () => {
      // resumeKeys may themselves contain ':' — a resumeKey like "read:/x" is
      // a colon-prefix of "read:/x:confirm". A gate lookup must match the
      // resumeKey field exactly, not via a startsWith on the derived id.
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const base = {
        sessionId: "sess-1",
        threadId: "th-1",
        queueItemId: "q-1",
        type: "approval" as const,
        status: "resolved" as const,
        title: "x",
        actions: [],
        createdAt: 1,
        updatedAt: 1,
      };
      const longer: DecisionGate = {
        ...base,
        id: "gate:sess-1:th-1:q-1:read:/x:confirm:0",
        resumeKey: "read:/x:confirm",
        ordinal: 0,
      };
      await store.saveDecisionGate("sess-1", "th-1", longer);

      // The shorter resumeKey has no gate saved yet — a prefix match would
      // incorrectly return `longer` here.
      const shortLookup = await store.getLatestGateForResume("sess-1", "th-1", "q-1", "read:/x");
      expect(shortLookup).toBeNull();

      const shorter: DecisionGate = {
        ...base,
        id: "gate:sess-1:th-1:q-1:read:/x:0",
        resumeKey: "read:/x",
        ordinal: 0,
      };
      await store.saveDecisionGate("sess-1", "th-1", shorter);

      const shortLookup2 = await store.getLatestGateForResume("sess-1", "th-1", "q-1", "read:/x");
      expect(shortLookup2?.id).toBe("gate:sess-1:th-1:q-1:read:/x:0");
      expect(shortLookup2?.resumeKey).toBe("read:/x");

      const longLookup = await store.getLatestGateForResume("sess-1", "th-1", "q-1", "read:/x:confirm");
      expect(longLookup?.id).toBe("gate:sess-1:th-1:q-1:read:/x:confirm:0");
      expect(longLookup?.resumeKey).toBe("read:/x:confirm");
    });

    it("saveSuspendedTurn + getSuspendedTurn + clearSuspendedTurn", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const sus: SuspendedTurnState = {
        sessionId: "sess-1",
        threadId: "th-1",
        queueItemId: "q-1",
        gateId: "g-1",
        model: "faux/faux-1",
        toolCallId: "tc-1",
        toolName: "do_thing",
        toolArgs: { arg: "x" },
        resumeKey: "do_thing:x",
        ordinal: 0,
        attempt: 1,
        createdAt: 1,
      };
      await store.saveSuspendedTurn("sess-1", "th-1", sus);
      expect(await store.getSuspendedTurn("sess-1", "th-1")).toMatchObject({
        toolName: "do_thing",
        toolArgs: { arg: "x" },
      });
      await store.clearSuspendedTurn("sess-1", "th-1");
      expect(await store.getSuspendedTurn("sess-1", "th-1")).toBeNull();
    });

    it("updateDecisionGateEntry patches the matching entry", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const gate: DecisionGate = {
        id: "g-1",
        sessionId: "sess-1",
        threadId: "th-1",
        queueItemId: "q-1",
        resumeKey: "rk",
        ordinal: 0,
        type: "approval",
        status: "pending",
        title: "x",
        actions: [],
        createdAt: 1,
        updatedAt: 1,
      };
      await store.saveDecisionGate("sess-1", "th-1", gate);
      await store.appendEntries("sess-1", "th-1", [
        {
          id: "e-g",
          sessionId: "sess-1",
          threadId: "th-1",
          parentId: null,
          type: "decision_gate",
          gate,
          createdAt: 1,
        },
      ]);
      await store.updateDecisionGateEntry("sess-1", "th-1", "g-1", {
        gate: { ...gate, status: "resolved" },
        resolution: { actionId: "approve", resolvedBy: "u1", resolvedAt: 5 },
      });
      const entries = await store.getEntries("sess-1", "th-1");
      const e = entries.find((x) => x.type === "decision_gate");
      expect(e && e.type === "decision_gate" && e.gate.status).toBe("resolved");
      expect(e && e.type === "decision_gate" && e.resolution?.actionId).toBe("approve");
    });

    describe("wakeups and leases", () => {
      const wakeup = (over: Partial<Wakeup> = {}): Wakeup => ({
        id: "wk_a", sessionId: "sess-1", threadId: "th-1", kind: "process", status: "running",
        reason: "proof build", command: "lake build", execId: "job-1", leaseId: "ls_a",
        deadlineAt: 10_000, logOffset: 0, logTail: "", eventCount: 0, createdAt: 1, updatedAt: 1, ...over,
      });
      const lease = (over: Partial<Lease> = {}): Lease => ({
        id: "ls_a", sessionId: "sess-1", sandboxId: "sb-1", ownerKind: "process", ownerId: "wk_a",
        reason: "proof build", createdAt: 1, deadlineAt: 10_000, ...over,
      });

      it("creates, gets, and lists wakeups by status", async () => {
        await store.createWakeup(wakeup());
        await store.createWakeup(wakeup({ id: "wk_b", kind: "timer", status: "pending", command: undefined, execId: undefined, leaseId: undefined, prompt: "check", fireAt: 500, deadlineAt: undefined }));
        expect(await store.getWakeup("wk_a")).toEqual(wakeup());
        expect((await store.listWakeups("sess-1")).map((w) => w.id).sort()).toEqual(["wk_a", "wk_b"]);
        expect((await store.listWakeups("sess-1", ["pending"])).map((w) => w.id)).toEqual(["wk_b"]);
        expect(await store.getWakeup("missing")).toBeNull();
      });

      it("lists due wakeups: running process/watch always, pending timer only at or past fireAt", async () => {
        await store.createWakeup(wakeup());
        await store.createWakeup(wakeup({ id: "wk_t", kind: "timer", status: "pending", prompt: "p", fireAt: 500, command: undefined, execId: undefined, leaseId: undefined, deadlineAt: undefined }));
        await store.createWakeup(wakeup({ id: "wk_done", status: "done" }));
        expect((await store.listDueWakeups(100, 10)).map((w) => w.id)).toEqual(["wk_a"]);
        expect((await store.listDueWakeups(500, 10)).map((w) => w.id).sort()).toEqual(["wk_a", "wk_t"]);
        expect(await store.listDueWakeups(500, 1)).toHaveLength(1);
      });

      it("transitionWakeup is a CAS: the second caller gets null", async () => {
        await store.createWakeup(wakeup());
        const first = await store.transitionWakeup("wk_a", ["running"], "done", { cause: "exit", exitCode: 0, endedAt: 50 }, 50);
        expect(first).toMatchObject({ status: "done", cause: "exit", exitCode: 0, endedAt: 50, updatedAt: 50 });
        const second = await store.transitionWakeup("wk_a", ["running"], "expired", { cause: "deadline" }, 60);
        expect(second).toBeNull();
        expect((await store.getWakeup("wk_a"))?.status).toBe("done");
      });

      it("transitionWakeup can patch a running row in place", async () => {
        await store.createWakeup(wakeup());
        const patched = await store.transitionWakeup("wk_a", ["running"], "running", { logOffset: 40, logTail: "tail", eventCount: 2 }, 7);
        expect(patched).toMatchObject({ status: "running", logOffset: 40, logTail: "tail", eventCount: 2 });
      });

      it("creates, lists, counts, and releases leases exactly once", async () => {
        await store.createLease(lease());
        await store.createLease(lease({ id: "ls_b", sessionId: "sess-2", ownerKind: "hold", ownerId: undefined }));
        expect(await store.countActiveLeases("sess-1")).toBe(1);
        expect((await store.listActiveLeases("sess-1")).map((l) => l.id)).toEqual(["ls_a"]);
        expect((await store.listAllActiveLeases()).map((l) => l.id).sort()).toEqual(["ls_a", "ls_b"]);
        const released = await store.releaseLease("ls_a", "owner_ended", 99);
        expect(released).toMatchObject({ releasedAt: 99, releaseCause: "owner_ended" });
        expect(await store.releaseLease("ls_a", "deadline", 100)).toBeNull();
        expect(await store.countActiveLeases("sess-1")).toBe(0);
        expect((await store.listAllActiveLeases()).map((l) => l.id)).toEqual(["ls_b"]);
      });

      it("pages due wakeups by (createdAt, id) so no row starves behind a full batch", async () => {
        // Three always-due running rows are older than the due timer. With a
        // batch of 2, the timer is reachable only through the cursor.
        await store.createWakeup(wakeup({ id: "wk_1", createdAt: 1 }));
        await store.createWakeup(wakeup({ id: "wk_2", createdAt: 2 }));
        await store.createWakeup(wakeup({ id: "wk_3", createdAt: 2 }));
        await store.createWakeup(wakeup({ id: "wk_t", kind: "timer", status: "pending", prompt: "p", fireAt: 5, createdAt: 9, command: undefined, execId: undefined, leaseId: undefined, deadlineAt: undefined }));
        const first = await store.listDueWakeups(10, 2);
        expect(first.map((w) => w.id)).toEqual(["wk_1", "wk_2"]);
        const second = await store.listDueWakeups(10, 2, { createdAt: 2, id: "wk_2" });
        expect(second.map((w) => w.id)).toEqual(["wk_3", "wk_t"]);
        expect(await store.listDueWakeups(10, 2, { createdAt: 9, id: "wk_t" })).toEqual([]);
      });

      it("fills a missing lease sandbox id once, and only on an active lease", async () => {
        await store.createLease(lease({ sandboxId: undefined }));
        expect(await store.setLeaseSandboxId("ls_a", "sb-9")).toBe(true);
        expect(await store.setLeaseSandboxId("ls_a", "sb-10")).toBe(false);
        expect((await store.listActiveLeases("sess-1"))[0]?.sandboxId).toBe("sb-9");
        await store.createLease(lease({ id: "ls_r", sandboxId: undefined }));
        await store.releaseLease("ls_r", "cancelled", 5);
        expect(await store.setLeaseSandboxId("ls_r", "sb-9")).toBe(false);
      });

      it("deleteSession deletes the session's wakeup and lease rows and keeps other sessions' rows", async () => {
        await store.saveSession(newSession());
        await store.createWakeup(wakeup());
        await store.createWakeup(wakeup({ id: "wk_t", kind: "timer", status: "pending", prompt: "p", fireAt: 500, command: undefined, execId: undefined, leaseId: undefined, deadlineAt: undefined }));
        await store.createWakeup(wakeup({ id: "wk_done", status: "done", cause: "exit", leaseId: undefined }));
        await store.createWakeup(wakeup({ id: "wk_other", sessionId: "sess-2", leaseId: "ls_o" }));
        await store.createLease(lease());
        await store.createLease(lease({ id: "ls_h", ownerKind: "hold", ownerId: undefined }));
        await store.createLease(lease({ id: "ls_o", sessionId: "sess-2", ownerId: "wk_other" }));

        await store.deleteSession("sess-1");

        // The rows held the command, the prompt, and a log tail. A deleted
        // session keeps none of them (fix wave 2, M12).
        expect(await store.getWakeup("wk_a")).toBeNull();
        expect(await store.getWakeup("wk_t")).toBeNull();
        expect(await store.getWakeup("wk_done")).toBeNull();
        expect(await store.listWakeups("sess-1")).toEqual([]);
        expect(await store.getWakeup("wk_other")).toMatchObject({ status: "running" });
        expect(await store.countActiveLeases("sess-1")).toBe(0);
        expect((await store.listAllActiveLeases()).map((l) => l.id)).toEqual(["ls_o"]);
        expect(await store.releaseLease("ls_h", "deadline", 1)).toBeNull();
        // A watcher CAS on a deleted row loses.
        expect(await store.transitionWakeup("wk_a", ["running"], "done", { cause: "exit" }, 2)).toBeNull();
        expect(await store.listDueWakeups(1_000, 10)).toEqual([expect.objectContaining({ id: "wk_other" })]);
      });

      // ── fix wave 2 (B2, H3, M11, M12, M14, M17, B7, L8) ──

      const origin = { channelType: "slack", threadKey: "slack:C1:1.2", messageTs: "1.2" };

      it("round-trips every wakeup and lease field, origin and rate window included", async () => {
        const w = wakeup({ origin, windowStartAt: 100, windowCount: 3, logTail: "tail ✓", eventCount: 3 });
        const l = lease({ threadId: "th-1", origin });
        await store.createWakeupWithLease(w, l);
        expect(await store.getWakeup("wk_a")).toEqual(w);
        expect(await store.listActiveLeases("sess-1")).toEqual([l]);
        const t = wakeup({ id: "wk_t", kind: "timer", status: "pending", prompt: "p", fireAt: 5, command: undefined, execId: undefined, leaseId: undefined, deadlineAt: undefined });
        await store.createWakeup(t);
        expect(await store.getWakeup("wk_t")).toEqual(t);
      });

      it("createWakeupWithLease writes both rows or neither", async () => {
        await store.createWakeup(wakeup());
        await expect(store.createWakeupWithLease(wakeup(), lease({ id: "ls_new" }))).rejects.toThrow();
        expect(await store.listAllActiveLeases()).toEqual([]);
      });

      it("transitionWakeupAndReleaseLease releases the row's lease with the CAS, and nothing when the CAS loses", async () => {
        await store.createWakeupWithLease(wakeup(), lease());
        const lost = await store.transitionWakeupAndReleaseLease("wk_a", ["pending"], "cancelled", { cause: "cancelled" }, 40, "cancelled");
        expect(lost).toBeNull();
        expect(await store.countActiveLeases("sess-1")).toBe(1);

        const moved = await store.transitionWakeupAndReleaseLease("wk_a", ["running"], "done", { cause: "exit", exitCode: 0, endedAt: 50 }, 50, "owner_ended");
        expect(moved).toMatchObject({ status: "done", cause: "exit", exitCode: 0 });
        expect(await store.countActiveLeases("sess-1")).toBe(0);
        // The release used the CAS time and cause; a second release finds nothing.
        expect(await store.releaseLease("ls_a", "deadline", 60)).toBeNull();
        expect(await store.transitionWakeupAndReleaseLease("wk_a", ["running"], "expired", {}, 70, "deadline")).toBeNull();
      });

      it("lists a pending process or watch as due, for crash recovery", async () => {
        await store.createWakeup(wakeup({ id: "wk_p", status: "pending" }));
        await store.createWakeup(wakeup({ id: "wk_w", kind: "watch", status: "pending" }));
        await store.createWakeup(wakeup({ id: "wk_t", kind: "timer", status: "running", prompt: "p", fireAt: 1, command: undefined, execId: undefined, leaseId: undefined }));
        expect((await store.listDueWakeups(10, 10)).map((w) => w.id).sort()).toEqual(["wk_p", "wk_w"]);
      });

      it("counts wakeups by kind and status over the given statuses", async () => {
        await store.createWakeup(wakeup({ id: "wk_1" }));
        await store.createWakeup(wakeup({ id: "wk_2" }));
        await store.createWakeup(wakeup({ id: "wk_3", kind: "timer", status: "pending", prompt: "p", fireAt: 10_000_000, command: undefined, execId: undefined, leaseId: undefined }));
        await store.createWakeup(wakeup({ id: "wk_4", status: "done" }));
        const counts = await store.countWakeupsByKindAndStatus(["pending", "running"]);
        const sorted = [...counts].sort((a, b) => a.kind.localeCompare(b.kind));
        expect(sorted).toEqual([
          { kind: "process", status: "running", count: 2 },
          { kind: "timer", status: "pending", count: 1 },
        ]);
      });

      it("listWakeups with an empty status list returns every row of the session (L8)", async () => {
        await store.createWakeup(wakeup());
        await store.createWakeup(wakeup({ id: "wk_d", status: "done" }));
        expect((await store.listWakeups("sess-1", [])).map((w) => w.id).sort()).toEqual(["wk_a", "wk_d"]);
      });

      // ── fix wave 3 (M1: coalesced watch emits) ──

      it("round-trips the watch buffer and last emit time, and a patch can empty the buffer", async () => {
        const w = wakeup({ kind: "watch", watchBuffer: "held ✓\n", lastEmitAt: 42 });
        await store.createWakeup(w);
        expect(await store.getWakeup("wk_a")).toEqual(w);
        const emptied = await store.transitionWakeup("wk_a", ["running"], "running", { watchBuffer: "", lastEmitAt: 90 }, 90);
        expect(emptied).toMatchObject({ watchBuffer: "", lastEmitAt: 90 });
        expect(await store.getWakeup("wk_a")).toMatchObject({ watchBuffer: "", lastEmitAt: 90 });
      });
    });

    it("getQueueItemByDispatchId finds an admitted item by its exact dispatch id", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      await store.admitSubmission("sess-1", "th-1", { ...queueItem("q-1", 100, 100), dispatchId: "wakeup:wk_a:terminal" });
      expect((await store.getQueueItemByDispatchId("sess-1", "wakeup:wk_a:terminal"))?.id).toBe("q-1");
      expect(await store.getQueueItemByDispatchId("sess-1", "wakeup:wk_b:terminal")).toBeNull();
      expect(await store.getQueueItemByDispatchId("sess-2", "wakeup:wk_a:terminal")).toBeNull();
    });

    it("latestActivityAt: null when empty, tracks the max queue-item updatedAt through admit + settle", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));

      // No queue items yet → null.
      expect(await store.latestActivityAt("sess-1")).toBeNull();

      await store.admitSubmission("sess-1", "th-1", queueItem("q-1", 100, 100));
      expect(await store.latestActivityAt("sess-1")).toBe(100);

      // A newer item's updatedAt wins.
      await store.admitSubmission("sess-1", "th-1", queueItem("q-2", 150, 250));
      expect(await store.latestActivityAt("sess-1")).toBe(250);

      // Settling an item stamps updatedAt = now, so latestActivityAt advances.
      const before = Date.now();
      await store.forceSettle("sess-1", "q-1", "failed");
      const after = await store.latestActivityAt("sess-1");
      expect(after).not.toBeNull();
      expect(after as number).toBeGreaterThanOrEqual(before);
    });

    it("deleteSession removes the session", async () => {
      await store.saveSession(newSession());
      await store.deleteSession("sess-1");
      expect(await store.getSession("sess-1")).toBeNull();
    });

    // ── Engine traces substrate (usage/cost, start-ref, settle patch) ──

    it("entry usage + cost round-trip; usage-only and neither stay absent", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const usage = { input: 120, output: 45, cacheRead: 800, cacheWrite: 12, total: 977 };
      const cost = { input: 0.0012, output: 0.0034, cacheRead: 0.0002, cacheWrite: 0.0001, total: 0.0049 };
      await store.appendEntries("sess-1", "th-1", [
        { ...msg("e-both", "assistant", "a", 10), usage, cost },
        { ...msg("e-usage", "assistant", "b", 20), usage },
        msg("e-neither", "assistant", "c", 30),
      ]);
      const loaded = await store.getEntries("sess-1", "th-1");
      const byId = new Map(loaded.map((e) => [e.id, e]));
      const both = byId.get("e-both");
      if (both?.type !== "message") throw new Error("unreachable");
      expect(both.usage).toEqual(usage);
      expect(both.cost).toEqual(cost);
      const usageOnly = byId.get("e-usage");
      if (usageOnly?.type !== "message") throw new Error("unreachable");
      expect(usageOnly.usage).toEqual(usage);
      expect(usageOnly.cost).toBeUndefined();
      const neither = byId.get("e-neither");
      if (neither?.type !== "message") throw new Error("unreachable");
      expect(neither.usage).toBeUndefined();
      expect(neither.cost).toBeUndefined();
    });

    it("updateEntry lands usage/cost on an already-appended entry (turn_end write path)", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      const entry = msg("e-1", "assistant", "done", 10);
      await store.appendEntries("sess-1", "th-1", [entry]);
      const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 };
      await store.updateEntry("sess-1", "th-1", { ...entry, usage });
      const [loaded] = await store.getEntries("sess-1", "th-1");
      if (loaded.type !== "message") throw new Error("unreachable");
      expect(loaded.usage).toEqual(usage);
      expect(loaded.cost).toBeUndefined();
    });

    it("session startRef round-trips verbatim; absent stays absent", async () => {
      const startRef = {
        repoUrl: "https://github.com/tkhq/valet.git",
        branch: "dev-v2",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        capturedAt: 1_700_000_000_000,
      };
      await store.saveSession(newSession({ id: "with-ref", startRef }));
      await store.saveSession(newSession({ id: "without-ref" }));
      expect((await store.getSession("with-ref"))?.startRef).toEqual(startRef);
      expect((await store.getSession("without-ref"))?.startRef).toBeUndefined();
    });

    it("finalizeSettlement(patchRef) lands the settle-patch record on the item", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      await store.admitSubmission("sess-1", "th-1", queueItem("q-1", 100, 100));
      const claimed = await store.claimSubmission({
        sessionId: "sess-1",
        threadId: "th-1",
        itemId: "q-1",
        attemptId: "att-1",
        ownerId: "own-1",
      });
      expect(claimed).not.toBeNull();
      const fence = { itemId: "q-1", attemptId: "att-1" };
      await store.reserveSettlement("sess-1", "th-1", "q-1", { outcome: "completed" }, fence);
      await store.finalizeSettlement("sess-1", "th-1", "q-1", fence, {
        status: "captured",
        blobKey: "patches/sess-1/q-1.diff",
        bytes: 512,
        truncated: false,
      });
      const item = await store.getQueueItem("sess-1", "q-1");
      expect(item?.status).toBe("settled");
      expect(item?.settlePatch).toMatchObject({
        status: "captured",
        blobKey: "patches/sess-1/q-1.diff",
        bytes: 512,
      });
    });

    it("finalizeSettlement without patchRef leaves settlePatch absent (back-compat)", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      await store.admitSubmission("sess-1", "th-1", queueItem("q-1", 100, 100));
      await store.claimSubmission({
        sessionId: "sess-1",
        threadId: "th-1",
        itemId: "q-1",
        attemptId: "att-1",
        ownerId: "own-1",
      });
      const fence = { itemId: "q-1", attemptId: "att-1" };
      await store.reserveSettlement("sess-1", "th-1", "q-1", { outcome: "completed" }, fence);
      await store.finalizeSettlement("sess-1", "th-1", "q-1", fence);
      const item = await store.getQueueItem("sess-1", "q-1");
      expect(item?.status).toBe("settled");
      expect(item?.settlePatch).toBeUndefined();
    });

    it("settleUnclaimed stamps the settle-patch skip 'no_work'", async () => {
      await store.saveSession(newSession());
      await store.saveThread("sess-1", newThread("sess-1"));
      await store.admitSubmission("sess-1", "th-1", queueItem("q-1", 100, 100));
      const ok = await store.settleUnclaimed("sess-1", "th-1", "q-1", { outcome: "aborted" });
      expect(ok).toBe(true);
      const item = await store.getQueueItem("sess-1", "q-1");
      expect(item?.settlePatch).toMatchObject({ status: "skipped", reason: "no_work" });
    });
  });
}
