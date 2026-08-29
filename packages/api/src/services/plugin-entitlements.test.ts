import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ValidationError, type PluginEntitlement } from "@valet/shared";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { orgMembers, orgs, pluginStore, teamMembers, teams, users } from "../schema/index.js";
import {
  getPluginEntitlement,
  getPluginEntitlements,
  orgAllowsPluginForUser,
  setPluginEntitlement,
} from "./plugin-entitlements.js";

const ORG = "org_test";
const OTHER_ORG = "org_other";

async function seed(db: AppDb): Promise<void> {
  const now = Date.now();
  await db.insert(orgs).values([
    { id: ORG, name: "Test Org", createdAt: now },
    { id: OTHER_ORG, name: "Other Org", createdAt: now },
  ]);
  await db.insert(users).values([
    { id: "u_alice", email: "alice@dev", name: "Alice", role: "member" },
    { id: "u_bob", email: "bob@dev", name: "Bob", role: "member" },
    { id: "u_carol", email: "carol@dev", name: "Carol", role: "member" },
  ]);
  await db.insert(orgMembers).values([
    { orgId: ORG, userId: "u_alice", role: "member", createdAt: now },
    { orgId: ORG, userId: "u_bob", role: "member", createdAt: now },
    { orgId: ORG, userId: "u_carol", role: "member", createdAt: now },
  ]);
  // Two teams in ORG, one team in OTHER_ORG.
  await db.insert(teams).values([
    { id: "team_eng", orgId: ORG, name: "Engineering", origin: "local", externalId: null, createdAt: now },
    { id: "team_sec", orgId: ORG, name: "Security", origin: "local", externalId: null, createdAt: now },
    { id: "team_foreign", orgId: OTHER_ORG, name: "Foreign", origin: "local", externalId: null, createdAt: now },
  ]);
  // Alice is on team_eng; Bob is on team_sec; Carol is on no team.
  await db.insert(teamMembers).values([
    { teamId: "team_eng", userId: "u_alice", role: "member" },
    { teamId: "team_sec", userId: "u_bob", role: "member" },
  ]);
}

describe("plugin entitlements service", () => {
  let db: AppDb;

  beforeEach(async () => {
    const h = await freshTestPgDb();
    db = h.appDb;
    await seed(db);
  });

  it("defaults an unconfigured plugin to mode all", async () => {
    const entitlement = await getPluginEntitlement(db, ORG, "security");
    expect(entitlement).toEqual({ mode: "all", teamIds: [] });
    // And any user is allowed by default.
    expect(await orgAllowsPluginForUser(db, ORG, "u_carol", "security")).toBe(true);
  });

  it("off admits nobody", async () => {
    await setPluginEntitlement(db, ORG, "security", { mode: "off", teamIds: [] });
    expect(await orgAllowsPluginForUser(db, ORG, "u_alice", "security")).toBe(false);
    expect(await orgAllowsPluginForUser(db, ORG, "u_bob", "security")).toBe(false);
    expect(await orgAllowsPluginForUser(db, ORG, "u_carol", "security")).toBe(false);
  });

  it("all admits any org user", async () => {
    await setPluginEntitlement(db, ORG, "security", { mode: "all", teamIds: [] });
    expect(await orgAllowsPluginForUser(db, ORG, "u_carol", "security")).toBe(true);
  });

  it("teams admits only members of a listed team", async () => {
    await setPluginEntitlement(db, ORG, "security", { mode: "teams", teamIds: ["team_sec"] });
    // Bob is on team_sec; Alice and Carol are not.
    expect(await orgAllowsPluginForUser(db, ORG, "u_bob", "security")).toBe(true);
    expect(await orgAllowsPluginForUser(db, ORG, "u_alice", "security")).toBe(false);
    expect(await orgAllowsPluginForUser(db, ORG, "u_carol", "security")).toBe(false);
  });

  it("teams with an empty team list admits nobody", async () => {
    await setPluginEntitlement(db, ORG, "security", { mode: "teams", teamIds: [] });
    expect(await orgAllowsPluginForUser(db, ORG, "u_alice", "security")).toBe(false);
  });

  it("rejects a team that belongs to another org", async () => {
    await expect(
      setPluginEntitlement(db, ORG, "security", { mode: "teams", teamIds: ["team_foreign"] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects an unknown team id", async () => {
    await expect(
      setPluginEntitlement(db, ORG, "security", { mode: "teams", teamIds: ["team_missing"] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a bad mode", async () => {
    // The service runtime-validates the mode; the wire route also relies on
    // this guard. Build a loosely-typed entry so the bad mode reaches it.
    const bad: PluginEntitlement = { mode: "off", teamIds: [] };
    const badRuntime: PluginEntitlement = { ...bad, mode: "sometimes" as PluginEntitlement["mode"] };
    await expect(setPluginEntitlement(db, ORG, "security", badRuntime)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("merges without clobbering other plugins' entries", async () => {
    await setPluginEntitlement(db, ORG, "security", { mode: "off", teamIds: [] });
    await setPluginEntitlement(db, ORG, "future", { mode: "teams", teamIds: ["team_eng"] });
    const all = await getPluginEntitlements(db, ORG);
    expect(all.security).toEqual({ mode: "off", teamIds: [] });
    expect(all.future).toEqual({ mode: "teams", teamIds: ["team_eng"] });
    // The first entry survived the second write.
    expect(await getPluginEntitlement(db, ORG, "security")).toEqual({ mode: "off", teamIds: [] });
  });

  it("normalizes teamIds to empty for off and all", async () => {
    await setPluginEntitlement(db, ORG, "security", { mode: "all", teamIds: ["team_eng"] });
    expect(await getPluginEntitlement(db, ORG, "security")).toEqual({ mode: "all", teamIds: [] });
  });

  it("persists into plugin_store under plugin 'valet', org scope", async () => {
    await setPluginEntitlement(db, ORG, "security", { mode: "off", teamIds: [] });
    // Query the shared plugin_store table directly to prove the storage seam.
    const rows = await db
      .select()
      .from(pluginStore)
      .where(
        and(
          eq(pluginStore.plugin, "valet"),
          eq(pluginStore.collection, "plugin-entitlements"),
          eq(pluginStore.scopeType, "org"),
          eq(pluginStore.scopeId, ORG),
          eq(pluginStore.key, "security"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].doc).toEqual({ mode: "off", teamIds: [] });
    // No org row carries the removed column anymore — the store owns this data.
    const orgRow = await db.select().from(orgs).where(eq(orgs.id, ORG)).limit(1);
    expect(orgRow[0]).not.toHaveProperty("pluginEntitlements");
  });
});
