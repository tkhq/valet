import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { agentSessions } from "../schema/index.js";
import { buildHibernationHooks, writeHibernated } from "./hibernation-hooks.js";

const SUSPENDED_AT = 1_700_000_000_000;

describe("hibernation hooks: sandbox suspend clock", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(agentSessions).values({
      id: "s1",
      userId: "u1",
      orgId: "org1",
      workspace: "/ws/s1",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    });
  });

  async function row() {
    const [r] = await db.select().from(agentSessions).where(eq(agentSessions.id, "s1"));
    return r;
  }

  it("the first hibernate stamps the clock", async () => {
    const before = Date.now();
    await writeHibernated(db, "s1", "sbx-1");
    const r = await row();
    expect(r?.status).toBe("hibernated");
    expect(r?.sandboxSuspendedAt).toBeGreaterThanOrEqual(before);
  });

  it("a prompt that never wakes the sandbox keeps the clock through the next hibernate", async () => {
    await db.update(agentSessions).set({ status: "hibernated", sandboxSuspendedAt: SUSPENDED_AT });
    const hooks = buildHibernationHooks(db);

    // `markSessionUsed` on a prompt fires onWake, then the idle sweep finds
    // the sandbox still suspended and stamps the row again.
    await hooks.onWake?.("s1");
    expect((await row())?.status).toBe("active");
    await writeHibernated(db, "s1", "sbx-1");

    const r = await row();
    expect(r?.status).toBe("hibernated");
    expect(r?.sandboxSuspendedAt).toBe(SUSPENDED_AT);
  });

  it("a ready sandbox clears the clock even after a prompt flipped the row to active", async () => {
    await db.update(agentSessions).set({ status: "active", sandboxSuspendedAt: SUSPENDED_AT });
    const hooks = buildHibernationHooks(db);

    await hooks.onSessionReady?.("s1");

    expect((await row())?.sandboxSuspendedAt).toBeNull();
  });
});
