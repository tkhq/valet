import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import type { CredentialOwner } from "@valet/engine";
import { pgDbFromPglite, type PgDb } from "@valet/store-postgres";
import { applyAppMigrations } from "../lib/drizzle.js";
import { decryptSecret, deriveSecretKey, encryptSecret } from "../lib/secret-crypto.js";
import { describeCredentialStoreContract } from "./credential-store-contract.js";
import { PgCredentialStore } from "./credential-store.js";

// Tables `PgCredentialStore` touches. Truncating between contract tests
// gives each one the same blank-slate guarantee a fresh `:memory:` sqlite
// db gave the old `SqliteCredentialStore` suite (decision 11 of
// docs/specs/2026-07-15-postgres-backend-design.md).
async function truncateAll(db: PgDb): Promise<void> {
  await db.query(`TRUNCATE credentials`);
}

const userOwner: CredentialOwner = { type: "user", id: "user-1" };

describe("PgCredentialStore", () => {
  const pglite = new PGlite();
  const db = pgDbFromPglite(pglite);
  let migrated = false;

  afterAll(async () => {
    await db.close();
  });

  async function freshStore(clock?: () => number): Promise<PgCredentialStore> {
    if (!migrated) {
      await applyAppMigrations(db);
      migrated = true;
    } else {
      await truncateAll(db);
    }
    return new PgCredentialStore(db, deriveSecretKey("test-key"), clock);
  }

  describeCredentialStoreContract(() => freshStore());

  it("overwrites on save (upsert) and updates updated_at; still exactly one row", async () => {
    let now = 1_000;
    const store = await freshStore(() => now);

    await store.save(userOwner, "github", { type: "api_key", apiKey: "key-v1" });
    const firstRowResult = await db.query(
      `SELECT created_at, updated_at FROM credentials WHERE owner_type = $1 AND owner_id = $2 AND service = $3`,
      [userOwner.type, userOwner.id, "github"],
    );
    const firstRow = firstRowResult.rows[0] as { created_at: string | number; updated_at: string | number };
    expect(Number(firstRow.created_at)).toBe(1_000);
    expect(Number(firstRow.updated_at)).toBe(1_000);

    now = 2_000;
    await store.save(userOwner, "github", { type: "api_key", apiKey: "key-v2" });

    const secondRowResult = await db.query(
      `SELECT created_at, updated_at FROM credentials WHERE owner_type = $1 AND owner_id = $2 AND service = $3`,
      [userOwner.type, userOwner.id, "github"],
    );
    const secondRow = secondRowResult.rows[0] as { created_at: string | number; updated_at: string | number };
    expect(Number(secondRow.updated_at)).toBe(2_000);

    const result = await store.get(userOwner, "github");
    expect(result?.apiKey).toBe("key-v2");

    const countResult = await db.query(`SELECT COUNT(*) as n FROM credentials`);
    const count = countResult.rows[0] as { n: string | number };
    expect(Number(count.n)).toBe(1);
  });

  it("encrypts secrets at rest: raw SELECT of access_token_enc does not contain the plaintext token", async () => {
    const store = await freshStore();
    await store.save(userOwner, "github", { type: "oauth2", accessToken: "tok-secret-123" });

    const rowResult = await db.query(
      `SELECT access_token_enc FROM credentials WHERE owner_type = $1 AND owner_id = $2 AND service = $3`,
      [userOwner.type, userOwner.id, "github"],
    );
    const row = rowResult.rows[0] as { access_token_enc: string };

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
