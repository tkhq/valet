/** Run with ARTIFACT_MEMBERSHIP_POSTGRES=1. This suite creates and removes its
 * own disposable Postgres container; it never uses DATABASE_URL or real data. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { NotFoundError } from "@valet/shared";
import { applyAppMigrations, buildAppDb, buildAppQueryable, type AppDb } from "../lib/drizzle.js";
import { artifacts, artifactVersions, orgMembers, teamMembers, teams } from "../schema/index.js";
import { copyArtifactToTeam, publishArtifact, revokeArtifactByPath } from "./artifacts.js";

const enabled = process.env.ARTIFACT_MEMBERSHIP_POSTGRES === "1";

function latch() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe.skipIf(!enabled)("artifact membership commit ordering (Postgres)", () => {
  let container: string | undefined;
  let control: Pool;
  let mutationPool: Pool;
  let revocationPool: Pool;
  let db: AppDb;
  let mutationDb: AppDb;
  let revocationDb: AppDb;

  beforeAll(async () => {
    container = execFileSync("docker", ["run", "--rm", "-d", "-e", "POSTGRES_PASSWORD=fixture",
      "-p", "127.0.0.1::5432", "postgres:16-alpine"], { encoding: "utf8" }).trim();
    const address = execFileSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" }).trim();
    const connectionString = `postgres://postgres:fixture@${address}/postgres`;
    control = new Pool({ connectionString, max: 1 });
    mutationPool = new Pool({ connectionString, max: 1, application_name: "artifact-mutation" });
    revocationPool = new Pool({ connectionString, max: 1, application_name: "membership-revocation" });
    const deadline = Date.now() + 30_000;
    while (true) {
      try { await control.query("select 1"); break; }
      catch (error) { if (Date.now() > deadline) throw error; await delay(50); }
    }
    await applyAppMigrations(buildAppQueryable(control));
    db = buildAppDb(control);
    mutationDb = buildAppDb(mutationPool);
    revocationDb = buildAppDb(revocationPool);
  });

  afterAll(async () => {
    try {
      await Promise.all([control?.end(), mutationPool?.end(), revocationPool?.end()]);
    } finally {
      if (container) execFileSync("docker", ["rm", "-f", container]);
    }
  });

  // Observe a real conflicting row lock, rather than assuming a timed sleep
  // means a concurrent transaction reached its authorization check.
  async function waitForBlocked(application: string) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await control.query<{ blocked: boolean }>(
        "select cardinality(pg_blocking_pids(pid)) > 0 as blocked from pg_stat_activity where application_name = $1",
        [application],
      );
      if (result.rows.some((row) => row.blocked)) return;
      await delay(10);
    }
    throw new Error(`${application} did not wait for the authorizing membership lock`);
  }

  for (const membership of ["org", "team"] as const) {
    for (const operation of ["create", "refresh", "revoke", "copy"] as const) {
      for (const first of ["mutation", "revocation"] as const) {
        it(`${operation}: ${membership} membership ${first} commits first`, async () => {
          const id = randomUUID();
          const scope = { owner: { type: "team", id }, actorUserId: id } as const;
          await db.insert(teams).values({ id, orgId: id, name: id, createdAt: 1 });
          await db.insert(orgMembers).values({ orgId: id, userId: id, role: "member" });
          await db.insert(teamMembers).values({ teamId: id, userId: id, role: "member" });
          const source = await publishArtifact(db, {
            owner: { type: "user", id }, actorUserId: id,
          }, { orgId: id, key: "source.md", content: "original", format: "markdown" });
          if (operation === "refresh" || operation === "revoke") {
            await publishArtifact(db, scope, { orgId: id, key: "target.md", content: "original", format: "markdown" });
          }
          const before = await db.select().from(artifacts).where(eq(artifacts.ownerId, id));
          const versionsBefore = await db.select().from(artifactVersions)
            .where(eq(artifactVersions.actorUserId, id));
          const mutate = (tx: AppDb) => operation === "revoke"
            ? revokeArtifactByPath(tx, scope, "target.md", id)
            : operation === "copy"
              ? copyArtifactToTeam(tx, { owner: { type: "user", id }, actorUserId: id }, id,
                { artifactId: source.id, teamId: id, key: "target.md" })
              : publishArtifact(tx, scope, { orgId: id, key: "target.md", content: "updated", format: "markdown" });
          const revoke = async (tx: AppDb) => {
            if (membership === "org") await tx.delete(orgMembers).where(eq(orgMembers.orgId, id));
            else await tx.delete(teamMembers).where(eq(teamMembers.teamId, id));
          };
          const ready = latch();
          const commit = latch();
          // The outer transaction lets the test pause just before commit. The
          // service's nested transaction uses the same connection and row locks.
          const leading = (first === "mutation" ? mutationDb : revocationDb).transaction(async (tx) => {
            if (first === "mutation") await mutate(tx);
            else await revoke(tx);
            ready.release();
            await commit.promise;
          });
          // Attach rejection handlers before waiting on either transaction.
          const leadingResult = leading.then(() => ({ error: undefined }), (error: unknown) => ({ error }));
          let trailingResult: Promise<{ error: unknown }> | undefined;
          try {
            await Promise.race([ready.promise, leading.then(() => { throw new Error("No commit barrier"); })]);
            const trailing = first === "mutation"
              ? revocationDb.transaction(revoke)
              : mutate(mutationDb);
            trailingResult = trailing.then(() => ({ error: undefined }), (error: unknown) => ({ error }));
            await waitForBlocked(first === "mutation" ? "membership-revocation" : "artifact-mutation");
          } finally {
            commit.release();
            await leadingResult;
            await trailingResult;
          }
          expect((await leadingResult).error).toBeUndefined();
          if (!trailingResult) throw new Error("Trailing transaction did not start");
          const result = await trailingResult;
          const after = await db.select().from(artifacts).where(eq(artifacts.ownerId, id));
          if (first === "revocation") {
            expect(result.error).toBeInstanceOf(NotFoundError);
            expect(after).toEqual(before);
            expect(await db.select().from(artifactVersions).where(eq(artifactVersions.actorUserId, id))).toEqual(versionsBefore);
          } else {
            expect(result.error).toBeUndefined();
            const target = after.find((row) => row.ownerType === "team");
            expect(target).toBeDefined();
            if (operation === "revoke") expect(target?.revokedAt).not.toBeNull();
            else expect(target).toMatchObject({ version: operation === "refresh" ? 2 : 1, revokedAt: null });
          }
        });
      }
    }
  }
});
