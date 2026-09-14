import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { actionInvocations, actionPolicies, actionPolicyOverrides, orgs, policyActiveBundles, policySourceBundles, runtimeGrants, workflowRuns } from "../schema/index.js";
import { CanonicalPolicyBundleManager, CanonicalPolicyConfigManagedError, CanonicalPolicySourceReadOnlyError, ensureCanonicalPolicyReadiness, migrateCanonicalPolicyReleaseSet, sameConcurrentReleaseTarget } from "./canonical-policy-manager.js";
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

  it("accepts an identical first-boot compare-and-swap winner", async () => {
    const db = await setup();
    await db.insert(orgs).values({ id: "org-a", name: "A", createdAt: 1 });
    const first = new CanonicalPolicyBundleManager(db, new Map(), () => 10);
    const second = new CanonicalPolicyBundleManager(db, new Map(), () => 10);
    try {
      await Promise.all([first.ensureOrganizationReady("org-a"), second.ensureOrganizationReady("org-a")]);
      expect(await db.select().from(policyActiveBundles)).toHaveLength(1);
      await Promise.all([ensureCanonicalPolicyReadiness(first), ensureCanonicalPolicyReadiness(second)]);
    } finally { await Promise.all([first.close(), second.close()]); }
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
      const audit = { actorId: "admin", operation: "policy_authoring_publish", idempotencyKey: "good" };
      await manager.activateCandidate("org-a", candidate.identity, candidate.built.bundle, audit);
      const after = (await manager.host.activePointer("org-a"))!;
      expect(after).toMatchObject({ sourceBundleDigest: candidate.identity.sourceBundleDigest, generation: before.generation + 1 });
      await manager.activateCandidate("org-a", candidate.identity, candidate.built.bundle, audit);
      expect(await manager.host.activePointer("org-a")).toEqual(after);
      expect(await db.select().from(actionInvocations).where(eq(actionInvocations.actionId, "policy_authoring_publish"))).toHaveLength(1);
    } finally { await manager.close(); }
  }, 120_000);

  it("rejects candidate publication before config-managed pointer or row mutation", async () => {
    const db = await setup(); await db.insert(orgs).values({ id: "org-a", name: "A", createdAt: 1 });
    const manager = new CanonicalPolicyBundleManager(db, new Map(), () => 10);
    try {
      await ensureCanonicalPolicyReadiness(manager);
      const pointer = await manager.host.activePointer("org-a");
      const bundles = await db.select().from(policySourceBundles);
      const audits = await db.select().from(actionInvocations);
      await db.insert(actionPolicies).values({ id: "candidate", orgId: "org-a", principalType: "org", principalId: "org-a", actionId: "gmail.send", mode: "deny", paramMatchers: [], appliesIn: "any", origin: "admin", createdAt: 2, updatedAt: 2 });
      const candidate = await manager.buildCurrent("org-a");
      await db.delete(actionPolicies).where(eq(actionPolicies.id, "candidate"));
      manager.setConfigManagedToolPolicies("org-a", "/etc/valet.yaml");

      await expect(manager.activateCandidate("org-a", candidate.identity, candidate.built.bundle, { actorId: "admin", operation: "policy_authoring_publish", idempotencyKey: "blocked" }))
        .rejects.toEqual(new CanonicalPolicyConfigManagedError("org-a", "/etc/valet.yaml"));
      expect(await manager.host.activePointer("org-a")).toEqual(pointer);
      expect(await db.select().from(policySourceBundles)).toEqual(bundles);
      expect(await db.select().from(actionInvocations)).toEqual(audits);
      expect(await db.select().from(actionPolicies)).toHaveLength(0);
    } finally { await manager.close(); }
  }, 120_000);

  it("makes candidate-owned policy read-only to every structured writer and permits reviewed candidate recovery", async () => {
    const db = await setup(); await db.insert(orgs).values({ id: "org-a", name: "A", createdAt: 1 });
    const manager = new CanonicalPolicyBundleManager(db, new Map(), () => 10);
    try {
      await ensureCanonicalPolicyReadiness(manager);
      await db.insert(actionPolicies).values({ id: "candidate-a", orgId: "org-a", principalType: "org", principalId: "org-a", actionId: "gmail.send", mode: "deny", paramMatchers: [], appliesIn: "any", origin: "admin", createdAt: 2, updatedAt: 2 });
      const first = await manager.buildCurrent("org-a");
      await db.update(actionPolicies).set({ id: "candidate-b", mode: "allow" }).where(eq(actionPolicies.id, "candidate-a"));
      const replacement = await manager.buildCurrent("org-a");
      await db.delete(actionPolicies).where(eq(actionPolicies.id, "candidate-b"));

      await manager.activateCandidate("org-a", first.identity, first.built.bundle, { actorId: "admin", operation: "policy_authoring_publish", idempotencyKey: "first" });
      const active = await manager.host.activePointer("org-a");
      let mutations = 0;
      for (const operation of ["create", "update", "revoke", "always_allow", "workflow_always_allow", "workflow_preapproval", "team_delete", "config_reconcile"]) {
        await expect(manager.mutateAndActivate("org-a", { actorId: "admin", operation, idempotencyKey: operation }, async () => { mutations++; }))
          .rejects.toMatchObject({ code: "canonical_policy_source_read_only", statusCode: 409 });
      }
      expect(mutations).toBe(0);
      expect(await db.select().from(actionPolicies)).toHaveLength(0);
      expect(await manager.host.activePointer("org-a")).toEqual(active);

      await expect(manager.activateCandidate("org-a", { ...replacement.identity, policyDigest: "0".repeat(64) }, replacement.built.bundle, { actorId: "admin", operation: "policy_authoring_publish", idempotencyKey: "invalid" }))
        .rejects.toThrow(/identity changed/);
      await manager.activateCandidate("org-a", replacement.identity, replacement.built.bundle, { actorId: "admin", operation: "policy_authoring_publish", idempotencyKey: "replacement" });
      expect((await manager.host.activePointer("org-a"))?.sourceBundleDigest).toBe(replacement.identity.sourceBundleDigest);
      expect(new CanonicalPolicySourceReadOnlyError("org-a")).toMatchObject({ code: "canonical_policy_source_read_only", statusCode: 409 });
    } finally { await manager.close(); }
  }, 120_000);

  it("keeps the old pointer when candidate runtime loading fails", async () => {
    const db = await setup(); await db.insert(orgs).values({ id: "org-a", name: "A", createdAt: 1 });
    const manager = new CanonicalPolicyBundleManager(db, new Map(), () => 10);
    try {
      await ensureCanonicalPolicyReadiness(manager);
      const before = (await manager.host.activePointer("org-a"))!;
      await db.insert(actionPolicies).values({ id: "candidate-rule", orgId: "org-a", principalType: "org", principalId: "org-a", actionId: "gmail.send", mode: "deny", paramMatchers: [], appliesIn: "any", origin: "admin", createdAt: 2, updatedAt: 2 });
      const candidate = await manager.buildCurrent("org-a");
      const load = manager.runtime.loadBundle.bind(manager.runtime);
      manager.runtime.loadBundle = async () => { throw new Error("load failed"); };
      await expect(manager.activateCandidate("org-a", candidate.identity, candidate.built.bundle, { actorId: "admin", operation: "policy_authoring_publish", idempotencyKey: "load" })).rejects.toThrow("load failed");
      expect(await manager.host.activePointer("org-a")).toEqual(before);
      expect(await db.select().from(actionInvocations).where(eq(actionInvocations.actionId, "policy_authoring_publish"))).toHaveLength(0);
      manager.runtime.loadBundle = load;
    } finally { await manager.close(); }
  }, 120_000);

  it("runs the production release wrapper within the PGlite transaction bound", async () => {
    const db = await setup();
    await db.insert(orgs).values([{ id: "org-a", name: "A", createdAt: 1 }, { id: "org-b", name: "B", createdAt: 1 }]);
    const manager = new CanonicalPolicyBundleManager(db, new Map(), () => 10);
    try {
      await ensureCanonicalPolicyReadiness(manager);
      await db.insert(actionPolicies).values({ id: "authored", orgId: "org-b", principalType: "org", principalId: "org-b", actionId: "gmail.send", mode: "deny", paramMatchers: [], appliesIn: "any", origin: "admin", createdAt: 2, updatedAt: 2 });
      const authored = await manager.buildCurrent("org-b");
      await db.delete(actionPolicies).where(eq(actionPolicies.id, "authored"));
      await manager.activateCandidate("org-b", authored.identity, authored.built.bundle, { actorId: "admin", operation: "policy_authoring_publish", idempotencyKey: "authored" });

      await Promise.race([
        migrateCanonicalPolicyReleaseSet(manager, "current-release"),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("production release wrapper exceeded 10 seconds")), 10_000)),
      ]);
      const audits = await db.select().from(actionInvocations).where(eq(actionInvocations.actionId, "release_set_migration"));
      expect(audits.sort((a, b) => (a.orgId ?? "").localeCompare(b.orgId ?? ""))).toMatchObject([
        { orgId: "org-a", params: { source: "structured" } },
        { orgId: "org-b", params: { source: "authored" } },
      ]);
    } finally { await manager.close(); }
  }, 120_000);

  it("migrates a release set atomically, preserves authored source, and is repeatable after rollback", async () => {
    const db = await setup();
    await db.insert(orgs).values([{ id: "org-a", name: "A", createdAt: 1 }, { id: "org-b", name: "B", createdAt: 1 }]);
    const manager = new CanonicalPolicyBundleManager(db, new Map(), () => 10);
    try {
      await ensureCanonicalPolicyReadiness(manager);
      await db.insert(actionPolicies).values({ id: "authored", orgId: "org-b", principalType: "org", principalId: "org-b", actionId: "gmail.send", mode: "deny", paramMatchers: [], appliesIn: "any", origin: "admin", createdAt: 2, updatedAt: 2 });
      const authored = await manager.buildCurrent("org-b");
      await db.delete(actionPolicies).where(eq(actionPolicies.id, "authored"));
      await manager.activateCandidate("org-b", authored.identity, authored.built.bundle, { actorId: "admin", operation: "policy_authoring_publish", idempotencyKey: "authored" });
      const before = await db.select().from(policyActiveBundles).orderBy(policyActiveBundles.orgId);
      const originalBundles = new Map<string, typeof authored.built.bundle>();
      for (const pointer of before) {
        const stored = (await db.select({ bundle: policySourceBundles.bundle }).from(policySourceBundles).where(eq(policySourceBundles.digest, pointer.digest)).limit(1))[0];
        if (!stored) throw new Error(`missing test bundle ${pointer.digest}`);
        originalBundles.set(pointer.orgId, stored.bundle);
      }
      const authoredFiles = authored.built.bundle.files;
      const rewrite = async (input: { bundle: typeof authored.built.bundle }) => {
        const manifest = JSON.parse(input.bundle.manifestJson) as { source: { revision: string } };
        if (!manifest.source.revision.endsWith(":release-2")) {
          const prior = JSON.stringify(manifest.source.revision);
          manifest.source.revision += ":release-2";
          return { ...input.bundle, manifestJson: input.bundle.manifestJson.replace(prior, JSON.stringify(manifest.source.revision)) };
        }
        return input.bundle;
      };

      await db.insert(runtimeGrants).values([
        { id: "legacy-grant", orgId: "org-a", sessionId: "session-a", policyKey: "gmail.send", grantedBy: "user-a", createdAt: 1 },
        { id: "canonical-grant", orgId: "org-a", sessionId: "session-a", policyKey: "calendar.create", service: "calendar", actionId: "calendar.create", riskLevel: "high", sourceApprovalId: "approval-a", expiresAt: 1000, grantedBy: "user-a", createdAt: 1 },
      ]);
      await db.insert(workflowRuns).values({ id: "pending-approval", workflowId: "workflow-a", definitionVersionId: "version-a", definition: {}, params: {}, status: "parked", waitingOn: [{ kind: "signal", signalType: "approval:review" }], createdAt: 1, updatedAt: 1 });

      let calls = 0;
      await expect(manager.migrateReleaseSet("release-bad", async (input) => {
        calls++;
        if (input.organizationId === "org-b") return { manifestJson: "{}", files: input.bundle.files };
        return rewrite(input);
      })).rejects.toThrow();
      expect(calls).toBe(2);
      expect(await db.select().from(policyActiveBundles).orderBy(policyActiveBundles.orgId)).toEqual(before);
      expect((await db.select().from(runtimeGrants).where(eq(runtimeGrants.id, "legacy-grant")))[0]?.revokedAt).toBeNull();

      await manager.migrateReleaseSet("release-2", rewrite);
      const grants = await db.select().from(runtimeGrants).orderBy(runtimeGrants.id);
      expect(grants.find((row) => row.id === "legacy-grant")?.revokedAt).toBe(10);
      expect(grants.find((row) => row.id === "canonical-grant")?.revokedAt).toBeNull();
      expect(await db.select().from(actionInvocations).where(eq(actionInvocations.actionId, "legacy_runtime_grant_revoked"))).toMatchObject([
        { orgId: "org-a", params: { targetRelease: "release-2", grantId: "legacy-grant", treatment: "re_gate" } },
      ]);
      expect(await db.select().from(workflowRuns).where(eq(workflowRuns.id, "pending-approval"))).toMatchObject([
        { status: "parked", waitingOn: [{ kind: "signal", signalType: "approval:review" }] },
      ]);
      const after = await db.select().from(policyActiveBundles).orderBy(policyActiveBundles.orgId);
      expect(after.every((row, index) => row.generation === before[index]!.generation + 1)).toBe(true);
      const migratedAuthored = (await db.select({ bundle: policySourceBundles.bundle }).from(policySourceBundles).where(eq(policySourceBundles.digest, after[1]!.digest)).limit(1))[0]!.bundle;
      expect(migratedAuthored.files).toEqual(authoredFiles);
      await manager.migrateReleaseSet("release-2", rewrite);
      expect(await db.select().from(policyActiveBundles).orderBy(policyActiveBundles.orgId)).toEqual(after);

      await manager.migrateReleaseSet("release-1-rollback", async (input) => originalBundles.get(input.organizationId)!);
      const rolledBack = await db.select().from(policyActiveBundles).orderBy(policyActiveBundles.orgId);
      expect(rolledBack.map((row) => row.digest)).toEqual(before.map((row) => row.digest));
      expect(rolledBack.every((row, index) => row.generation === before[index]!.generation + 2)).toBe(true);
      await manager.migrateReleaseSet("release-1-rollback", async (input) => originalBundles.get(input.organizationId)!);
      expect(await db.select().from(policyActiveBundles).orderBy(policyActiveBundles.orgId)).toEqual(rolledBack);
    } finally { await manager.close(); }
  }, 120_000);

  it("accepts only a fully recorded identical concurrent release target", () => {
    const current = [{ orgId: "org-a", digest: "new-a", generation: 2 }, { orgId: "org-b", digest: "same-b", generation: 3 }];
    const audits = current.map((pointer) => ({ orgId: pointer.orgId, params: { targetRelease: "release-2", sourceBundleDigest: pointer.digest, generation: pointer.generation } }));
    expect(sameConcurrentReleaseTarget(current, audits, "release-2")).toBe(true);
    expect(sameConcurrentReleaseTarget(current, audits, "release-3")).toBe(false);
    expect(sameConcurrentReleaseTarget([{ ...current[0]!, generation: 3 }, current[1]!], audits, "release-2")).toBe(false);
    expect(sameConcurrentReleaseTarget(current, audits.slice(0, 1), "release-2")).toBe(false);
  });

  it("rolls back static writes after a stale pointer CAS", async () => {
    const db = await setup(); await db.insert(orgs).values({ id: "org-a", name: "A", createdAt: 1 });
    const manager = new CanonicalPolicyBundleManager(db, new Map(), () => 10);
    try {
      await ensureCanonicalPolicyReadiness(manager);
      const before = (await manager.host.activePointer("org-a"))!;
      await expect(manager.mutateAndActivate("org-a", { actorId: "admin", operation: "create", idempotencyKey: "stale" }, async (tx) => {
        await tx.insert(actionPolicies).values({ id: "stale-rule", orgId: "org-a", principalType: "org", principalId: "org-a", actionId: "gmail.send", mode: "deny", paramMatchers: [], appliesIn: "any", origin: "admin", createdAt: 2, updatedAt: 2 });
        await tx.update(policyActiveBundles).set({ generation: before.generation + 1 }).where(eq(policyActiveBundles.orgId, "org-a"));
      })).rejects.toThrow(/compare-and-swap/);
      expect(await manager.host.activePointer("org-a")).toEqual(before);
      expect(await db.select().from(actionPolicies).where(eq(actionPolicies.id, "stale-rule"))).toHaveLength(0);
    } finally { await manager.close(); }
  }, 120_000);

  it("builds the conservative bounds bundle only when the mutation requests it", async () => {
    const db = await setup(); await db.insert(orgs).values({ id: "org-a", name: "A", createdAt: 1 });
    const manager = new CanonicalPolicyBundleManager(db, new Map(), () => 10);
    try {
      await ensureCanonicalPolicyReadiness(manager);
      const run = manager.runtime.run.bind(manager.runtime);
      let validations = 0;
      manager.runtime.run = async (request) => {
        if (request.operation === "validate_bundle") validations++;
        return run(request);
      };
      await manager.mutateAndActivate("org-a", { actorId: "admin", operation: "noop", idempotencyKey: "lazy" }, async () => undefined);
      expect(validations).toBe(2);
      validations = 0;
      await manager.mutateAndActivate("org-a", { actorId: "admin", operation: "bounds", idempotencyKey: "bounds" }, async (_tx, context) => {
        const first = await context.overrideBoundsIdentity();
        expect(await context.overrideBoundsIdentity()).toEqual(first);
      });
      expect(validations).toBe(3);
    } finally { await manager.close(); }
  }, 120_000);

  it("rolls back an override and pointer when post-bounds activation fails", async () => {
    const db = await setup(); await db.insert(orgs).values({ id: "org-a", name: "A", createdAt: 1 });
    const manager = new CanonicalPolicyBundleManager(db, new Map(), () => 10);
    try {
      await ensureCanonicalPolicyReadiness(manager);
      const before = (await manager.host.activePointer("org-a"))!;
      const load = manager.runtime.loadBundle.bind(manager.runtime);
      let loads = 0;
      manager.runtime.loadBundle = async (digest, source) => {
        loads++;
        if (loads === 2) throw new Error("candidate load failed");
        return load(digest, source);
      };
      await expect(manager.mutateAndActivate("org-a", { actorId: "user-1", operation: "override_upsert", idempotencyKey: "rollback" }, async (tx, context) => {
        await context.overrideBoundsIdentity();
        await tx.insert(actionPolicyOverrides).values({ id: "override", orgId: "org-a", userId: "user-1", actionId: "gmail.send", mode: "allow", paramMatchers: [], createdAt: 2, updatedAt: 2 });
      })).rejects.toThrow("candidate load failed");
      expect(await db.select().from(actionPolicyOverrides).where(eq(actionPolicyOverrides.id, "override"))).toHaveLength(0);
      expect(await manager.host.activePointer("org-a")).toEqual(before);
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
