/** Installation discovery and webhook writes share an organization lock. */
import { readFileSync } from "node:fs";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "@valet/engine";
import { buildAppDb } from "../lib/drizzle.js";
import { contentSources, githubInstallations, orgs } from "../schema/index.js";
import { discoverInstallations, saveAppConfig } from "./github-app.js";
import { invalidateWorkflowSources } from "./content-sync/invalidation.js";

function barrier() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("GitHub discovery readiness locking", () => {
  it("waits for a suspension write and invalidates when stale discovery restores the installation", async () => {
    const connectionString = process.env.TEST_DATABASE_URL;
    const schema = `installation_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    const pool = new Pool({ connectionString, options: `-c search_path=${schema} -c lock_timeout=100ms`, max: 3 });
    const db = buildAppDb(pool);
    const locked = barrier();
    const resume = barrier();
    let webhook: Promise<void> | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      const migration = readFileSync(new URL("../../migrations/pg/0000_app.sql", import.meta.url), "utf8");
      for (const name of ["skill_sources", "github_installations", "credentials"]) {
        const table = migration.split(/-->\s*statement-breakpoint/).find((statement) => statement.includes(`CREATE TABLE "${name}"`));
        if (!table) throw new Error(`Missing ${name} migration`);
        await pool.query(table);
      }
      await pool.query("CREATE TABLE orgs (id text PRIMARY KEY)");
      await pool.query("INSERT INTO orgs VALUES ('org')");
      await pool.query("CREATE UNIQUE INDEX installation_org_id ON github_installations (org_id, installation_id)");
      await db.insert(contentSources).values({ id: "source", orgId: "org", ownerType: "team", ownerId: "team",
        repoFullName: "test/repo", kinds: ["workflows"], nextAttemptAt: 0, createdAt: 0, updatedAt: 0 });
      await db.insert(githubInstallations).values({ id: "installation", orgId: "org", installationId: 123,
        accountLogin: "acme", accountType: "Organization", suspended: false, createdAt: 0, updatedAt: 0 });
      const credentials = new InMemoryCredentialStore();
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
      await saveAppConfig({ credentials }, "org", { appId: "123", appSlug: "test", oauthClientId: "client",
        htmlUrl: "https://github.com/apps/test", privateKeyPem: privateKey, oauthClientSecret: "secret", webhookSecret: "hook" });
      const discover = () => discoverInstallations({ db, credentials, key: Buffer.alloc(32),
        fetchImpl: async () => new Response(JSON.stringify([{ id: 123, account: { login: "acme", type: "Organization" },
          repository_selection: "all", suspended_at: null }]), { status: 200 }),
      }, "org");
      webhook = db.transaction(async (tx) => {
        await tx.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, "org")).for("update");
        await tx.update(githubInstallations).set({ suspended: true }).where(eq(githubInstallations.id, "installation"));
        await invalidateWorkflowSources(tx, { orgId: "org" });
        locked.release();
        await resume.promise;
      });
      await Promise.race([locked.promise, webhook]);
      await expect(discover()).rejects.toMatchObject({ cause: { code: "55P03" } });
      resume.release();
      await webhook;
      const [suspended] = await db.select().from(contentSources).where(eq(contentSources.id, "source"));
      await discover();
      const [restored] = await db.select().from(contentSources).where(eq(contentSources.id, "source"));
      expect(restored.syncRevision).toBe(suspended.syncRevision + 1);
      expect(restored.discoveryScan).toBeNull();
      const [installation] = await db.select().from(githubInstallations);
      expect(installation.suspended).toBe(false);
    } finally {
      resume.release();
      await webhook?.catch(() => undefined);
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
});
