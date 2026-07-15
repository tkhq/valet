/**
 * `CredentialStore` conformance suite (Task 8 of the postgres-backend plan,
 * docs/specs/2026-07-15-postgres-backend-design.md — extracted from the
 * original `SqliteCredentialStore` ad-hoc test so `PgCredentialStore` and
 * any future backend share the same coverage). Exercises only the abstract
 * `CredentialStore` port surface (`get`/`save`/`delete`/`list`) — storage-
 * shape assertions (row bookkeeping, ciphertext-at-rest) are backend-
 * specific and live alongside each implementation's own test file, not
 * here.
 */
import { describe, expect, it } from "vitest";
import type { CredentialOwner, CredentialStore, StoredCredential } from "@valet/engine";

const userOwner: CredentialOwner = { type: "user", id: "user-1" };
const otherOwner: CredentialOwner = { type: "user", id: "user-2" };

export function describeCredentialStoreContract(makeStore: () => Promise<CredentialStore> | CredentialStore): void {
  describe("CredentialStore contract", () => {
    it("round-trips a full StoredCredential (oauth2 with refresh, scopes, metadata) via save then get", async () => {
      const store = await makeStore();
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
      const store = await makeStore();
      const result = await store.get(userOwner, "github");
      expect(result).toBeNull();
    });

    it("overwrites on save (upsert): get reflects the latest value, not a duplicate", async () => {
      const store = await makeStore();

      await store.save(userOwner, "github", { type: "api_key", apiKey: "key-v1" });
      await store.save(userOwner, "github", { type: "api_key", apiKey: "key-v2" });

      const result = await store.get(userOwner, "github");
      expect(result?.apiKey).toBe("key-v2");

      // Still one entry — not a duplicate insert.
      const listed = await store.list(userOwner);
      expect(listed.filter((c) => c.service === "github")).toHaveLength(1);
    });

    it("delete removes the row; list returns entries scoped to the requesting owner only", async () => {
      const store = await makeStore();

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
  });
}
