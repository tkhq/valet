import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { actionInvocations, actionPolicies, orgs, policyActiveBundles, policySourceBundles } from "../schema/index.js";
import { CanonicalPolicyBundleManager, ensureCanonicalPolicyReadiness } from "./canonical-policy-manager.js";
import { PostgresSourceBundleStorage } from "./bundles/postgres-storage.js";

let pg: TestPgDb | undefined;
afterEach(async () => { await pg?.cleanup(); pg = undefined; });
async function setup() { pg = await freshTestPgDb(); return pg.appDb; }
const bundle = (value: string) => ({ manifestJson: value, files: [] });

describe("PostgresSourceBundleStorage", () => {
  it("keeps immutable global content and tenant CAS pointers", async () => {
    const db = await setup();
    await db.insert(orgs).values([{ id: "org-a", name: "A", createdAt: 1 }, { id: "org-b", name: "B", createdAt: 1 }]);
    const storage = new PostgresSourceBundleStorage(db, () => 2);
    expect(await storage.putIfAbsent("digest", bundle("one"))).toBe("inserted");
    expect(await storage.putIfAbsent("digest", bundle("one"))).toBe("exists");
    await expect(storage.putIfAbsent("digest", bundle("two"))).rejects.toMatchObject({ code: "bundle_conflict" });
    const [winner, loser] = await Promise.all([
      storage.compareAndSetActive("org-a", undefined, "digest"),
      storage.compareAndSetActive("org-a", undefined, "digest"),
    ]);
    expect([winner, loser].filter(Boolean)).toHaveLength(1);
    expect(await storage.compareAndSetActive("org-b", undefined, "digest")).toMatchObject({ generation: 1 });
    expect(await storage.getActive("org-a")).toMatchObject({ sourceBundleDigest: "digest", generation: 1 });
  });
});

