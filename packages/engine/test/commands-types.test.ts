import { describe, expect, it, beforeEach } from "vitest";
import type { CommandResultEntry, SessionData, ThreadData } from "../src/types.js";
import { InMemorySessionStore } from "../src/providers/in-memory/store.js";

describe("command_result entry", () => {
  let store: InMemorySessionStore;

  beforeEach(() => {
    store = new InMemorySessionStore();
  });

  function newSession(id = "s1"): SessionData {
    return {
      id,
      owner: { type: "user", id: "u1" },
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      purpose: "interactive",
      status: "running",
      createdAt: 1,
      updatedAt: 1,
    };
  }

  function newThread(sessionId: string, id = "t1"): ThreadData {
    return {
      id,
      sessionId,
      key: "web:default",
      status: "active",
      queueMode: "followup",
      createdAt: 1,
      updatedAt: 1,
    };
  }

  it("round-trips through the in-memory store", async () => {
    await store.saveSession(newSession("s1"));
    await store.saveThread("s1", newThread("s1", "t1"));

    const entry: CommandResultEntry = {
      id: "e1",
      sessionId: "s1",
      threadId: "t1",
      parentId: null,
      createdAt: 1,
      type: "command_result",
      command: "/status",
      source: "builtin",
      ok: true,
      output: "**idle**",
    };

    await store.appendEntries("s1", "t1", [entry]);
    const read = await store.getEntries("s1", "t1");
    const got = read.find((e) => e.type === "command_result");
    expect(got?.type).toBe("command_result");
    expect(got && got.type === "command_result" ? got.output : "").toBe("**idle**");
  });
});
