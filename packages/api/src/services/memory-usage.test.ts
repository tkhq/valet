/**
 * Memory usage: which files agents read, which the snapshot injects, and
 * which principles a turn cites. Hits buffer in process and reach the
 * database in one batched upsert, so a read never waits on a usage write.
 */
import { describe, it, expect, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { memoryFileUsage } from "../schema/index.js";
import { moveFile, removeFile, writeFile, type MemoryScope } from "./memory.js";
import { MemoryUsageRecorder, readMemoryUsage, type MemoryFileKey } from "./memory-usage.js";

let api: TestApi;

afterEach(async () => {
  await api?.cleanup();
});

const scope: MemoryScope = { owner: { type: "user", id: "local-user" }, actorUserId: "local-user" };

function key(path: string): MemoryFileKey {
  return { ownerType: "user", ownerId: "local-user", namespace: "", path };
}

async function usageRow(path: string) {
  const rows = await api.providers.db
    .select()
    .from(memoryFileUsage)
    .where(and(eq(memoryFileUsage.ownerType, "user"), eq(memoryFileUsage.ownerId, "local-user"), eq(memoryFileUsage.path, path)));
  return rows[0];
}

describe("MemoryUsageRecorder", () => {
  it("buffers hits and writes them in one flush", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    await writeFile(db, scope, { path: "notes/a.md", content: "# A\n" });
    const recorder = new MemoryUsageRecorder(db, { flushIntervalMs: 0 });

    recorder.record(key("notes/a.md"), "read", 1_000);
    recorder.record(key("notes/a.md"), "read", 3_000);
    recorder.record(key("notes/a.md"), "read", 2_000);
    recorder.record(key("notes/a.md"), "inject", 500);

    expect(await usageRow("notes/a.md")).toBeUndefined();
    await recorder.flush();

    expect(await usageRow("notes/a.md")).toMatchObject({
      readCount: 3,
      lastReadAt: 3_000,
      injectCount: 1,
      lastInjectedAt: 500,
      citeCount: 0,
      lastCitedAt: null,
    });
  });

  it("adds to stored counts and keeps the latest time", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    await writeFile(db, scope, { path: "principles/x.md", content: "# X\n" });
    const recorder = new MemoryUsageRecorder(db, { flushIntervalMs: 0 });

    recorder.record(key("principles/x.md"), "cite", 5_000);
    await recorder.flush();
    recorder.record(key("principles/x.md"), "cite", 4_000);
    recorder.record(key("principles/x.md"), "read", 6_000);
    await recorder.flush();

    expect(await usageRow("principles/x.md")).toMatchObject({ citeCount: 2, lastCitedAt: 5_000, readCount: 1, lastReadAt: 6_000 });
  });

  it("records nothing for a path with no memory file", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    const recorder = new MemoryUsageRecorder(db, { flushIntervalMs: 0 });

    recorder.record(key("notes/gone.md"), "read", 1_000);
    await recorder.flush();

    expect(await usageRow("notes/gone.md")).toBeUndefined();
  });

  it("drops hits when the buffer is full and a flush is running", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    for (const name of ["a", "b", "c"]) await writeFile(db, scope, { path: `notes/${name}.md`, content: `# ${name}\n` });
    const recorder = new MemoryUsageRecorder(db, { flushIntervalMs: 0, maxBufferedFiles: 1 });

    recorder.record(key("notes/a.md"), "read", 1_000);
    // The buffer is full, so this hit starts a flush of `a` and takes its place.
    recorder.record(key("notes/b.md"), "read", 1_000);
    // The buffer is full again and that flush is still running: dropped.
    recorder.record(key("notes/c.md"), "read", 1_000);
    expect(recorder.dropped).toBe(1);
    await recorder.flush();

    expect(await usageRow("notes/a.md")).toMatchObject({ readCount: 1 });
    expect(await usageRow("notes/b.md")).toMatchObject({ readCount: 1 });
    expect(await usageRow("notes/c.md")).toBeUndefined();
  });

  it("flushes on its own timer", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    await writeFile(db, scope, { path: "notes/a.md", content: "# A\n" });
    const recorder = new MemoryUsageRecorder(db, { flushIntervalMs: 20 });
    try {
      recorder.record(key("notes/a.md"), "read", 1_000);
      await expect.poll(async () => (await usageRow("notes/a.md"))?.readCount, { timeout: 2_000 }).toBe(1);
    } finally {
      await recorder.stop();
    }
  });
});

describe("usage lifecycle", () => {
  it("removing a file removes its usage, and moving a file moves it", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    await writeFile(db, scope, { path: "notes/a.md", content: "# A\n" });
    await writeFile(db, scope, { path: "notes/b.md", content: "# B\n" });
    const recorder = new MemoryUsageRecorder(db, { flushIntervalMs: 0 });
    recorder.record(key("notes/a.md"), "read", 1_000);
    recorder.record(key("notes/b.md"), "read", 2_000);
    await recorder.flush();

    await moveFile(db, scope, { from: "notes/a.md", to: "notes/moved.md" });
    await removeFile(db, scope, "notes/b.md");

    expect(await usageRow("notes/a.md")).toBeUndefined();
    expect(await usageRow("notes/moved.md")).toMatchObject({ readCount: 1, lastReadAt: 1_000 });
    expect(await usageRow("notes/b.md")).toBeUndefined();
  });
});

describe("readMemoryUsage", () => {
  it("returns usage by path for one owner scope", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    await writeFile(db, scope, { path: "notes/a.md", content: "# A\n" });
    await writeFile(db, scope, { path: "notes/never.md", content: "# Never\n" });
    const recorder = new MemoryUsageRecorder(db, { flushIntervalMs: 0 });
    recorder.record(key("notes/a.md"), "read", 1_000);
    await recorder.flush();

    const usage = await readMemoryUsage(db, scope);
    expect(usage.get("notes/a.md")).toMatchObject({ readCount: 1, lastReadAt: 1_000 });
    expect(usage.has("notes/never.md")).toBe(false);
  });
});
