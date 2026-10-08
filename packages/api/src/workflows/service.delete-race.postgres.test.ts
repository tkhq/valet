/** Real row-lock regression. Set TEST_DATABASE_URL to a disposable PostgreSQL
 * database. Each run owns one schema; DATABASE_URL is never used. PGlite cannot
 * exercise these races because it serializes all transactions. */
import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { InMemoryCredentialStore, InMemorySessionStore } from "@valet/engine";
import type { PgDb } from "@valet/store-postgres";
import { applyAppMigrations, buildAppDb, buildAppQueryable, type AppDb } from "../lib/drizzle.js";
import { contentSources, workflowDefinitions, workflowSchedules } from "../schema/index.js";
import { WorkflowCollector } from "../services/content-sync/workflow-collector.js";
import { createWorkflowDefinition, deleteWorkflowDefinition, type WorkflowServiceDeps } from "./service.js";
import { PgWorkflowStore } from "./pg-store.js";

const connectionString = process.env.TEST_DATABASE_URL;
const owner = { userId: "race-user", orgId: "race-org" };
const definition = { version: "dag/v1", nodes: [], edges: [] };

function latch() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function outcome<T>(promise: Promise<T>) {
  return promise.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
}

// CI supplies TEST_DATABASE_URL in remote-postgres.yml. Ordinary unit runs skip.
describe.skipIf(!connectionString)("workflow start/delete commit ordering (Postgres)", () => {
  const schema = `workflow_race_${randomUUID().replaceAll("-", "")}`;
  const startName = `${schema}_start`;
  const deleteName = `${schema}_delete`;
  let admin: Pool;
  let control: Pool;
  let startPool: Pool;
  let deletePool: Pool;
  let db: AppDb;
  let deleteDb: AppDb;
  let startPg: PgDb;

  beforeAll(async () => {
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    // Exclude public: CI runs the store contract in that schema first.
    const options = `-c search_path=${schema} -c statement_timeout=15000`;
    control = new Pool({ connectionString, options, max: 1 });
    startPool = new Pool({ connectionString, options, max: 1, application_name: startName });
    deletePool = new Pool({ connectionString, options, max: 1, application_name: deleteName });
    await applyAppMigrations(buildAppQueryable(control));
    db = buildAppDb(control);
    deleteDb = buildAppDb(deletePool);
    startPg = buildAppQueryable(startPool);
  });

  afterAll(async () => {
    await Promise.all([control?.end(), startPool?.end(), deletePool?.end()]);
    if (admin) {
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  });

  function deps(appDb: AppDb): WorkflowServiceDeps {
    return {
      db: appDb,
      workflowStore: new PgWorkflowStore(startPg),
      workflowRunHost: { async start() {}, async wake() {}, async scheduleWake() {},
        async terminate() {}, startHost() {}, async stopHost() {} },
      engineStore: new InMemorySessionStore(),
      credentials: new InMemoryCredentialStore(),
    };
  }

  async function waitForBlocked(waiter: string, blocker: string) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await control.query<{ blocked: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity waiting, pg_stat_activity holding
          WHERE waiting.application_name = $1 AND holding.application_name = $2
            AND holding.pid = ANY(pg_blocking_pids(waiting.pid))
            AND waiting.wait_event_type = 'Lock'
        ) AS blocked`, [waiter, blocker],
      );
      if (result.rows[0]?.blocked) return;
      await nextTurn();
    }
    throw new Error(`${waiter} did not block on ${blocker}'s transaction`);
  }

  for (const cleanup of ["definition", "repository"] as const) {
    for (const first of ["start", "delete"] as const) {
      it(`${cleanup}: ${first} commits first`, async () => {
        const id = randomUUID();
        const def = await createWorkflowDefinition(deps(db), owner, { name: id, definition });
        let remove: (tx: AppDb) => Promise<unknown> = tx => deleteWorkflowDefinition(deps(tx), owner, def.id);
        if (cleanup === "repository") {
          const [source] = await db.insert(contentSources).values({
            id, orgId: owner.orgId, ownerType: "org", ownerId: owner.orgId,
            repoFullName: `test/${id}`, kinds: ["workflows"], nextAttemptAt: 1, createdAt: 1, updatedAt: 1,
          }).returning();
          await db.update(workflowDefinitions).set({ ownerType: "org", ownerId: owner.orgId,
            origin: "repo", sourceId: id, upstreamPath: ".valet/workflows/gone.yaml" })
            .where(eq(workflowDefinitions.id, def.id));
          const collector = new WorkflowCollector({ plugins: [], credentials: new InMemoryCredentialStore() });
          const pass = collector.discover({ entries: [], source });
          remove = tx => pass.reconcile({ db: tx, source, text: new Map(), discovery: "tree", commitSha: "removed", now: () => 1 });
        }
        await db.insert(workflowSchedules).values({ id, orgId: owner.orgId, ownerType: "user",
          ownerId: owner.userId, workflowId: def.id, name: id, cron: "0 9 * * *", nextFireAt: 1,
          createdBy: owner.userId, createdAt: 1, updatedAt: 1 });

        const ready = latch();
        const commit = latch();
        // Pause inside the real transaction, after production writes and before
        // commit. Only the commit boundary is wrapped; SQL and locks are real.
        const heldPg: PgDb = { ...startPg, transaction: fn => startPg.transaction(async tx => {
          const result = await fn(tx);
          ready.release();
          await commit.promise;
          return result;
        }) };
        const start = (pg: PgDb) => new PgWorkflowStore(pg).createRun(id,
          { workflowId: def.id, definitionVersionId: "v1" }, definition, "v1",
          { ownerType: "user", ownerId: owner.userId });
        const leading = first === "start" ? start(heldPg) : deleteDb.transaction(async tx => {
          const result = await remove(tx);
          ready.release();
          await commit.promise;
          return result;
        });
        const leadingResult = outcome(leading);
        let trailingResult: ReturnType<typeof outcome<unknown>> | undefined;
        try {
          await Promise.race([ready.promise, leading.then(() => { throw new Error("Missing commit barrier"); })]);
          trailingResult = outcome(first === "start" ? remove(deleteDb) : start(startPg));
          await waitForBlocked(first === "start" ? deleteName : startName, first === "start" ? startName : deleteName);
        } finally {
          commit.release();
          await leadingResult;
          await trailingResult;
        }
        expect((await leadingResult).error).toBeUndefined();
        if (!trailingResult) throw new Error("Trailing transaction did not start");
        const trailing = await trailingResult;
        const remaining = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, def.id));
        const run = await new PgWorkflowStore(startPg).getRun(id);
        const schedules = await db.select().from(workflowSchedules).where(eq(workflowSchedules.workflowId, def.id));
        if (first === "delete") {
          expect(trailing.error).toBeInstanceOf(Error);
          expect((trailing.error as Error).message).toMatch(/was deleted before the run could start/);
          expect(remaining).toHaveLength(0);
          expect(run).toBeNull();
          expect(schedules).toHaveLength(0);
        } else {
          expect(trailing.error).toBeUndefined();
          expect(remaining).toHaveLength(1);
          expect(run).toMatchObject({ status: "pending", owner: { ownerType: "user", ownerId: owner.userId } });
          if (cleanup === "definition") {
            expect(trailing.value).toBe("has_active_runs");
            expect(schedules).toHaveLength(1);
          } else {
            expect(trailing.value).toMatchObject({ deleted: 0, deferred: [id] });
            expect(schedules).toHaveLength(0);
          }
        }
      });
    }
  }
});
