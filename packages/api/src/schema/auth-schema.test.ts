/**
 * auth-v2 Task 1, Step 4: schema round-trip test for the better-auth core
 * tables plus the two Valet-owned auth adjuncts (`invites`,
 * `sandbox_tokens`). Boots a fresh in-memory db the same way
 * `schema.test.ts` does — direct `applyAppMigrations` + `buildAppDb`, no
 * full API boot needed since this only exercises the sqlite schema.
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { applyAppMigrations, buildAppDb } from "../lib/drizzle.js";
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

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  applyAppMigrations(sqlite);
  const db = buildAppDb(sqlite);
  return { sqlite, db };
}

describe("better-auth schema round-trip", () => {
  it("users insert requires name", () => {
    // Drizzle's `.values()` is statically typed to require `name`, so there's
    // no type-safe way to omit it through the query builder — this asserts
    // the underlying NOT NULL constraint directly against the raw handle,
    // which is what actually enforces it.
    const { sqlite } = freshDb();
    expect(() => {
      sqlite.prepare("INSERT INTO user (id, email, role) VALUES (?, ?, ?)").run("u-no-name", "noname@x.test", "member");
    }).toThrow();
    sqlite.close();
  });

  it("session inserts and selects, cascading from a user row", () => {
    const { sqlite, db } = freshDb();
    db.insert(users).values({ id: "u1", email: "u1@x.test", name: "U One", role: "member" }).run();
    db.insert(session)
      .values({ id: "s1", expiresAt: new Date(Date.now() + 1000), token: "tok-1", userId: "u1" })
      .run();

    const got = db.select().from(session).where(eq(session.id, "s1")).get();
    expect(got?.token).toBe("tok-1");
    expect(got?.userId).toBe("u1");
    sqlite.close();
  });

  it("account inserts and selects", () => {
    const { sqlite, db } = freshDb();
    db.insert(users).values({ id: "u2", email: "u2@x.test", name: "U Two", role: "member" }).run();
    db.insert(account)
      .values({ id: "a1", accountId: "acct-1", providerId: "github", userId: "u2", accessToken: "at" })
      .run();

    const got = db.select().from(account).where(eq(account.id, "a1")).get();
    expect(got?.providerId).toBe("github");
    expect(got?.accessToken).toBe("at");
    sqlite.close();
  });

  it("verification inserts and selects", () => {
    const { sqlite, db } = freshDb();
    db.insert(verification)
      .values({ id: "v1", identifier: "u2@x.test", value: "code", expiresAt: new Date(Date.now() + 1000) })
      .run();

    const got = db.select().from(verification).where(eq(verification.id, "v1")).get();
    expect(got?.identifier).toBe("u2@x.test");
    sqlite.close();
  });

  it("ssoProvider inserts and selects", () => {
    const { sqlite, db } = freshDb();
    db.insert(ssoProvider)
      .values({ id: "sso1", issuer: "https://issuer.example", providerId: "okta-1", domain: "example.com" })
      .run();

    const got = db.select().from(ssoProvider).where(eq(ssoProvider.id, "sso1")).get();
    expect(got?.providerId).toBe("okta-1");
    expect(got?.domain).toBe("example.com");
    sqlite.close();
  });

  it("apikey inserts and selects, defaulting config_id", () => {
    const { sqlite, db } = freshDb();
    db.insert(users).values({ id: "u3", email: "u3@x.test", name: "U Three", role: "member" }).run();
    db.insert(apikey)
      .values({ id: "ak1", referenceId: "u3", key: "sk-test", createdAt: new Date(), updatedAt: new Date() })
      .run();

    const got = db.select().from(apikey).where(eq(apikey.id, "ak1")).get();
    expect(got?.referenceId).toBe("u3");
    expect(got?.configId).toBe("default");
    sqlite.close();
  });

  it("oauthApplication, oauthAccessToken, oauthConsent insert and select", () => {
    const { sqlite, db } = freshDb();
    db.insert(users).values({ id: "u4", email: "u4@x.test", name: "U Four", role: "member" }).run();
    db.insert(oauthApplication).values({ id: "app1", name: "Test App", clientId: "client-1" }).run();
    db.insert(oauthAccessToken)
      .values({ id: "tok1", accessToken: "access-1", clientId: "client-1", userId: "u4" })
      .run();
    db.insert(oauthConsent).values({ id: "consent1", clientId: "client-1", userId: "u4", consentGiven: true }).run();

    const gotApp = db.select().from(oauthApplication).where(eq(oauthApplication.id, "app1")).get();
    expect(gotApp?.clientId).toBe("client-1");

    const gotToken = db.select().from(oauthAccessToken).where(eq(oauthAccessToken.id, "tok1")).get();
    expect(gotToken?.userId).toBe("u4");

    const gotConsent = db.select().from(oauthConsent).where(eq(oauthConsent.id, "consent1")).get();
    expect(gotConsent?.consentGiven).toBe(true);
    sqlite.close();
  });

  it("invites inserts and selects", () => {
    const { sqlite, db } = freshDb();
    db.insert(orgs).values({ id: "o1", name: "Acme", createdAt: Date.now() }).run();
    db.insert(invites)
      .values({
        id: "inv1",
        codeHash: "hash-1",
        email: "invitee@x.test",
        createdBy: "admin-1",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .run();

    const got = db.select().from(invites).where(eq(invites.id, "inv1")).get();
    expect(got?.codeHash).toBe("hash-1");
    expect(got?.role).toBe("member");
    sqlite.close();
  });

  it("invites.code_hash unique constraint fires on a duplicate", () => {
    const { sqlite, db } = freshDb();
    const base = {
      email: "invitee@x.test",
      createdBy: "admin-1",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    };
    db.insert(invites).values({ id: "inv1", codeHash: "dup-hash", ...base }).run();
    expect(() => {
      db.insert(invites).values({ id: "inv2", codeHash: "dup-hash", ...base }).run();
    }).toThrow();
    sqlite.close();
  });

  it("sandboxTokens inserts and selects", () => {
    const { sqlite, db } = freshDb();
    db.insert(sandboxTokens)
      .values({
        id: "st1",
        tokenHash: "sandbox-hash-1",
        sessionId: "sess-1",
        userId: "u1",
        orgId: "o1",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .run();

    const got = db.select().from(sandboxTokens).where(eq(sandboxTokens.id, "st1")).get();
    expect(got?.tokenHash).toBe("sandbox-hash-1");
    sqlite.close();
  });
});
