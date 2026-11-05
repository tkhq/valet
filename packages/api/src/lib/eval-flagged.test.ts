import { describe, expect, it } from "vitest";
import { PgSessionStore } from "@valet/store-postgres";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { ratings } from "../schema/index.js";
import { readFlaggedSessions } from "./eval-flagged.js";

describe("readFlaggedSessions", () => {
  it("harvests the thread a message rating names, not every thread in the runtime (TKAI-358)", async () => {
    const { pgdb, appDb } = await freshTestPgDb();
    const engineStore = new PgSessionStore(pgdb);
    const sessionId = "assistant:asst_flagged";
    await engineStore.saveSession({
      id: sessionId, userId: "u1", orgId: "o1", workspace: "/", owner: { type: "user", id: "u1" },
      purpose: "orchestrator", status: "running", createdAt: 1, updatedAt: 1,
    });
    for (const threadId of ["th-rated", "th-negative", "th-unrated"]) {
      await engineStore.saveThread(sessionId, { id: threadId, sessionId, key: `web:${threadId}`, status: "active", queueMode: "followup", createdAt: 1, updatedAt: 1 });
      await engineStore.appendEntries(sessionId, threadId, [{
        id: `${threadId}-msg`, sessionId, threadId, parentId: null, type: "message", role: "assistant",
        content: `reply in ${threadId}`, createdAt: 2,
      }]);
    }
    // The thread UI rates messages, tagged with their thread. A workspace
    // runtime holds every conversation, so a whole-session pull would
    // harvest threads nobody endorsed.
    await appDb.insert(ratings).values([
      { id: "r1", userId: "u1", targetType: "entry", targetId: "th-rated-msg", sessionId, threadId: "th-rated", rating: "positive", createdAt: 3, updatedAt: 3 },
      { id: "r2", userId: "u1", targetType: "entry", targetId: "th-negative-msg", sessionId, threadId: "th-negative", rating: "negative", createdAt: 3, updatedAt: 3 },
    ]);

    const flagged = await readFlaggedSessions({ appDb, engineStore, close: async () => {} }, { rating: "positive" });
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ sessionId, rating: "positive", ratedAt: 3, userId: "u1" });
    expect(flagged[0]?.threads.map((t) => t.threadId)).toEqual(["th-rated"]);

    // A session-level rating from an older client still covers every thread.
    await appDb.insert(ratings).values({ id: "r3", userId: "u1", targetType: "session", targetId: sessionId, sessionId, threadId: null, rating: "positive", createdAt: 4, updatedAt: 4 });
    const whole = await readFlaggedSessions({ appDb, engineStore, close: async () => {} }, { rating: "positive" });
    expect(whole[0]?.threads.map((t) => t.threadId).sort()).toEqual(["th-negative", "th-rated", "th-unrated"]);
  });
});
