import { describe, expect, it } from "vitest";
import { threadPage } from "./thread-page.js";
import type { ThreadSummary } from "../wire/types.js";
const threads: ThreadSummary[] = Array.from({ length: 25 }, (_, i) => ({ id: `t${String(i).padStart(2, "0")}`, sessionId: "workspace", key: i % 2 ? "slack:c" : "web:x", createdAt: 100 - i, lastUserActivityAt: 100 - i }));
it("pages ten recents with a stable cursor and no missing tied rows", () => {
  const tied = threads.map(t => ({ ...t, createdAt: 1, lastUserActivityAt: 1 }));
  const first = threadPage(tied, new URLSearchParams("limit=10"));
  const second = threadPage(tied, new URLSearchParams({ limit: "10", cursor: first.nextCursor! }));
  const third = threadPage(tied, new URLSearchParams({ limit: "10", cursor: second.nextCursor! }));
  expect(first.threads).toHaveLength(10);
  expect(new Set([...first.threads, ...second.threads, ...third.threads].map(t => t.id)).size).toBe(25);
  expect(third.nextCursor).toBeUndefined();
});
it("keeps fixed and selected older rows outside the ten recent slots", () => {
  const page = threadPage(threads, new URLSearchParams("limit=10&fixedId=t24&threadId=t23&fixedId=foreign"));
  expect(page.threads.map(t => t.id)).toEqual([...threads.slice(0, 10).map(t => t.id), "t23", "t24"]);
  expect(page.originCounts).toEqual({ all: 25, chat: 13, channel: 12, auto: 0, other: 0 });
});
it("filters and sorts the entire authorized list before paging", () => {
  const page = threadPage(threads.map(t => ({ ...t, lastUserActivityAt: -t.createdAt })), new URLSearchParams("limit=10&origin=channel"));
  expect(page.threads.filter(t => t.key === "slack:c").map(t => t.id)).toEqual(["t23", "t21", "t19", "t17", "t15", "t13", "t11", "t09", "t07", "t05"]);
  expect(threadPage(threads, new URLSearchParams("limit=10&sort=created")).threads[0]?.id).toBe("t00");
});
it("rejects invalid limits and cursors and preserves unpaged compatibility", () => {
  for (const query of ["limit=0", "limit=101", "limit=wat", "limit=10&cursor=invalid", "limit=10&origin=wrong"]) {
    expect(() => threadPage(threads, new URLSearchParams(query))).toThrow();
  }
  expect(threadPage(threads, new URLSearchParams())).toEqual({ threads });
});

it("keeps a selected helper thread available to the main view", () => {
  const helper = { ...threads[0]!, id: "helper", key: "app-assistant:private" };
  expect(threadPage([...threads, helper], new URLSearchParams("limit=10&threadId=helper")).threads).toContainEqual(helper);
});

it("retains gated rows outside an origin filter without consuming page slots", () => {
  const page = threadPage(threads, new URLSearchParams("limit=10&origin=chat&fixedId=t23"));
  expect(page.threads.some(t => t.id === "t23")).toBe(true);
  expect(page.threads.filter(t => t.key === "web:x")).toHaveLength(10);
});

it("returns only authorized fixed rows without applying the origin filter", () => {
  const page = threadPage(threads, new URLSearchParams("fixedOnly=1&fixedId=t23&fixedId=foreign&origin=chat"));
  expect(page.threads.map(t => t.id)).toEqual(["t23"]);
  expect(page.nextCursor).toBeUndefined();
  expect(() => threadPage(threads, new URLSearchParams(Array.from({ length: 51 }, (_, i): [string, string] => ["fixedId", `id-${i}`])))).toThrow(/at most 50/);
});

describe("line groups", () => {
  const working = Array.from({ length: 3 }, (_, i) => ({ id: `w${i}`, sessionId: "workspace", key: `web:${i}`, createdAt: 10 - i, lastUserActivityAt: 10 - i }));
  const alerts = Array.from({ length: 12 }, (_, i) => ({ id: `a${String(i).padStart(2, "0")}`, sessionId: "workspace", key: `sub:r1:slack:C1:${i}`, createdAt: 100 - i, lastUserActivityAt: 100 - i }));
  const digest = { id: "d0", sessionId: "workspace", key: "schedule:s1:1700000000000", createdAt: 50, lastUserActivityAt: 50 };
  const own = { id: "own", sessionId: "workspace", key: "sub:r2", createdAt: 60, lastUserActivityAt: 60 };
  const all: ThreadSummary[] = [...alerts, digest, own, ...working];

  it("takes grouped threads out of the page and ships each group's newest ten", () => {
    const page = threadPage(all, new URLSearchParams("limit=10&groups=lines"));
    expect(page.lineGroups).toEqual([
      { key: "sub:r1", kind: "subscription", ruleId: "r1", name: "", threadCount: 12 },
      { key: "schedule:s1", kind: "schedule", ruleId: "s1", name: "", threadCount: 1 },
    ]);
    const ids = page.threads.map(t => t.id);
    expect(ids.filter(id => id.startsWith("w") || id === "own")).toEqual(["own", "w0", "w1", "w2"]);
    expect(ids.filter(id => id.startsWith("a"))).toEqual(alerts.slice(0, 10).map(t => t.id));
    expect(ids).toContain("d0");
    expect(page.nextCursor).toBeUndefined();
  });

  it("ships groups only on the first page", () => {
    const first = threadPage(all, new URLSearchParams("limit=2&groups=lines"));
    const second = threadPage(all, new URLSearchParams({ limit: "2", groups: "lines", cursor: first.nextCursor! }));
    expect(second.lineGroups).toBeUndefined();
    expect(second.threads.map(t => t.id).slice(0, 2)).toEqual(["w1", "w2"]);
  });

  it("pages one group with a cursor", () => {
    const first = threadPage(all, new URLSearchParams("limit=10&line=sub:r1"));
    const second = threadPage(all, new URLSearchParams({ limit: "10", line: "sub:r1", cursor: first.nextCursor! }));
    expect(first.threads.map(t => t.id)).toEqual(alerts.slice(0, 10).map(t => t.id));
    expect(second.threads.map(t => t.id)).toEqual(["a10", "a11"]);
    expect(second.nextCursor).toBeUndefined();
    expect(() => threadPage(all, new URLSearchParams("limit=10&line=web:x"))).toThrow();
  });

  it("keeps today's list when groups are not asked for", () => {
    expect(threadPage(all, new URLSearchParams("limit=10")).threads.map(t => t.id)).toEqual(alerts.slice(0, 10).map(t => t.id));
  });

  it("opens an ungrouped thread by default, and a grouped one when nothing else exists", () => {
    expect(threadPage(all, new URLSearchParams("limit=10&groups=lines")).defaultThreadId).toBe("own");
    expect(threadPage(alerts, new URLSearchParams("limit=10&groups=lines")).defaultThreadId).toBe("a00");
  });

  it("counts line threads as automations", () => {
    expect(threadPage(all, new URLSearchParams("limit=10")).originCounts).toEqual({ all: 17, chat: 3, auto: 14, channel: 0, other: 0 });
  });
});
