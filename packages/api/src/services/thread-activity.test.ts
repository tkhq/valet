import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { sessionThreads } from "../schema/index.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { recordThreadActivityBestEffort, recordThreadUserActivity } from "./thread-activity.js";

describe("recordThreadUserActivity", () => {
  it("does not move activity backward when an older write lands last", async () => {
    const testDb = await freshTestPgDb();
    const emit = vi.fn(async () => undefined);
    const base = {
      sessionId: "session-1",
      threadId: "thread-1",
      threadCreatedAt: 10,
      emit,
    };

    await recordThreadUserActivity(testDb.appDb, { ...base, activityAt: 30 });
    await recordThreadUserActivity(testDb.appDb, { ...base, activityAt: 20 });

    const rows = await testDb.appDb
      .select({ lastUserActivityAt: sessionThreads.lastUserActivityAt })
      .from(sessionThreads)
      .where(eq(sessionThreads.id, base.threadId));
    expect(rows[0]?.lastUserActivityAt).toBe(30);
    expect(emit).toHaveBeenLastCalledWith({
      type: "thread_user_activity",
      threadId: base.threadId,
      activityAt: 30,
    });
  });

  it("does not fail an accepted prompt when activity recording fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error("database unavailable");

    await expect(recordThreadActivityBestEffort(async () => { throw failure; })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("Thread activity recording failed after prompt acceptance:", failure);
    log.mockRestore();
  });
});
