import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { pgDbFromPool } from "@valet/store-postgres";
import { buildAppDb, applyAppMigrations } from "../lib/drizzle.js";
import { actionPolicies, orgs, policyActiveBundles, policySourceBundles } from "../schema/index.js";
import type { CanonicalSourceBundle } from "./bundles/types.js";
import { CanonicalPolicyBundleManager, ensureCanonicalPolicyReadiness } from "./canonical-policy-manager.js";

function barrier() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function waitForAdvisoryWait(admin: Pool): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await admin.query("select 1 from pg_locks where locktype = 'advisory' and not granted");
    if (result.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Concurrent release migration did not wait for the advisory lock.");
}

function rewriteForRelease(bundle: CanonicalSourceBundle, target: string): CanonicalSourceBundle {
  const manifest = JSON.parse(bundle.manifestJson) as { source: { revision: string } };
  if (!manifest.source.revision.endsWith(`:${target}`)) manifest.source.revision += `:${target}`;
  return { ...bundle, manifestJson: JSON.stringify(manifest) };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("canonical release migration transactions", () => {
  it("serializes identical and conflicting targets and permits a repeatable rollback", async () => {
    const connectionString = process.env.TEST_DATABASE_URL;
    const schema = `canonical_release_${randomUUID().replaceAll("-", "")}`;
    const applicationName = `canonical-release-${schema}`;
    const admin = new Pool({ connectionString });
    const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, application_name: applicationName, max: 4 });
    const pgdb = pgDbFromPool(pool);
    const db = buildAppDb(pool);
    let first: CanonicalPolicyBundleManager | undefined;
    let second: CanonicalPolicyBundleManager | undefined;
    try {
      await admin.query(`create schema ${schema}`);
      await applyAppMigrations(pgdb);
      await pool.query('alter table action_policies drop column authorization_kind');
      await pool.query('alter table action_policy_overrides drop column authorization_kind');
      await applyAppMigrations(pgdb);
      const repairedKinds = await pool.query(`select table_name, is_nullable, column_default from information_schema.columns where table_schema = current_schema() and column_name = 'authorization_kind' order by table_name`);
      expect(repairedKinds.rows).toEqual([
        { table_name: "action_policies", is_nullable: "NO", column_default: "'tool.action'::text" },
        { table_name: "action_policy_overrides", is_nullable: "NO", column_default: "'tool.action'::text" },
      ]);
      await db.insert(orgs).values([{ id: "org-a", name: "A", createdAt: 1 }, { id: "org-b", name: "B", createdAt: 1 }]);
      first = new CanonicalPolicyBundleManager(db, new Map(), () => 10);
      second = new CanonicalPolicyBundleManager(db, new Map(), () => 10);
      await ensureCanonicalPolicyReadiness(first);
      const beforeFutureRows = await db.select().from(policyActiveBundles).orderBy(policyActiveBundles.orgId);
      for (const [id, target, value] of [["builtin-risk", "risk_level", "critical"], ["builtin-service", "service", "valet"], ["builtin-action", "action_id", "valet.task"]] as const) {
        await pool.query(`insert into action_policies (id, org_id, authorization_kind, principal_type, principal_id, ${target}, mode, origin, created_at, updated_at) values ($1, 'org-a', 'tool.builtin', 'org', 'org-a', $2, 'deny', 'admin', 1, 1)`, [id, value]);
        await pool.query(`insert into action_policy_overrides (id, org_id, authorization_kind, user_id, ${target}, mode, created_at, updated_at) values ($1, 'org-a', 'tool.builtin', 'user-a', $2, 'deny', 1, 1)`, [`override-${id}`, value]);
      }
      await ensureCanonicalPolicyReadiness(first);
      expect(await db.select().from(policyActiveBundles).orderBy(policyActiveBundles.orgId)).toEqual(beforeFutureRows);
      await db.insert(actionPolicies).values({ id: "authored", orgId: "org-b", principalType: "org", principalId: "org-b", actionId: "gmail.send", mode: "deny", paramMatchers: [], appliesIn: "any", origin: "admin", createdAt: 2, updatedAt: 2 });
      const authored = await first.buildCurrent("org-b");
      await db.delete(actionPolicies).where(eq(actionPolicies.id, "authored"));
      await first.activateCandidate("org-b", authored.identity, authored.built.bundle, { actorId: "admin", operation: "policy_authoring_publish", idempotencyKey: "authored" });

      const before = await db.select().from(policyActiveBundles).orderBy(policyActiveBundles.orgId);
      const originals = new Map<string, CanonicalSourceBundle>();
      for (const pointer of before) {
        const stored = (await db.select({ bundle: policySourceBundles.bundle }).from(policySourceBundles).where(eq(policySourceBundles.digest, pointer.digest)).limit(1))[0];
        if (!stored) throw new Error(`Missing test bundle for ${pointer.orgId}.`);
        originals.set(pointer.orgId, stored.bundle);
      }
      const plannedSources: string[] = [];
      await expect(first.migrateReleaseSet("release-bad", async (input, scoped) => {
        expect(scoped.db).not.toBe(first!.db);
        plannedSources.push(input.source);
        if (input.organizationId === "org-b") throw new Error("partial planning failure");
        return rewriteForRelease(input.bundle, "release-bad");
      })).rejects.toThrow("partial planning failure");
      expect(plannedSources).toEqual(["structured", "authored"]);
      expect(await db.select().from(policyActiveBundles).orderBy(policyActiveBundles.orgId)).toEqual(before);

      const run = (manager: CanonicalPolicyBundleManager, target: string, hold?: ReturnType<typeof barrier>) => {
        let held = false;
        return manager.migrateReleaseSet(target, async (input, scoped) => {
          expect(scoped.db).not.toBe(manager.db);
          if (hold && !held) { held = true; hold.release(); await hold.promise; }
          return rewriteForRelease(input.bundle, target);
        });
      };
      const concurrent = async (winnerTarget: string, waiterTarget: string) => {
        const entered = barrier();
        const resume = barrier();
        const winner = run(first!, winnerTarget, { promise: resume.promise, release: entered.release });
        await entered.promise;
        const waiter = run(second!, waiterTarget);
        try {
          await waitForAdvisoryWait(admin);
        } finally {
          resume.release();
        }
        return { winner, waiter };
      };

      const identical = await concurrent("release-2", "release-2");
      await expect(Promise.all([identical.winner, identical.waiter])).resolves.toEqual([undefined, undefined]);
      const afterIdentical = await db.select().from(policyActiveBundles).orderBy(policyActiveBundles.orgId);
      expect(afterIdentical.every((row, index) => row.generation === before[index]!.generation + 1)).toBe(true);

      const conflict = await concurrent("release-3", "release-4");
      const rejected = expect(conflict.waiter).rejects.toThrow(/concurrent target race/);
      await conflict.winner;
      await rejected;

      await first.migrateReleaseSet("release-1-rollback", async (input) => originals.get(input.organizationId)!);
      const rolledBack = await db.select().from(policyActiveBundles).orderBy(policyActiveBundles.orgId);
      expect(rolledBack.map((row) => row.digest)).toEqual(before.map((row) => row.digest));
      expect(rolledBack.every((row, index) => row.generation === before[index]!.generation + 3)).toBe(true);
      await first.migrateReleaseSet("release-1-rollback", async (input) => originals.get(input.organizationId)!);
      expect(await db.select().from(policyActiveBundles).orderBy(policyActiveBundles.orgId)).toEqual(rolledBack);
    } finally {
      await Promise.all([first?.close(), second?.close()]);
      await pool.end();
      await admin.query(`drop schema if exists ${schema} cascade`);
      await admin.end();
    }
  }, 120_000);
});
