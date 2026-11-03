import { describe, expect, it } from "vitest";
import {
  EXCERPT_CHARS, excerptOf, groupFrictionThreads, summarizeThreadCalls, threadPerson,
  type FrictionThread, type ThreadCallRow,
} from "./thread-outcomes.js";

function thread(overrides: Partial<FrictionThread> & Pick<FrictionThread, "threadId">): FrictionThread {
  return {
    sessionId: "s", link: `https://valet.test/threads/${overrides.threadId}`, outcome: "failed", classifiedAt: 1,
    workspace: "personal", person: { kind: "user", id: "alice", name: "Alice" }, child: false,
    intent: { key: "scheduling", label: "Scheduling" }, toolCalls: 0, toolErrors: 0, errorCodes: [], canOpen: false,
    ...overrides,
  };
}

describe("summarizeThreadCalls", () => {
  const call = (overrides: Partial<ThreadCallRow>): ThreadCallRow => ({
    sessionId: "s", threadId: "t", tool: "calendar.list_events", outcome: "ok", errorCode: null, intent: null, calls: 1, ...overrides,
  });

  it("counts calls and errors, and takes the intent with the most calls", () => {
    const summary = summarizeThreadCalls([
      call({ intent: "scheduling", calls: 3 }),
      call({ intent: "email", calls: 2, tool: "gmail.search" }),
      call({ outcome: "error", errorCode: "unknown", tool: "google_calendar.list_events", intent: "scheduling", calls: 2 }),
      call({ outcome: "error", errorCode: null, tool: "gmail.search", intent: "email", calls: 1 }),
    ], new Map([["scheduling", "Scheduling"]]));
    expect(summary.get("s:t")).toEqual({
      toolCalls: 8, toolErrors: 3, intent: { key: "scheduling", label: "Scheduling" },
      errorCodes: [{ tool: "google_calendar.list_events", code: "unknown", calls: 2 }, { tool: "gmail.search", code: "unspecified", calls: 1 }],
    });
  });

  it("breaks an intent tie by key, and names a thread whose calls carry no intent", () => {
    const summary = summarizeThreadCalls([
      call({ threadId: "tie", intent: "zeta" }), call({ threadId: "tie", intent: "alpha" }),
      call({ threadId: "bare" }),
    ], new Map());
    expect(summary.get("s:tie")?.intent).toEqual({ key: "alpha", label: "alpha" });
    expect(summary.get("s:bare")?.intent).toEqual({ key: "unlabeled", label: "Unlabeled tool calls" });
  });
});

describe("groupFrictionThreads", () => {
  it("groups by person and intent, largest first, with links in thread order", () => {
    const bob = { kind: "user" as const, id: "bob", name: "Bob" };
    const groups = groupFrictionThreads([
      thread({ threadId: "a1", toolErrors: 2 }),
      thread({ threadId: "b1", person: bob, outcome: "abandoned", toolErrors: 9 }),
      thread({ threadId: "a2", outcome: "abandoned" }),
      thread({ threadId: "a3", intent: { key: "email", label: "Email" } }),
    ]);
    expect(groups.map((group) => [group.person.id, group.intent.key, group.threads])).toEqual([
      ["alice", "scheduling", 2], ["bob", "scheduling", 1], ["alice", "email", 1],
    ]);
    expect(groups[0]).toMatchObject({
      outcomes: { failed: 1, abandoned: 1 }, toolErrors: 2,
      links: ["https://valet.test/threads/a1", "https://valet.test/threads/a2"],
    });
  });

  it("keeps five links per group", () => {
    const groups = groupFrictionThreads(Array.from({ length: 7 }, (_, index) => thread({ threadId: `t${index}` })));
    expect(groups[0]?.threads).toBe(7);
    expect(groups[0]?.links).toHaveLength(5);
  });
});

describe("threadPerson", () => {
  const names = new Map([["user:alice", "Alice"], ["team:team-1", "Platform"]]);

  it("names the member for a personal or prompted thread, and the team for an unattended team run", () => {
    expect(threadPerson({ userId: "alice", ownerType: "team", ownerId: "team-1" }, names)).toEqual({ kind: "user", id: "alice", name: "Alice" });
    expect(threadPerson({ userId: "team:team-1", ownerType: "team", ownerId: "team-1" }, names)).toEqual({ kind: "team", id: "team-1", name: "Platform" });
    expect(threadPerson({ userId: "carol", ownerType: "user", ownerId: "carol" }, names)).toEqual({ kind: "user", id: "carol", name: "carol" });
  });
});

describe("excerptOf", () => {
  it("collapses whitespace and caps the excerpt", () => {
    expect(excerptOf("  Book a\n\nmeeting  ")).toBe("Book a ⏎ meeting");
    const long = excerptOf("word ".repeat(200)) ?? "";
    expect(long).toHaveLength(EXCERPT_CHARS);
    expect(long.endsWith("…")).toBe(true);
    expect(excerptOf(" \n ")).toBeUndefined();
  });
});