describe("canonical policy readiness", () => {
  it("compiles missing pointers once and rejects stale active state", async () => {
    const db = await setup();
    await db.insert(orgs).values({ id: "org-a", name: "A", createdAt: 1 });
    const manager = new CanonicalPolicyBundleManager(db, new Map(), () => 10);
    try {
      await ensureCanonicalPolicyReadiness(manager);
      const first = await manager.host.activePointer("org-a");
      await ensureCanonicalPolicyReadiness(manager);
      expect(await manager.host.activePointer("org-a")).toEqual(first);
      await db.insert(actionPolicies).values({ id: "rule", orgId: "org-a", principalType: "org", principalId: "org-a", actionId: "gmail.send", mode: "deny", paramMatchers: [], appliesIn: "any", origin: "admin", createdAt: 1, updatedAt: 1 });
      await expect(ensureCanonicalPolicyReadiness(manager)).rejects.toThrow(/stale/);
      expect(await manager.host.activePointer("org-a")).toEqual(first);
    } finally { await manager.close(); }
  }, 120_000);

  it("blocks all readiness when one organization has corrupt content", async () => {
    const db = await setup();
    await db.insert(orgs).values([{ id: "org-a", name: "A", createdAt: 1 }, { id: "org-b", name: "B", createdAt: 1 }]);
    await db.insert(policySourceBundles).values({ digest: "bad", bundle: bundle("{}"), createdAt: 1 });
    await db.insert(policyActiveBundles).values({ orgId: "org-b", digest: "bad", generation: 1, activatedAt: 1 });
    const manager = new CanonicalPolicyBundleManager(db, new Map());
    try {
      await expect(ensureCanonicalPolicyReadiness(manager)).rejects.toThrow();
      expect(await manager.host.activePointer("org-a")).toBeUndefined();
    } finally { await manager.close(); }
  }, 120_000);

  it("creates an organization with immutable content and generation one", async () => {
    const db = await setup();
    const manager = new CanonicalPolicyBundleManager(db, new Map(), () => 5);
    try {
      await manager.provisionOrganization("org-new", "New");
      expect(await db.select().from(orgs).where(eq(orgs.id, "org-new"))).toHaveLength(1);
      expect(await db.select().from(policySourceBundles)).toHaveLength(1);
      expect(await db.select().from(policyActiveBundles)).toMatchObject([{ orgId: "org-new", generation: 1 }]);
      await manager.ensureOrganizationReady("org-new");
    } finally { await manager.close(); }
  }, 120_000);

  it("revalidates exact candidate identity before pointer CAS and audit", async () => {
    const db = await setup(); await db.insert(orgs).values({ id: "org-a", name: "A", createdAt: 1 });
    const manager = new CanonicalPolicyBundleManager(db, new Map(), () => 10);
    try {
      await ensureCanonicalPolicyReadiness(manager);
      const before = (await manager.host.activePointer("org-a"))!;
      await db.insert(actionPolicies).values({ id: "candidate-rule", orgId: "org-a", principalType: "org", principalId: "org-a", actionId: "gmail.send", mode: "deny", paramMatchers: [], appliesIn: "any", origin: "admin", createdAt: 2, updatedAt: 2 });
      const candidate = await manager.buildCurrent("org-a");
      await db.delete(actionPolicies).where(eq(actionPolicies.id, "candidate-rule"));
      await expect(manager.activateCandidate("org-a", { ...candidate.identity, engineDigest: "0".repeat(64) }, candidate.built.bundle, { actorId: "admin", operation: "policy_authoring_publish", idempotencyKey: "bad" })).rejects.toThrow(/identity changed/);
      expect(await manager.host.activePointer("org-a")).toEqual(before);
      await manager.activateCandidate("org-a", candidate.identity, candidate.built.bundle, { actorId: "admin", operation: "policy_authoring_publish", idempotencyKey: "good" });
      const after = (await manager.host.activePointer("org-a"))!;
      expect(after).toMatchObject({ sourceBundleDigest: candidate.identity.sourceBundleDigest, generation: before.generation + 1 });
      expect(await db.select().from(actionInvocations).where(eq(actionInvocations.actionId, "policy_authoring_publish"))).toHaveLength(1);
    } finally { await manager.close(); }
  }, 120_000);

  it("activates static writes atomically and rolls back invalid candidates", async () => {
    const db = await setup(); await db.insert(orgs).values({ id: "org-a", name: "A", createdAt: 1 });
    const manager = new CanonicalPolicyBundleManager(db, new Map(), () => 10);
    try {
      await ensureCanonicalPolicyReadiness(manager);
      const before = (await manager.host.activePointer("org-a"))!;
      await manager.mutateAndActivate("org-a", { actorId: "admin", operation: "create", idempotencyKey: "one" }, (tx) => tx.insert(actionPolicies).values({ id: "rule", orgId: "org-a", principalType: "org", principalId: "org-a", actionId: "gmail.send", mode: "deny", paramMatchers: [], appliesIn: "any", origin: "admin", createdAt: 2, updatedAt: 2 }));
      const after = (await manager.host.activePointer("org-a"))!; expect(after.generation).toBe(before.generation + 1); expect(after.sourceBundleDigest).not.toBe(before.sourceBundleDigest);
      await expect(manager.mutateAndActivate("org-a", { actorId: "admin", operation: "create", idempotencyKey: "two" }, (tx) => tx.insert(actionPolicies).values({ id: "conflict", orgId: "org-a", principalType: "team", principalId: "missing-team", actionId: "gmail.send", mode: "allow", paramMatchers: [], appliesIn: "any", origin: "admin", createdAt: 2, updatedAt: 2 }))).rejects.toThrow();
      expect(await db.select().from(actionPolicies).where(eq(actionPolicies.id, "conflict"))).toHaveLength(0);
      expect(await manager.host.activePointer("org-a")).toEqual(after);
    } finally { await manager.close(); }
  }, 120_000);

});
