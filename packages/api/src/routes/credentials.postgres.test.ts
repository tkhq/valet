/** Real credential commit ordering. Each run owns its schema. Only the
 * disposable TEST_DATABASE_URL is used; PGlite cannot prove lock ordering. */
import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Pool } from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PgDb } from "@valet/store-postgres";
import { applyAppMigrations, buildAppDb, buildAppQueryable, type AppDb } from "../lib/drizzle.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { orgMembers, orgs, teamMembers, teams, users } from "../schema/index.js";
import type { AppEnv } from "../env.js";
import { listTeamShares } from "../services/credential-shares.js";
import { credentialsRouter } from "./credentials.js";

const connectionString = process.env.TEST_DATABASE_URL;
function latch() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function outcome<T>(promise: Promise<T> | T) {
  return Promise.resolve(promise).then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
}

describe.skipIf(!connectionString)("credential admission commit ordering (Postgres)", () => {
  const schema = `credential_race_${randomUUID().replaceAll("-", "")}`;
  const shareName = `${schema}_share`;
  const writerName = `${schema}_writer`;
  let admin: Pool;
  let control: Pool;
  let sharePool: Pool;
  let writerPool: Pool;
  let shareDb: AppDb;
  let writerDb: AppDb;
  let controlDb: AppDb;
  let sharePg: PgDb;
  let writerPg: PgDb;
  let api: TestApi;

  beforeAll(async () => {
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const options = `-c search_path=${schema} -c statement_timeout=15000`;
    control = new Pool({ connectionString, options, max: 1 });
    sharePool = new Pool({ connectionString, options, max: 1, application_name: shareName });
    writerPool = new Pool({ connectionString, options, max: 1, application_name: writerName });
    await applyAppMigrations(buildAppQueryable(control));
    controlDb = buildAppDb(control);
    shareDb = buildAppDb(sharePool);
    writerDb = buildAppDb(writerPool);
    sharePg = buildAppQueryable(sharePool);
    writerPg = buildAppQueryable(writerPool);
    await controlDb.insert(orgs).values({ id: "org", name: "Credential races", createdAt: 1 });
    for (const id of ["admin", "member"]) {
      await controlDb.insert(users).values({ id, email: `${id}@credential.test`, name: id });
      await controlDb.insert(orgMembers).values({ orgId: "org", userId: id, role: id === "admin" ? "admin" : "member", createdAt: 1 });
    }
    api = await bootTestApi();
    await api.providers.contentSync.stop();
  });

  afterAll(async () => {
    await api?.cleanup();
    await Promise.all([control?.end(), sharePool?.end(), writerPool?.end()]);
    if (admin) {
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  });

  function appFor(db: AppDb, pg: PgDb, actor: "admin" | "member") {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { id: actor, orgId: "org", email: `${actor}@credential.test`, role: actor });
      c.set("providers", { ...api.providers, db, engineCredentials: new PgCredentialStore(pg, deriveSecretKey("test-key")) });
      await next();
    });
    app.route("/api/credentials", credentialsRouter);
    return app;
  }

  async function waitForBlocked(waiter: string, blocker: string) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await control.query<{ blocked: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity waiting, pg_stat_activity holding
        WHERE waiting.application_name = $1 AND holding.application_name = $2
          AND holding.pid = ANY(pg_blocking_pids(waiting.pid))
          AND waiting.wait_event_type = 'Lock'
      ) AS blocked`, [waiter, blocker]);
      if (result.rows[0]?.blocked) return;
      await nextTurn();
    }
    throw new Error(`${waiter} did not block on ${blocker}`);
  }

  for (const mutation of ["reconnect", "delete"] as const) {
    for (const refresh of ["success", "refused"] as const) {
      it(`conditional ${refresh} update preserves a ${mutation} that commits while its UPDATE waits`, async () => {
        const service = randomUUID();
        const owner = { type: "user" as const, id: "member" };
        const key = deriveSecretKey("test-key");
        const store = new PgCredentialStore(sharePg, key, () => 7);
        await store.save(owner, service, { type: "oauth2", accessToken: "old", refreshToken: "rt", expiresAt: 1, metadata: { login: "old" } });
        const expected = await store.get(owner, service);
        if (!expected) throw new Error("Missing seeded credential");
        const ready = latch();
        const commit = latch();
        const writer = outcome(writerPg.transaction(async tx => {
          const competing = new PgCredentialStore(tx, key, () => 7);
          if (mutation === "delete") await competing.delete(owner, service);
          else await competing.save(owner, service, { ...expected, metadata: { login: "new" } });
          ready.release();
          await commit.promise;
        }));
        let update: ReturnType<typeof outcome<boolean>> | undefined;
        try {
          await Promise.race([ready.promise, writer.then(result => { throw new Error(`Missing mutation barrier: ${result.error}`); })]);
          update = outcome(store.compareAndSwap(owner, service, expected, refresh === "success"
            ? { ...expected, accessToken: "refreshed-old-grant" }
            : { ...expected, metadata: { ...expected.metadata, refreshRefused: true } }));
          await waitForBlocked(shareName, writerName);
        } finally {
          commit.release();
          await writer;
          await update;
        }
        expect((await writer).error).toBeUndefined();
        if (!update) throw new Error("Missing conditional update");
        expect(await update).toEqual({ value: false, error: undefined });
        const current = await store.get(owner, service);
        if (mutation === "delete") expect(current).toBeNull();
        else expect(current).toMatchObject({ accessToken: "old", metadata: { login: "new" } });
        expect(current?.metadata?.refreshRefused).toBeUndefined();
      });
    }
  }

  for (const writer of ["create", "replace", "reference", "delete"] as const) {
    for (const first of ["share", "writer"] as const) {
      it(`${writer}: ${first} commits first`, async () => {
        const teamId = randomUUID();
        await controlDb.insert(teams).values({ id: teamId, orgId: "org", name: teamId, createdAt: 1 });
        await controlDb.insert(teamMembers).values([{ teamId, userId: "admin", role: "admin" }, { teamId, userId: "member", role: "member" }]);
        const store = new PgCredentialStore(buildAppQueryable(control), deriveSecretKey("test-key"));
        await store.save({ type: "user", id: "member" }, "linear", { type: "api_key", apiKey: "member-key" });
        if (writer !== "create") await store.save({ type: "team", id: teamId }, "linear", {
          type: "oauth2", accessToken: "expired", expiresAt: 1,
        });
        // A reference resolves before the database mutation. Only the external
        // vault read is stubbed; its production route and SQL remain real.
        const resolve = vi.spyOn(api.providers.onePassword, "resolveReference").mockResolvedValue("vault-secret");
        const shareApp = appFor(shareDb, sharePg, "member");
        const writerApp = appFor(writerDb, writerPg, "admin");
        const share = () => shareApp.request("/api/credentials/linear/delegate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ teamId }) });
        const write = () => writer === "delete"
          ? writerApp.request(`/api/credentials/linear?scope=team&teamId=${teamId}`, { method: "DELETE" })
          : writerApp.request("/api/credentials/linear", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
            scope: "team", teamId, type: "api_key", createOnly: writer === "create",
            ...(writer === "reference" ? { onepassword: { reference: "op://Shared/Linear/token", tokenScope: "org" } } : { apiKey: "new-team" }),
          }) });
        const ready = latch();
        const commit = latch();
        const heldDb = first === "share" ? shareDb : writerDb;
        const transaction = heldDb.transaction.bind(heldDb);
        const hold = vi.spyOn(heldDb, "transaction").mockImplementation((fn, config) => transaction(async tx => {
          const result = await fn(tx);
          ready.release();
          await commit.promise;
          return result;
        }, config));
        const leading = outcome(first === "share" ? share() : write());
        let trailing: ReturnType<typeof outcome<Response>> | undefined;
        try {
          await Promise.race([ready.promise, leading.then(result => { throw new Error(`Missing transaction barrier: ${result.value?.status ?? result.error}`); })]);
          trailing = outcome(first === "share" ? write() : share());
          await waitForBlocked(first === "share" ? writerName : shareName, first === "share" ? shareName : writerName);
        } finally {
          commit.release();
          await leading;
          await trailing;
          hold.mockRestore();
          resolve.mockRestore();
        }
        const leadResult = await leading;
        if (!trailing) throw new Error("Missing trailing request");
        const trailResult = await trailing;
        expect(leadResult.error).toBeUndefined();
        expect(trailResult.error).toBeUndefined();
        const shareResponse = first === "share" ? leadResult.value : trailResult.value;
        const writeResponse = first === "writer" ? leadResult.value : trailResult.value;
        expect(writeResponse?.status).toBe(200);
        const expectedShare = first === "writer" && writer !== "delete" ? 409 : 201;
        expect(shareResponse?.status).toBe(expectedShare);
        expect(await listTeamShares(controlDb, teamId)).toHaveLength(expectedShare === 201 ? 1 : 0);
      });
    }
  }
});
