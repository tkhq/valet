import { describe, it, expect, beforeEach } from "vitest";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { orgs } from "../schema/index.js";
import {
  REASONING_LEVELS, compareReasoning, clampToMax,
  getOrgReasoningSettings, setOrgReasoningSettings, assertReasoningSelectable,
} from "./reasoning.js";

const orgId = "org-reasoning";

describe("reasoning", () => {
  let db: AppDb;
  beforeEach(async () => {
    const { appDb } = await freshTestPgDb();
    db = appDb;
    await db.insert(orgs).values({ id: orgId, name: "Org", createdAt: Date.now() });
  });

  it("orders levels minimal < low < medium < high < xhigh < max", () => {
    expect(compareReasoning("minimal", "max")).toBeLessThan(0);
    expect(compareReasoning("high", "low")).toBeGreaterThan(0);
    expect(compareReasoning("medium", "medium")).toBe(0);
  });

  it("clamps to max", () => {
    expect(clampToMax("max", "medium")).toBe("medium");
    expect(clampToMax("low", "medium")).toBe("low");
    expect(clampToMax("high", undefined)).toBe("high");
  });

  it("returns {} when no settings stored", async () => {
    expect(await getOrgReasoningSettings(db, orgId)).toEqual({});
  });

  it("round-trips settings", async () => {
    await setOrgReasoningSettings(db, orgId, { default: "medium", max: "high" });
    expect(await getOrgReasoningSettings(db, orgId)).toEqual({ default: "medium", max: "high" });
  });

  it("rejects unknown level tokens", async () => {
    const err = await assertReasoningSelectable(db, orgId, "ultra");
    expect(err).toMatch(/Unknown reasoning level/);
  });

  it("rejects levels above the org max, for everyone", async () => {
    await setOrgReasoningSettings(db, orgId, { max: "medium" });
    expect(await assertReasoningSelectable(db, orgId, "xhigh")).toMatch(/exceeds the org max/);
    expect(await assertReasoningSelectable(db, orgId, "medium")).toBeNull();
  });

  it("accepts any known level when no cap is set", async () => {
    expect(await assertReasoningSelectable(db, orgId, "max")).toBeNull();
  });
});
