import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { agentSessions, sessionThreads } from "../schema/index.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { recordSessionActivity, recordThreadActivityBestEffort, recordThreadUserActivity } from "./thread-activity.js";

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

  it("does not move session recency backward when an older write lands last", async () => {
    const testDb = await freshTestPgDb();
    await testDb.appDb.insert(agentSessions).values({
      id: "session-1",
      userId: "user-1",
      orgId: "org-1",
      ownerType: "user",
      ownerId: "user-1",
      workspace: "/workspace/project",
      createdAt: 10,
      updatedAt: 10,
      lastActivityAt: 10,
    });

    await recordSessionActivity(testDb.appDb, "session-1", 30);
    await recordSessionActivity(testDb.appDb, "session-1", 20);

    const rows = await testDb.appDb
      .select({ updatedAt: agentSessions.updatedAt, lastActivityAt: agentSessions.lastActivityAt })
      .from(agentSessions)
      .where(eq(agentSessions.id, "session-1"));
    expect(rows[0]).toMatchObject({ updatedAt: 30, lastActivityAt: 30 });
  });

  it("does not fail an accepted prompt when activity recording fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error("database unavailable");

    await expect(recordThreadActivityBestEffort(async () => { throw failure; })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("Thread activity recording failed after prompt acceptance:", failure);
    log.mockRestore();
  });
});
