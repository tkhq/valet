/**
 * Exercises the real table, not the in-memory stand-in: the migration, the
 * composite primary key, and the two list queries the sweeps depend on.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { DbActiveStreamStore, type ActiveStreamRecord } from "./active-streams.js";

const BASE: ActiveStreamRecord = {
  channelType: "slack",
  conversationKey: "slack:T1:D1",
  messageId: "1700000000.000200",
  threadTs: "1700000000.000100",
  sessionId: "orchestrator:user:u1",
  threadId: "t1",
  engineMessageId: "e1",
  orgId: "org1",
  startedAt: 1_700_000_000_000,
};

describe("DbActiveStreamStore", () => {
  let testDb: TestPgDb;
  let store: DbActiveStreamStore;

  beforeEach(async () => {
    testDb = await freshTestPgDb();
    store = new DbActiveStreamStore(testDb.appDb);
  });

  it("round-trips a record and deletes it by its key", async () => {
    await store.insert(BASE);

    const rows = await store.listForChannel("slack");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(BASE);

    await store.delete({
      channelType: BASE.channelType,
      conversationKey: BASE.conversationKey,
      messageId: BASE.messageId,
    });
    expect(await store.listForChannel("slack")).toHaveLength(0);
  });

  it("treats a repeated insert as the same stream, not a second one", async () => {
    await store.insert(BASE);
    await store.insert({ ...BASE, engineMessageId: "e2" });

    const rows = await store.listForChannel("slack");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.engineMessageId).toBe("e2");
  });

  it("keeps separate rows for separate messages in one conversation", async () => {
    await store.insert(BASE);
    await store.insert({ ...BASE, messageId: "1700000000.000300", startedAt: BASE.startedAt + 10 });

    expect(await store.listForChannel("slack")).toHaveLength(2);
  });

  it("lists only rows older than the cutoff, oldest first", async () => {
    await store.insert({ ...BASE, messageId: "old", startedAt: 1_000 });
    await store.insert({ ...BASE, messageId: "older", startedAt: 500 });
    await store.insert({ ...BASE, messageId: "new", startedAt: 9_000 });

    const stale = await store.listStale("slack", 5_000);

    expect(stale.map((r) => r.messageId)).toEqual(["older", "old"]);
  });

  it("does not return another transport's rows", async () => {
    await store.insert(BASE);
    await store.insert({ ...BASE, channelType: "telegram" });

    expect(await store.listForChannel("slack")).toHaveLength(1);
    expect(await store.listStale("slack", Number.MAX_SAFE_INTEGER)).toHaveLength(1);
  });

  it("stores a record with no engine message id", async () => {
    const { engineMessageId: _omitted, ...withoutEngineId } = BASE;
    await store.insert(withoutEngineId);

    const rows = await store.listForChannel("slack");
    expect(rows[0]?.engineMessageId).toBeUndefined();
  });
});
