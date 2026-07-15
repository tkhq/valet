/**
 * auth-v2 Task 1, Step 4: schema round-trip test for the better-auth core
 * tables plus the two Valet-owned auth adjuncts (`invites`,
 * `sandbox_tokens`). Boots a fresh PGlite instance via the shared
 * `test-helpers/pg-test-db.ts` helper.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import type { AppDb } from "../lib/drizzle.js";
import type { PgDb } from "@valet/store-postgres";
import {
  account,
  apikey,
  invites,
  oauthAccessToken,
  oauthApplication,
  oauthConsent,
  orgs,
  sandboxTokens,
  session,
  ssoProvider,
  users,
  verification,
} from "./index.js";

async function freshDb(): Promise<{ pgdb: PgDb; db: AppDb }> {
  const { pgdb, appDb: db } = await freshTestPgDb();
  return { pgdb, db };
}

describe("better-auth schema round-trip", () => {
  it("users insert requires name", async () => {
    // Drizzle's `.values()` is statically typed to require `name`, so there's
    // no type-safe way to omit it through the query builder — this asserts
    // the underlying NOT NULL constraint directly against the raw query
    // interface, which is what actually enforces it.
    const { pgdb } = await freshDb();
    await expect(
      pgdb.query('INSERT INTO "user" (id, email, role) VALUES ($1, $2, $3)', [
        "u-no-name",
        "noname@x.test",
        "member",
      ]),
    ).rejects.toThrow();
  });

  it("session inserts and selects, cascading from a user row", async () => {
    const { db } = await freshDb();
    await db.insert(users).values({ id: "u1", email: "u1@x.test", name: "U One", role: "member" });
    await db.insert(session).values({ id: "s1", expiresAt: new Date(Date.now() + 1000), token: "tok-1", userId: "u1" });

    const rows = await db.select().from(session).where(eq(session.id, "s1")).limit(1);
    const got = rows[0];
    expect(got?.token).toBe("tok-1");
    expect(got?.userId).toBe("u1");
  });

  it("account inserts and selects", async () => {
    const { db } = await freshDb();
    await db.insert(users).values({ id: "u2", email: "u2@x.test", name: "U Two", role: "member" });
    await db
      .insert(account)
      .values({ id: "a1", accountId: "acct-1", providerId: "github", userId: "u2", accessToken: "at" });

    const rows = await db.select().from(account).where(eq(account.id, "a1")).limit(1);
    const got = rows[0];
    expect(got?.providerId).toBe("github");
    expect(got?.accessToken).toBe("at");
  });

  it("verification inserts and selects", async () => {
    const { db } = await freshDb();
    await db
      .insert(verification)
      .values({ id: "v1", identifier: "u2@x.test", value: "code", expiresAt: new Date(Date.now() + 1000) });

    const rows = await db.select().from(verification).where(eq(verification.id, "v1")).limit(1);
    const got = rows[0];
    expect(got?.identifier).toBe("u2@x.test");
  });

  it("ssoProvider inserts and selects", async () => {
    const { db } = await freshDb();
    await db
      .insert(ssoProvider)
      .values({ id: "sso1", issuer: "https://issuer.example", providerId: "okta-1", domain: "example.com" });

    const rows = await db.select().from(ssoProvider).where(eq(ssoProvider.id, "sso1")).limit(1);
    const got = rows[0];
    expect(got?.providerId).toBe("okta-1");
    expect(got?.domain).toBe("example.com");
  });

  it("apikey inserts and selects, defaulting config_id", async () => {
    const { db } = await freshDb();
    await db.insert(users).values({ id: "u3", email: "u3@x.test", name: "U Three", role: "member" });
    await db
      .insert(apikey)
      .values({ id: "ak1", referenceId: "u3", key: "sk-test", createdAt: new Date(), updatedAt: new Date() });

    const rows = await db.select().from(apikey).where(eq(apikey.id, "ak1")).limit(1);
    const got = rows[0];
    expect(got?.referenceId).toBe("u3");
    expect(got?.configId).toBe("default");
  });

  it("oauthApplication, oauthAccessToken, oauthConsent insert and select", async () => {
    const { db } = await freshDb();
    await db.insert(users).values({ id: "u4", email: "u4@x.test", name: "U Four", role: "member" });
    await db.insert(oauthApplication).values({ id: "app1", name: "Test App", clientId: "client-1" });
    await db
      .insert(oauthAccessToken)
      .values({ id: "tok1", accessToken: "access-1", clientId: "client-1", userId: "u4" });
    await db.insert(oauthConsent).values({ id: "consent1", clientId: "client-1", userId: "u4", consentGiven: true });

    const gotAppRows = await db.select().from(oauthApplication).where(eq(oauthApplication.id, "app1")).limit(1);
    expect(gotAppRows[0]?.clientId).toBe("client-1");

    const gotTokenRows = await db.select().from(oauthAccessToken).where(eq(oauthAccessToken.id, "tok1")).limit(1);
    expect(gotTokenRows[0]?.userId).toBe("u4");

    const gotConsentRows = await db.select().from(oauthConsent).where(eq(oauthConsent.id, "consent1")).limit(1);
    expect(gotConsentRows[0]?.consentGiven).toBe(true);
  });

  it("invites inserts and selects", async () => {
    const { db } = await freshDb();
    await db.insert(orgs).values({ id: "o1", name: "Acme", createdAt: Date.now() });
    await db.insert(invites).values({
      id: "inv1",
      codeHash: "hash-1",
      email: "invitee@x.test",
      createdBy: "admin-1",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const rows = await db.select().from(invites).where(eq(invites.id, "inv1")).limit(1);
    const got = rows[0];
    expect(got?.codeHash).toBe("hash-1");
    expect(got?.role).toBe("member");
  });

  it("invites.code_hash unique constraint fires on a duplicate", async () => {
    const { db } = await freshDb();
    const base = {
      email: "invitee@x.test",
      createdBy: "admin-1",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    };
    await db.insert(invites).values({ id: "inv1", codeHash: "dup-hash", ...base });
    await expect(db.insert(invites).values({ id: "inv2", codeHash: "dup-hash", ...base })).rejects.toThrow();
  });

  it("sandboxTokens inserts and selects", async () => {
    const { db } = await freshDb();
    await db.insert(sandboxTokens).values({
      id: "st1",
      tokenHash: "sandbox-hash-1",
      sessionId: "sess-1",
      userId: "u1",
      orgId: "o1",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const rows = await db.select().from(sandboxTokens).where(eq(sandboxTokens.id, "st1")).limit(1);
    expect(rows[0]?.tokenHash).toBe("sandbox-hash-1");
  });
});
