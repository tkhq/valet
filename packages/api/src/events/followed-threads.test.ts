import { beforeEach, describe, expect, it } from "vitest";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { findFollowedThread, touchFollowedThread, upsertFollowedThread } from "./followed-threads.js";

const ORG = "org-1";
const KEY = { orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.2" };

describe("followed_threads store", () => {
  let tdb: TestPgDb;
  beforeEach(async () => {
    tdb = await freshTestPgDb();
  });

  it("upsert then find returns the bound owner", async () => {
    await upsertFollowedThread(tdb.appDb, { ...KEY, ownerType: "team", ownerId: "team-x", createdBy: "u1" });
    const row = await findFollowedThread(tdb.appDb, KEY);
    expect(row?.ownerType).toBe("team");
    expect(row?.ownerId).toBe("team-x");
  });

  it("a second upsert on the same key updates, not duplicates", async () => {
    await upsertFollowedThread(tdb.appDb, { ...KEY, ownerType: "team", ownerId: "team-x", createdBy: "u1" });
    await upsertFollowedThread(tdb.appDb, { ...KEY, ownerType: "user", ownerId: "user-y", createdBy: "u2" });
    const row = await findFollowedThread(tdb.appDb, KEY);
    expect(row?.ownerType).toBe("user");
    expect(row?.ownerId).toBe("user-y");
  });

  it("find returns null for an unfollowed thread", async () => {
    expect(await findFollowedThread(tdb.appDb, KEY)).toBeNull();
  });

  it("touch bumps last_activity_at", async () => {
    await upsertFollowedThread(tdb.appDb, { ...KEY, ownerType: "team", ownerId: "team-x", createdBy: "u1" });
    const before = await findFollowedThread(tdb.appDb, KEY);
    await new Promise((r) => setTimeout(r, 5));
    await touchFollowedThread(tdb.appDb, before!.id);
    const after = await findFollowedThread(tdb.appDb, KEY);
    expect(after!.lastActivityAt).toBeGreaterThanOrEqual(before!.lastActivityAt);
  });
});
