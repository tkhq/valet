import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { memoryFiles } from "../schema/index.js";
import { journalCompactionHook } from "./compaction.js";

let api: TestApi;
afterEach(async () => { await api?.cleanup(); });

describe("journal compaction audience", () => {
  it("keeps team thread summaries out of shared memory", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    const before = await db.select().from(memoryFiles);
    const hook = journalCompactionHook(db, {
      owner: { type: "team", id: "team-private-compaction" }, actorUserId: "local-user",
    });
    for (const mode of ["manual", "proactive", "reactive"] as const) {
      await hook({ sessionId: "team-runtime", threadId: "private-thread", mode, summary: "Private acquisition plan" });
    }
    expect(await db.select().from(memoryFiles)).toEqual(before);
  });

  it("retains personal journal summaries", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    const hook = journalCompactionHook(db, {
      owner: { type: "user", id: "local-user" }, actorUserId: "local-user",
    });
    await hook({ sessionId: "personal-runtime", threadId: "personal-thread", mode: "manual", summary: "Personal plan" });
    const rows = await db.select().from(memoryFiles);
    expect(rows.some((row) => row.ownerType === "user" && row.ownerId === "local-user" && row.content.includes("Personal plan"))).toBe(true);
  });
});
