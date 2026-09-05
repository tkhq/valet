import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { imageSources } from "../schema/index.js";
import { resolveRepoResources } from "./resolve-repo-resources.js";

describe("resolveRepoResources", () => {
  let harness: TestPgDb;
  const primary = { host: "github", fullName: "acme/widgets" };
  beforeEach(async () => { harness = await freshTestPgDb(); });
  afterEach(async () => { vi.restoreAllMocks(); await harness.cleanup(); });

  async function seed(orgId = "org-a", host = "github", cpu = 2) {
    await harness.appDb.insert(imageSources).values({
      id: `${orgId}-${host}`, orgId, kind: "repo", name: primary.fullName,
      repoHost: host, repoFullName: primary.fullName, enabled: false,
      sandboxResources: { cpu, memory: "4Gi" }, createdAt: 1, updatedAt: 1,
    });
  }

  it("merges YAML per field and uses saved defaults for absent YAML", async () => {
    await seed();
    const merged = await resolveRepoResources(harness.appDb, "org-a", primary, async () => ({
      docker: true, outcome: "declared", resources: { memory: "8Gi" },
    }));
    expect(merged.resources).toEqual({ cpu: 2, memory: "8Gi" });
    expect(merged.initialResources).toEqual(merged.resources);
    const absent = await resolveRepoResources(harness.appDb, "org-a", primary, async () => ({ docker: false, outcome: "absent" }));
    expect(absent.resources).toEqual({ cpu: 2, memory: "4Gi" });
    const cpu = await resolveRepoResources(harness.appDb, "org-a", primary, async () => ({ docker: false, outcome: "declared", resources: { cpu: 8 } }));
    expect(cpu.resources).toEqual({ cpu: 8, memory: "4Gi" });
  });

  it("scopes defaults by organization and host and treats missing rows as no defaults", async () => {
    await seed();
    await seed("org-b", "github", 6);
    await seed("org-a", "gitlab", 3);
    for (const [org, host, cpu] of [["org-a", "github", 2], ["org-b", "github", 6], ["org-a", "gitlab", 3]] as const) {
      const result = await resolveRepoResources(harness.appDb, org, { ...primary, host }, async () => ({ docker: false, outcome: "absent" }));
      expect(result.resources).toEqual({ cpu, memory: "4Gi" });
    }
    const missing = await resolveRepoResources(harness.appDb, "org-c", primary, async () => ({ docker: false, outcome: "absent" }));
    expect(missing.resources).toEqual({});
  });

  it.each([undefined, "github", "github.com"])("resolves GitHub host alias %s to the canonical saved source", async (host) => {
    await seed();
    const result = await resolveRepoResources(harness.appDb, "org-a", { ...primary, host }, async () => ({ docker: false, outcome: "absent" }));
    expect(result.resources).toEqual({ cpu: 2, memory: "4Gi" });
  });

  it.each([undefined, "github", "github.com"])("resolves GitHub host alias %s when only github.com is stored", async (host) => {
    await seed("org-a", "github.com", 6);
    const result = await resolveRepoResources(harness.appDb, "org-a", { ...primary, host }, async () => ({ docker: false, outcome: "absent" }));
    expect(result.resources).toEqual({ cpu: 6, memory: "4Gi" });
  });

  it.each([undefined, "github", "github.com"])("prefers the exact GitHub host %s when both aliases have saved rows", async (host) => {
    await seed("org-a", "github.com", 6);
    await seed();
    const result = await resolveRepoResources(harness.appDb, "org-a", { ...primary, host }, async () => ({ docker: false, outcome: "absent" }));
    expect(result.resources).toEqual({ cpu: host === "github.com" ? 6 : 2, memory: "4Gi" });
  });

  it("reads saved defaults fresh on every resolution", async () => {
    await seed();
    const yaml = async () => ({ docker: false, outcome: "absent" as const });
    expect((await resolveRepoResources(harness.appDb, "org-a", primary, yaml)).resources?.cpu).toBe(2);

    await harness.appDb.update(imageSources).set({ sandboxResources: { cpu: 6 } }).where(eq(imageSources.id, "org-a-github"));

    expect((await resolveRepoResources(harness.appDb, "org-a", primary, yaml)).resources?.cpu).toBe(6);
  });

  it("keeps fresh-create fallback separate from the opinion when YAML fails", async () => {
    await seed();
    const failed = await resolveRepoResources(harness.appDb, "org-a", primary, async () => ({ docker: false, outcome: "error" }));
    expect(failed.resources).toBeUndefined();
    expect(failed.initialResources).toEqual({ cpu: 2, memory: "4Gi" });
    expect(failed.resourcesWithheld).toBe(true);
  });

  it("removes the opinion on DB failure but keeps successful YAML for a fresh create", async () => {
    vi.spyOn(harness.appDb, "select").mockImplementation(() => { throw new Error("database unavailable"); });
    const failed = await resolveRepoResources(harness.appDb, "org-a", primary, async () => ({ docker: false, outcome: "declared", resources: { cpu: 8 } }));
    expect(failed.resources).toBeUndefined();
    expect(failed.initialResources).toEqual({ cpu: 8 });
    expect(failed.resourcesWithheld).toBe(true);
  });
});
