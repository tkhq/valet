/** MCP registration limits across two api replicas. Set TEST_DATABASE_URL to a
 * disposable PostgreSQL database. Each run owns one schema; DATABASE_URL is
 * never used. PGlite cannot exercise this race because it serializes all
 * transactions. */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import type { AppEnv } from "../env.js";
import { applyAppMigrations, buildAppDb, buildAppQueryable, type AppDb } from "../lib/drizzle.js";
import { mcpRegistrations, oauthApplication } from "../schema/index.js";
import { DEFAULT_MCP_REGISTRATION, type McpRegistrationConfig } from "./config.js";
import type { mcpRegisterGate } from "./mcp-registration.js";

const connectionString = process.env.TEST_DATABASE_URL;
const LOOPBACK = "http://localhost:33418/callback";

// CI supplies TEST_DATABASE_URL in remote-postgres.yml. Ordinary unit runs skip.
describe.skipIf(!connectionString)("MCP registration limits across replicas (Postgres)", () => {
  const schema = `mcp_registration_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pools: Pool[] = [];
  let dbs: AppDb[] = [];
  // Each replica loads its own copy of the gate module, so no state held in
  // memory can stand in for the shared limits.
  let gates: (typeof mcpRegisterGate)[] = [];

  beforeAll(async () => {
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const options = `-c search_path=${schema} -c statement_timeout=15000`;
    // One pool for each replica, as two api processes would have.
    pools = [new Pool({ connectionString, options, max: 8 }), new Pool({ connectionString, options, max: 8 })];
    await applyAppMigrations(buildAppQueryable(pools[0]!));
    dbs = pools.map((pool) => buildAppDb(pool));
    for (let i = 0; i < 2; i++) {
      vi.resetModules();
      gates.push((await import("./mcp-registration.js")).mcpRegisterGate);
    }
    expect(gates[0]).not.toBe(gates[1]);
  });

  beforeEach(async () => {
    await dbs[0]!.delete(mcpRegistrations);
    await dbs[0]!.delete(oauthApplication);
  });

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    if (admin) {
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  });

  async function insertClient(db: AppDb): Promise<void> {
    const clientId = randomUUID();
    const now = new Date();
    await db.insert(oauthApplication).values({ id: `app-${clientId}`, name: "replica", clientId, redirectUrls: LOOPBACK, type: "public", createdAt: now, updatedAt: now });
  }

  /** One api replica: the gate, then a slow insert that stands in for better-auth. */
  function replica(i: number, cfg: McpRegistrationConfig): Hono<AppEnv> {
    const db = dbs[i]!;
    const app = new Hono<AppEnv>();
    app.post("/register", gates[i]!(db, cfg), async (c) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await insertClient(db);
      return c.json({}, 201);
    });
    return app;
  }

  /** Sends `count` registrations at once, alternating between the replicas. */
  async function race(apps: Hono<AppEnv>[], count: number): Promise<number[]> {
    const results = await Promise.all(Array.from({ length: count }, (_, i) => apps[i % apps.length]!.request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.7" },
      body: JSON.stringify({ redirect_uris: [LOOPBACK] }),
    })));
    return results.map((r) => r.status).sort();
  }

  it("admits one registration when two replicas race at cap - 1", async () => {
    const cfg = { ...DEFAULT_MCP_REGISTRATION, unconsentedCap: 3, ratePerHour: 0 };
    const apps = [replica(0, cfg), replica(1, cfg)];
    // Overlap depends on timing, so race several rounds.
    for (let round = 0; round < 5; round++) {
      await dbs[0]!.delete(mcpRegistrations);
      await dbs[0]!.delete(oauthApplication);
      await insertClient(dbs[0]!);
      await insertClient(dbs[0]!);
      expect(await race(apps, 8), `round ${round}`).toEqual([201, 429, 429, 429, 429, 429, 429, 429]);
      expect((await dbs[0]!.select().from(oauthApplication)).length).toBe(3);
    }
  });

  it("shares the per-address hourly limit between replicas", async () => {
    const cfg = { ...DEFAULT_MCP_REGISTRATION, unconsentedCap: 0, ratePerHour: 2 };
    const apps = [replica(0, cfg), replica(1, cfg)];
    expect(await race(apps, 8)).toEqual([201, 201, 429, 429, 429, 429, 429, 429]);
    expect((await dbs[0]!.select().from(oauthApplication)).length).toBe(2);
  });
});
