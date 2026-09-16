/** HTTP fixture for the sandbox bearer restart regression. No model or Docker is used. */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { join } from "node:path";
import {
  InMemoryCredentialStore,
  VirtualSandboxProvider,
  type SandboxCreateOpts,
} from "@valet/engine";
import { PgSessionStore, PgEventStream, pgDbFromPglite, applyEngineMigrations } from "@valet/store-postgres";
import { applyAppMigrations, buildAppDb } from "../src/lib/drizzle.js";
import { EngineHost } from "../src/engine/host.js";
import { buildAuthMiddleware } from "../src/middleware/auth.js";
import { FsBlobStore } from "../src/providers/blob-fs.js";
import { orgs, users, sandboxTokens } from "../src/schema/index.js";
import type { AppEnv } from "../src/env.js";

const sessionId = "sandbox-token-restart";

class RecordingProvider extends VirtualSandboxProvider {
  token: string | undefined;
  override async create(opts: SandboxCreateOpts) {
    this.token = opts.env?.VALET_SANDBOX_TOKEN;
    return super.create(opts);
  }
}

async function main() {
  const dataDir = process.argv[2];
  if (!dataDir) throw new Error("Pass the test database directory.");
  const pglite = new PGlite(dataDir);
  const pgdb = pgDbFromPglite(pglite);
  await applyAppMigrations(pgdb);
  await applyEngineMigrations(pgdb);
  const db = buildAppDb(pglite);
  await db.insert(orgs).values({ id: "restart-org", name: "Restart test", createdAt: Date.now() }).onConflictDoNothing();
  await db.insert(users).values({ id: "restart-user", email: "restart@test.invalid", name: "Restart test", role: "member" }).onConflictDoNothing();
  const provider = new RecordingProvider();
  const host = new EngineHost({
    engineStore: new PgSessionStore(pgdb),
    eventStream: new PgEventStream(pgdb),
    sandboxProvider: provider,
    engineCredentials: new InMemoryCredentialStore(),
    blobs: new FsBlobStore(join(dataDir, "blobs")),
    db,
    apiBaseUrl: "http://127.0.0.1:0",
    sandboxTokenMaster: "restart-regression-persistent-instance-key",
  });
  const app = new Hono<AppEnv>();
  app.use("/api/*", buildAuthMiddleware({ auth: null, db }));
  app.get("/api/sandbox/probe", (c) => c.json(c.var.sandbox));
  // Fixture-only controls expose the provider's captured environment to the parent test.
  app.post("/adopt", async (c) => {
    const session = await host.sessionFor(sessionId, {
      userId: "restart-user", orgId: "restart-org", workspace: "/tmp/sandbox-token-restart",
    });
    session.attachment.warm();
    const deadline = Date.now() + 10_000;
    while (session.attachment.state !== "ready") {
      if (Date.now() > deadline) throw new Error("Sandbox did not become ready. Inspect the fixture output.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const rows = await db.select({ id: sandboxTokens.id, revokedAt: sandboxTokens.revokedAt })
      .from(sandboxTokens).where(eq(sandboxTokens.sessionId, sessionId));
    return c.json({ token: provider.token, rows });
  });
  app.post("/destroy", async (c) => {
    await host.destroy(sessionId);
    return c.json({ destroyed: true });
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (address) => {
    process.send?.({ port: address.port });
  });
  process.once("SIGTERM", () => {
    server.close(() => {
      host.evictAll();
      pglite.close().then(() => process.exit(0), () => process.exit(1));
    });
    if ("closeAllConnections" in server) server.closeAllConnections();
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
