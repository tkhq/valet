import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import type { AppDb } from "../lib/drizzle.js";
import { sandboxTokens } from "../schema/index.js";
import { getOrCreateSandboxToken, preserveLegacySandboxTokens, mintSandboxToken, verifySandboxToken, revokeSandboxTokens } from "./sandbox-tokens.js";

import * as tokenMetrics from "../observability/sandbox-token-metrics.js";

const principal = { sessionId: "session", userId: "user", orgId: "org" };
let db: AppDb;
beforeEach(async () => { ({ appDb: db } = await freshTestPgDb()); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function seedSandbox(): Promise<void> {
  await db.execute(sql`INSERT INTO engine_sessions
    (id, owner_type, owner_id, user_id, org_id, workspace, purpose, status, sandbox_id, created_at, updated_at)
    VALUES ('session', 'user', 'user', 'user', 'org', '/workspace', 'interactive', 'active', 'sandbox', 1, 1)`);
}

describe("durable sandbox tokens", () => {
  it("adopts the same bearer beyond the former TTL", async () => {
    const first = await getOrCreateSandboxToken(db, principal, "stable-instance-key");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3 * 86400000);
    const second = await getOrCreateSandboxToken(db, principal, "stable-instance-key");
    expect(second.token).toBe(first.token);
    expect(await verifySandboxToken(db, first.token)).toEqual(principal);
    const rows = await db.select().from(sandboxTokens);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(first.token);
    expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("never revives a revoked token, including after another adoption", async () => {
    const first = await getOrCreateSandboxToken(db, principal, "key");
    await revokeSandboxTokens(db, principal.sessionId);
    const second = await getOrCreateSandboxToken(db, principal, "key");
    expect(second.token).not.toBe(first.token);
    expect(await verifySandboxToken(db, first.token)).toBeNull();
    expect(await verifySandboxToken(db, second.token)).toEqual(principal);
  });

  it("binds adoption to the complete principal", async () => {
    const first = await getOrCreateSandboxToken(db, principal, "key");
    for (const other of [ { ...principal, sessionId: "other" }, { ...principal, userId: "other" }, { ...principal, orgId: "other" } ]) {
      const next = await getOrCreateSandboxToken(db, other, "key");
      expect(next.token).not.toBe(first.token);
      expect(await verifySandboxToken(db, next.token)).toEqual(other);
    }
  });

  it("key changes do not revoke the token already inside a sandbox", async () => {
    const first = await getOrCreateSandboxToken(db, principal, "old-key");
    await getOrCreateSandboxToken(db, principal, "new-key");
    expect(await verifySandboxToken(db, first.token)).toEqual(principal);
  });

  it("boot preserves live legacy tokens without reviving expired or revoked tokens", async () => {
    const live = await mintSandboxToken(db, principal);
    const expired = await mintSandboxToken(db, { ...principal, ttlMs: -1 });
    const revoked = await mintSandboxToken(db, { ...principal, sessionId: "revoked" });
    await revokeSandboxTokens(db, "revoked");
    await preserveLegacySandboxTokens(db);
    const rows = await db.select().from(sandboxTokens).where(eq(sandboxTokens.sessionId, principal.sessionId));
    expect(rows.filter(row => row.expiresAt.getUTCFullYear() === 9999)).toHaveLength(1);
    expect(await verifySandboxToken(db, live.token)).toEqual(principal);
    expect(await verifySandboxToken(db, expired.token)).toBeNull();
    expect(await verifySandboxToken(db, revoked.token)).toBeNull();
  });
  it("promotes a live legacy bearer issued after boot on its first request", async () => {
    await seedSandbox();
    await preserveLegacySandboxTokens(db);
    const legacy = await mintSandboxToken(db, principal);
    expect(await verifySandboxToken(db, legacy.token)).toEqual(principal);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3 * 86400000);
    expect(await verifySandboxToken(db, legacy.token)).toEqual(principal);
  });

  it("reports rejected known credentials only while a sandbox is still attached", async () => {
    await seedSandbox();
    const record = vi.spyOn(tokenMetrics, "recordSandboxTokenRejected");
    const expired = await mintSandboxToken(db, { ...principal, ttlMs: -1 });
    expect(await verifySandboxToken(db, expired.token)).toBeNull();
    expect(record).toHaveBeenCalledWith("expired");
    const live = await getOrCreateSandboxToken(db, principal, "key");
    await revokeSandboxTokens(db, principal.sessionId);
    expect(await verifySandboxToken(db, live.token)).toBeNull();
    expect(record).toHaveBeenCalledWith("revoked");
    record.mockClear();
    await db.execute(sql`DELETE FROM engine_sessions WHERE id = 'session'`);
    expect(await verifySandboxToken(db, live.token)).toBeNull();
    expect(await verifySandboxToken(db, "st_unknown")).toBeNull();
    expect(record).not.toHaveBeenCalled();
  });

});
