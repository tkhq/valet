/** Cross-connection locking needs PostgreSQL; PGlite serializes transactions. */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { buildAppDb } from "../../lib/drizzle.js";
import { contentSources } from "../../schema/index.js";
import { ContentSyncService } from "./service.js";
import type { ContentCollector } from "./collector.js";
import { invalidateWorkflowSources } from "./invalidation.js";

function barrier() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("content sync PostgreSQL fencing", () => {
  it("commits the mirror before a concurrent invalidation, leaving a durable full pass", async () => {
    const connectionString = process.env.TEST_DATABASE_URL;
    const schema = `sync_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 3 });
    const db = buildAppDb(pool);
    const written = barrier();
    const resume = barrier();
    let running: ReturnType<ContentSyncService["syncOnce"]> | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      // Use the maintained table definition, without creating unrelated tables.
      const migration = readFileSync(new URL("../../../migrations/pg/0000_app.sql", import.meta.url), "utf8");
      const table = migration.split(/-->\s*statement-breakpoint/).find((statement) => statement.includes('CREATE TABLE "skill_sources"'));
      if (!table) throw new Error("Missing skill_sources migration");
      await pool.query(table);
      await pool.query("CREATE TABLE mirror_probe (revision bigint)");
      await db.insert(contentSources).values({
        id: "source", orgId: "org", ownerType: "team", ownerId: "team", repoFullName: "test/repo", kinds: ["workflows"],
        nextAttemptAt: 0, createdAt: 0, updatedAt: 0,
      });
      let pause = true;
      const collector: ContentCollector = {
        kind: "workflows",
        discover: () => ({
          kind: "workflows",
          readEntries: [], manifestEntries: [], text: new Map<string, string>(), warnings: [], discovered: 0, excluded: 0,
          unreadWarning: () => "", notice: () => null,
          reconcile: async ({ db, source }) => {
            await db.execute(sql`INSERT INTO mirror_probe (revision) VALUES (${source.syncRevision})`);
            if (pause) {
              written.release();
              await resume.promise;
            }
            return { imported: 1, updated: 0, deleted: 0, keptStale: [], warnings: [] };
          },
        }),
      };
      const service = () => new ContentSyncService({ db, collectors: [collector], reader: {
        head: async () => ({ sha: "unchanged", treeSha: "tree" }),
        listTree: async () => ({ entries: [], truncated: false }),
        readFile: async () => null,
        listDirectory: async () => ({ entries: [], complete: true }),
      } });
      running = service().syncOnce("source");
      await Promise.race([written.promise, running]);
      const writer = await pool.connect();
      try {
        await writer.query("SET lock_timeout = '100ms'");
        // A writer on another connection cannot change the fence while the
        // old pass is writing mirrored rows and completion in one transaction.
        await expect(writer.query("UPDATE skill_sources SET sync_revision = sync_revision + 1 WHERE id = 'source'"))
          .rejects.toMatchObject({ code: "55P03" });
      } finally {
        writer.release();
        resume.release();
      }
      expect((await running)?.status).toBe("ok");
      await invalidateWorkflowSources(db, { teamId: "team" });
      const [pending] = await db.select().from(contentSources).where(eq(contentSources.id, "source"));
      expect(pending).toMatchObject({ discoveryScan: null, lastManifestHash: null });
      expect(pending.nextAttemptAt).toBeLessThanOrEqual(Date.now());
      pause = false;
      await service().pollOnce();
      expect((await pool.query("SELECT * FROM mirror_probe")).rows).toHaveLength(2);
    } finally {
      resume.release();
      await running?.catch(() => undefined);
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
});
