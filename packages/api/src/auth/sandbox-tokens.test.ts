import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyAppMigrations, buildAppDb, type AppDb } from "../lib/drizzle.js";
import {
  mintSandboxToken,
  verifySandboxToken,
  revokeSandboxTokens,
  deriveSandboxJwtSecret,
  mintSandboxJwt,
  verifySandboxJwt,
} from "./sandbox-tokens.js";

describe("sandbox tokens", () => {
  let sqlite: Database.Database;
  let db: AppDb;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    applyAppMigrations(sqlite);
    db = buildAppDb(sqlite);
  });

  it("mint -> verify round-trips to the principal", () => {
    const { token } = mintSandboxToken(db, { sessionId: "sess1", userId: "user1", orgId: "org1" });
    expect(token).toMatch(/^st_[0-9a-f]{48}$/);

    const principal = verifySandboxToken(db, token);
    expect(principal).toEqual({ sessionId: "sess1", userId: "user1", orgId: "org1" });
  });

  it("a wrong token returns null", () => {
    mintSandboxToken(db, { sessionId: "sess1", userId: "user1", orgId: "org1" });
    expect(verifySandboxToken(db, "st_deadbeef")).toBeNull();
  });

  it("an expired token returns null", () => {
    const { token } = mintSandboxToken(db, { sessionId: "sess1", userId: "user1", orgId: "org1", ttlMs: -1 });
    expect(verifySandboxToken(db, token)).toBeNull();
  });

  it("a revoked token returns null", () => {
    const { token } = mintSandboxToken(db, { sessionId: "sess1", userId: "user1", orgId: "org1" });
    revokeSandboxTokens(db, "sess1");
    expect(verifySandboxToken(db, token)).toBeNull();
  });

  it("re-minting for a session revokes that session's prior live tokens", () => {
    const { token: first } = mintSandboxToken(db, { sessionId: "sess1", userId: "user1", orgId: "org1" });
    const { token: second } = mintSandboxToken(db, { sessionId: "sess1", userId: "user1", orgId: "org1" });

    expect(verifySandboxToken(db, first)).toBeNull();
    expect(verifySandboxToken(db, second)).toEqual({ sessionId: "sess1", userId: "user1", orgId: "org1" });
  });

  it("re-minting for a different session does not revoke the other session's token", () => {
    const { token: sess1Token } = mintSandboxToken(db, { sessionId: "sess1", userId: "user1", orgId: "org1" });
    mintSandboxToken(db, { sessionId: "sess2", userId: "user2", orgId: "org1" });

    expect(verifySandboxToken(db, sess1Token)).toEqual({ sessionId: "sess1", userId: "user1", orgId: "org1" });
  });

  it("defaults ttl to 24h", () => {
    const before = Date.now();
    const { expiresAt } = mintSandboxToken(db, { sessionId: "sess1", userId: "user1", orgId: "org1" });
    const dayMs = 24 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(before + dayMs);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + dayMs + 5_000);
  });

  describe("sandbox JWT", () => {
    it("mint -> verify round-trips with the derived secret", () => {
      const secret = deriveSandboxJwtSecret("master-key", "sess1");
      const { token } = mintSandboxJwt("master-key", { sessionId: "sess1", userId: "user1" });

      const payload = verifySandboxJwt(secret, token);
      expect(payload).toEqual({ sub: "user1", sid: "sess1" });
    });

    it("deriveSandboxJwtSecret is deterministic hex(HMAC-SHA256(master, sessionId))", () => {
      const a = deriveSandboxJwtSecret("master-key", "sess1");
      const b = deriveSandboxJwtSecret("master-key", "sess1");
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    it("verifying with a different session's derived secret returns null (cross-session isolation)", () => {
      const { token } = mintSandboxJwt("master-key", { sessionId: "sess1", userId: "user1" });
      const otherSecret = deriveSandboxJwtSecret("master-key", "sess2");
      expect(verifySandboxJwt(otherSecret, token)).toBeNull();
    });

    it("an expired JWT returns null", () => {
      const secret = deriveSandboxJwtSecret("master-key", "sess1");
      const { token } = mintSandboxJwt("master-key", { sessionId: "sess1", userId: "user1", ttlMs: -1 });
      expect(verifySandboxJwt(secret, token)).toBeNull();
    });

    it("a tampered payload returns null", () => {
      const secret = deriveSandboxJwtSecret("master-key", "sess1");
      const { token } = mintSandboxJwt("master-key", { sessionId: "sess1", userId: "user1" });
      const [header, payload, signature] = token.split(".");
      const tamperedPayload = Buffer.from(JSON.stringify({ sub: "attacker", sid: "sess1", iat: 0, exp: 9999999999 }))
        .toString("base64url");
      const tampered = `${header}.${tamperedPayload}.${signature}`;
      expect(verifySandboxJwt(secret, tampered)).toBeNull();
    });

    it("defaults ttl to 10 minutes", () => {
      const before = Date.now();
      const { expiresAt } = mintSandboxJwt("master-key", { sessionId: "sess1", userId: "user1" });
      const tenMinMs = 10 * 60 * 1000;
      expect(expiresAt).toBeGreaterThanOrEqual(before + tenMinMs);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + tenMinMs + 5_000);
    });
  });
});
