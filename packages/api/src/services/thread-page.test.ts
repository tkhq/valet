import { expect, it } from "vitest";
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
