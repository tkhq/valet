import { afterEach, expect, it, vi } from "vitest";
import { runThreads } from "./threads.js";
import { parseGlobalFlags } from "../output.js";
import type { ThreadDetail } from "../client.js";

afterEach(() => vi.restoreAllMocks());

function fakeClient(thread: Partial<ThreadDetail> = {}, stopped = true) {
  const aborted: Array<[string, string]> = [];
  const create = vi.fn(async () => ({ id: "thread-1", sessionId: "runtime-1", createdAt: 1, lastUserActivityAt: 1 }));
  return {
    aborted,
    create,
    client: {
      createWorkspaceThread: create,
      listWorkspaceThreads: async () => ({ threads: [] }),
      getThread: async () => ({ id: "thread-1", sessionId: "runtime-1", title: null, createdAt: 1, archivedAt: null, ...thread }),
      abortThread: async (id: string, target: string) => { aborted.push([id, target]); return { stopped }; },
    },
  };
}

it("creates a thread in the selected workspace without creating a standalone runtime", async () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const { client, create } = fakeClient();
  const code = await runThreads(client, parseGlobalFlags(["new", "--workspace", "team-1", "--title", "Release"]));
  expect(code).toBe(0);
  expect(create).toHaveBeenCalledWith({ title: "Release" }, "team-1");
});

it("stops the turn the server reports as active, by its id", async () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const { client, aborted } = fakeClient({ activeItemId: "q-live" });
  expect(await runThreads(client, parseGlobalFlags(["stop", "thread-1"]))).toBe(0);
  expect(aborted).toEqual([["thread-1", "q-live"]]);
});

// The turn can finish between the read and the abort. A script must not see a false success.
it("reports nothing stopped when the target finished before the abort", async () => {
  const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const { client } = fakeClient({ activeItemId: "q-done" }, false);
  expect(await runThreads(client, parseGlobalFlags(["stop", "thread-1", "--json"]))).toBe(0);
  expect(JSON.parse(out.mock.calls.map((c) => String(c[0])).join(""))).toEqual({ thread_id: "thread-1", stopped: false, message_id: "q-done" });
});

it("stops nothing when the thread has no running turn", async () => {
  const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const { client, aborted } = fakeClient();
  expect(await runThreads(client, parseGlobalFlags(["stop", "thread-1"]))).toBe(0);
  expect(aborted).toEqual([]);
  expect(out.mock.calls.map((c) => String(c[0])).join("")).toContain("nothing to stop");
});
