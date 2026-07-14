import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { CredentialOwner, StoredCredential } from "@valet/engine";
import { applyAppMigrations, buildAppDb, type AppDb } from "../lib/drizzle.js";
import { decryptSecret, deriveSecretKey, encryptSecret } from "../lib/secret-crypto.js";
import { SqliteCredentialStore } from "./credential-store.js";

/** Fresh in-memory sqlite DB per call, migrated the same way the app boots one. */
function makeStore(clock?: () => number): SqliteCredentialStore {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  applyAppMigrations(sqlite);
  const db = buildAppDb(sqlite) as AppDb & { $client: Database.Database };
  return new SqliteCredentialStore(db, deriveSecretKey("test-key"), clock);
}

/** Raw handle for reaching under the store to assert on the persisted row shape. */
function makeStoreWithSqlite(clock?: () => number): { store: SqliteCredentialStore; sqlite: Database.Database } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  applyAppMigrations(sqlite);
  const db = buildAppDb(sqlite) as AppDb & { $client: Database.Database };
  return { store: new SqliteCredentialStore(db, deriveSecretKey("test-key"), clock), sqlite };
}

const userOwner: CredentialOwner = { type: "user", id: "user-1" };
const otherOwner: CredentialOwner = { type: "user", id: "user-2" };

describe("SqliteCredentialStore", () => {
  it("round-trips a full StoredCredential (oauth2 with refresh, scopes, metadata) via save then get", async () => {
    const store = makeStore();
    const credential: StoredCredential = {
      type: "oauth2",
      accessToken: "tok-secret-123",
      refreshToken: "refresh-secret-456",
      expiresAt: 1_700_000_000_000,
      scopes: ["repo", "read:org"],
      metadata: { installationId: "42" },
    };

    await store.save(userOwner, "github", credential);
    const result = await store.get(userOwner, "github");

    expect(result).toEqual(credential);
  });

  it("returns null for a missing (owner, service)", async () => {
    const store = makeStore();
    const result = await store.get(userOwner, "github");
    expect(result).toBeNull();
  });

  it("overwrites on save (upsert) and updates updated_at", async () => {
    let now = 1_000;
    const { store, sqlite } = makeStoreWithSqlite(() => now);

    await store.save(userOwner, "github", { type: "api_key", apiKey: "key-v1" });
    const firstRow = sqlite
      .prepare(`SELECT created_at, updated_at FROM credentials WHERE owner_type = ? AND owner_id = ? AND service = ?`)
      .get(userOwner.type, userOwner.id, "github") as { created_at: number; updated_at: number };
    expect(firstRow.created_at).toBe(1_000);
    expect(firstRow.updated_at).toBe(1_000);

    now = 2_000;
    await store.save(userOwner, "github", { type: "api_key", apiKey: "key-v2" });

    const secondRow = sqlite
      .prepare(`SELECT created_at, updated_at FROM credentials WHERE owner_type = ? AND owner_id = ? AND service = ?`)
      .get(userOwner.type, userOwner.id, "github") as { created_at: number; updated_at: number };
    expect(secondRow.updated_at).toBe(2_000);

    const result = await store.get(userOwner, "github");
    expect(result?.apiKey).toBe("key-v2");

    // Still one row — not a duplicate insert.
    const count = sqlite.prepare(`SELECT COUNT(*) as n FROM credentials`).get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("delete removes the row; list returns entries scoped to the requesting owner only", async () => {
    const store = makeStore();

    await store.save(userOwner, "github", { type: "oauth2", accessToken: "tok-a", scopes: ["repo"] });
    await store.save(userOwner, "linear", { type: "api_key", apiKey: "tok-b" });
    await store.save(otherOwner, "github", { type: "oauth2", accessToken: "tok-c" });

    const listed = await store.list(userOwner);
    expect(listed).toHaveLength(2);
    expect(listed.map((c) => c.service).sort()).toEqual(["github", "linear"]);
    const githubEntry = listed.find((c) => c.service === "github");
    expect(githubEntry?.scopes).toEqual(["repo"]);
    expect(typeof githubEntry?.connectedAt).toBe("string");
    expect(new Date(githubEntry?.connectedAt ?? "").toString()).not.toBe("Invalid Date");

    await store.delete(userOwner, "github");
    const afterDelete = await store.get(userOwner, "github");
    expect(afterDelete).toBeNull();

    const listedAfterDelete = await store.list(userOwner);
    expect(listedAfterDelete.map((c) => c.service)).toEqual(["linear"]);

    // Other owner's credential is untouched.
    const otherResult = await store.get(otherOwner, "github");
    expect(otherResult?.accessToken).toBe("tok-c");
  });

  it("encrypts secrets at rest: raw SELECT of access_token_enc does not contain the plaintext token", async () => {
    const { store, sqlite } = makeStoreWithSqlite();
    await store.save(userOwner, "github", { type: "oauth2", accessToken: "tok-secret-123" });

    const row = sqlite
      .prepare(`SELECT access_token_enc FROM credentials WHERE owner_type = ? AND owner_id = ? AND service = ?`)
      .get(userOwner.type, userOwner.id, "github") as { access_token_enc: string };

    expect(row.access_token_enc).toEqual(expect.any(String));
    expect(row.access_token_enc).not.toContain("tok-secret-123");
    expect(row.access_token_enc.startsWith("v1:")).toBe(true);
  });
});

describe("secret-crypto", () => {
  it("decryptSecret(encryptSecret(x)) === x", () => {
    const key = deriveSecretKey("test-key");
    const ciphertext = encryptSecret("tok-secret-123", key);
    expect(decryptSecret(ciphertext, key)).toBe("tok-secret-123");
  });

  it("throws on tampered ciphertext", () => {
    const key = deriveSecretKey("test-key");
    const ciphertext = encryptSecret("tok-secret-123", key);
    const parts = ciphertext.split(":");
    // Flip the last character of the ciphertext segment to corrupt it.
    const corruptedCt = parts[3].slice(0, -1) + (parts[3].at(-1) === "A" ? "B" : "A");
    const tampered = [parts[0], parts[1], parts[2], corruptedCt].join(":");
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it("throws on malformed ciphertext format", () => {
    const key = deriveSecretKey("test-key");
    expect(() => decryptSecret("not-a-valid-format", key)).toThrow();
    expect(() => decryptSecret("v2:a:b:c", key)).toThrow();
  });
});
