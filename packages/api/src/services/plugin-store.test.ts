import { beforeEach, describe, expect, it } from "vitest";
import { PluginStoreConflictError } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { ensurePluginStoreIndexes, pluginStore } from "./plugin-store.js";

interface Settings {
  theme: string;
  count: number;
}

describe("plugin store", () => {
  let db: AppDb;

  beforeEach(async () => {
    const h = await freshTestPgDb();
    db = h.appDb;
  });

  it("round-trips a typed doc through put/get", async () => {
    const store = pluginStore(db, "acme").org("org_1");
    const put = await store.put<Settings>("settings", "prefs", { theme: "dark", count: 3 });
    expect(put.doc).toEqual({ theme: "dark", count: 3 });
    expect(put.revision).toBe(1);
    expect(put.key).toBe("prefs");

    const got = await store.get<Settings>("settings", "prefs");
    expect(got).not.toBeNull();
    expect(got?.doc).toEqual({ theme: "dark", count: 3 });
    expect(got?.revision).toBe(1);
    expect(got?.createdAt).toBe(put.createdAt);
  });

  it("get returns null when absent", async () => {
    const store = pluginStore(db, "acme").org("org_1");
    expect(await store.get("settings", "missing")).toBeNull();
  });

  it("put bumps the revision on an existing key", async () => {
    const store = pluginStore(db, "acme").org("org_1");
    const first = await store.put<Settings>("settings", "prefs", { theme: "dark", count: 1 });
    expect(first.revision).toBe(1);
    const second = await store.put<Settings>("settings", "prefs", { theme: "light", count: 2 });
    expect(second.revision).toBe(2);
    expect(second.doc).toEqual({ theme: "light", count: 2 });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });

  it("ifRevision conflict throws PluginStoreConflictError", async () => {
    const store = pluginStore(db, "acme").org("org_1");
    await store.put<Settings>("settings", "prefs", { theme: "dark", count: 1 });
    // Stored revision is now 1; a write asserting revision 5 must conflict.
    await expect(
      store.put<Settings>("settings", "prefs", { theme: "x", count: 9 }, { ifRevision: 5 }),
    ).rejects.toBeInstanceOf(PluginStoreConflictError);
    // A matching ifRevision succeeds and bumps to 2.
    const ok = await store.put<Settings>("settings", "prefs", { theme: "x", count: 9 }, { ifRevision: 1 });
    expect(ok.revision).toBe(2);
  });

  it("ifRevision against a missing row conflicts", async () => {
    const store = pluginStore(db, "acme").org("org_1");
    await expect(
      store.put<Settings>("settings", "new", { theme: "d", count: 0 }, { ifRevision: 1 }),
    ).rejects.toBeInstanceOf(PluginStoreConflictError);
  });

  it("lists by prefix in key order and paginates with a cursor", async () => {
    const store = pluginStore(db, "acme").org("org_1");
    // Two prefixes; insert out of order to prove ordering by key.
    for (const key of ["config:b", "config:a", "config:c", "other:z"]) {
      await store.put<number>("kv", key, key.length);
    }

    const first = await store.list<number>("kv", { prefix: "config:", limit: 2 });
    expect(first.items.map((i) => i.key)).toEqual(["config:a", "config:b"]);
    expect(first.nextCursor).not.toBeNull();

    const second = await store.list<number>("kv", {
      prefix: "config:",
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((i) => i.key)).toEqual(["config:c"]);
    expect(second.nextCursor).toBeNull();
    // The `other:` key never appears under the config prefix.
    const all = await store.list<number>("kv", { prefix: "config:" });
    expect(all.items.map((i) => i.key)).toEqual(["config:a", "config:b", "config:c"]);
  });

  it("delete returns true then false", async () => {
    const store = pluginStore(db, "acme").org("org_1");
    await store.put<number>("kv", "k", 1);
    expect(await store.delete("kv", "k")).toBe(true);
    expect(await store.delete("kv", "k")).toBe(false);
    expect(await store.get("kv", "k")).toBeNull();
  });

  it("isolates rows by plugin name", async () => {
    await pluginStore(db, "acme").org("org_1").put<number>("kv", "shared", 1);
    await pluginStore(db, "other").org("org_1").put<number>("kv", "shared", 2);
    // Same scope, collection, and key — but different plugins never collide.
    expect((await pluginStore(db, "acme").org("org_1").get<number>("kv", "shared"))?.doc).toBe(1);
    expect((await pluginStore(db, "other").org("org_1").get<number>("kv", "shared"))?.doc).toBe(2);
    // A list is scoped to the plugin.
    const acme = await pluginStore(db, "acme").org("org_1").list<number>("kv");
    expect(acme.items).toHaveLength(1);
  });

  it("isolates rows by scope (org vs user vs global)", async () => {
    const store = pluginStore(db, "acme");
    await store.org("org_1").put<string>("kv", "k", "org");
    await store.user("user_1").put<string>("kv", "k", "user");
    await store.global().put<string>("kv", "k", "global");

    expect((await store.org("org_1").get<string>("kv", "k"))?.doc).toBe("org");
    expect((await store.user("user_1").get<string>("kv", "k"))?.doc).toBe("user");
    expect((await store.global().get<string>("kv", "k"))?.doc).toBe("global");
    // A different org id sees nothing.
    expect(await store.org("org_2").get("kv", "k")).toBeNull();
  });

  it("ensurePluginStoreIndexes creates a declared index idempotently", async () => {
    const { pgdb } = await freshTestPgDb();
    const plugin = {
      name: "findings_plugin",
      version: "1.0.0",
      storeIndexes: [{ collection: "findings", field: "severity" }],
    };
    // Run twice — the second run is a no-op (CREATE INDEX IF NOT EXISTS).
    await ensurePluginStoreIndexes(pgdb, [plugin]);
    await ensurePluginStoreIndexes(pgdb, [plugin]);

    const indexName = "plugin_store_findings_plugin_findings_severity";
    const result = await pgdb.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1",
      [indexName],
    );
    expect(result.rows).toHaveLength(1);
  });
});
