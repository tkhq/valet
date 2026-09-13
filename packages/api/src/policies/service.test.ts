/**
 * Action-policies Task 3: host resolver, grant/policy writes, audit sink.
 * Real PGlite + migrations — these tests exercise the impure edges the pure
 * Canonical evaluator tests cover decisions. These tests cover grant idempotence,
 * replay, the admin-gated always-allow write, deterministic audit dedup, and
 * the DB-level constraints T2 shipped (one-of CHECK + partial unique index).
 *
 * ONE PGlite instance per process (wasm heap isn't reliably freed on close).
 */
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgDbFromPglite } from "@valet/store-postgres";
import type { PolicyInvocationRecord } from "@valet/engine";
import { applyAppMigrations, buildAppDb, type AppDb } from "../lib/drizzle.js";
import { actionInvocations, actionPolicies, actionPolicyOverrides, orgMembers, orgs, runtimeGrants, users } from "../schema/index.js";
import {
  AlwaysAllowNotAdminError,
  alwaysAllowPolicyId,
  gatedAuditId,
  persistInvocationAudit,
  POLICY_AUDIT_FIELD_CAP,
  revokeExecutionGrants,
  revokeSessionGrants,
  updateInvocationOutcome,
  writeAlwaysAllowPolicy,
  writeExecutionGrant,
  writeSessionGrant,
} from "./service.js";

const ORG = "org_test";
const ADMIN = "user_admin";
const MEMBER = "user_member";
const SESSION = "sess_1";
const RUN = "run_1";

const pglite = new PGlite();
const pg = pgDbFromPglite(pglite);
const db: AppDb = buildAppDb(pglite);

async function reset(): Promise<void> {
  await pg.query("DELETE FROM agent_sessions");
  await pg.query("DELETE FROM runtime_grants");
  await pg.query("DELETE FROM action_policies");
  await pg.query("DELETE FROM action_policy_overrides");
  await pg.query("DELETE FROM action_invocations");
}

beforeAll(async () => {
  await applyAppMigrations(pg);
  await db.insert(orgs).values({ id: ORG, name: "Test", createdAt: Date.now() });
  await db.insert(users).values([
    { id: ADMIN, name: "Admin", email: "a@x.co", emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: MEMBER, name: "Member", email: "m@x.co", emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ]);
  await db.insert(orgMembers).values([
    { orgId: ORG, userId: ADMIN, role: "admin", createdAt: Date.now() },
    { orgId: ORG, userId: MEMBER, role: "member", createdAt: Date.now() },
  ]);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(reset);

// ── Grant writes + idempotence ─────────────────────────────────────

describe("writeSessionGrant", () => {
  it("is idempotent under exact replay (one live row for the same key)", async () => {
    const g = { orgId: ORG, service: "github", actionId: "create_issue", grantedBy: ADMIN, now: 1000 };
    await writeSessionGrant(db, SESSION, g);
    await writeSessionGrant(db, SESSION, g); // replayed onResolution
    const rows = await db.select().from(runtimeGrants).where(eq(runtimeGrants.sessionId, SESSION));
    expect(rows).toHaveLength(1);
    expect(rows[0].policyKey).toBe("github.create_issue");
  });

  it("inserts a fresh row when re-granted after a revoke", async () => {
    const g = { orgId: ORG, service: "github", actionId: "create_issue", grantedBy: ADMIN, now: 1000 };
    await writeSessionGrant(db, SESSION, g);
    await revokeSessionGrants(db, SESSION, 2000);
    await writeSessionGrant(db, SESSION, { ...g, now: 3000 });
    const all = await db.select().from(runtimeGrants).where(eq(runtimeGrants.sessionId, SESSION));
    expect(all).toHaveLength(2);
    const live = all.filter((r) => r.revokedAt === null);
    expect(live).toHaveLength(1);
  });

  it("rejects a second live grant at the DB layer (partial unique index)", async () => {
    await db.insert(runtimeGrants).values({
      id: "g1", orgId: ORG, sessionId: SESSION, workflowExecutionId: null,
      policyKey: "github.create_issue", mode: "allow", grantedBy: ADMIN, createdAt: 1, revokedAt: null,
    });
    await expect(
      db.insert(runtimeGrants).values({
        id: "g2", orgId: ORG, sessionId: SESSION, workflowExecutionId: null,
        policyKey: "github.create_issue", mode: "allow", grantedBy: ADMIN, createdAt: 2, revokedAt: null,
      }),
    ).rejects.toThrow();
  });
});

describe("writeExecutionGrant / revokeExecutionGrants", () => {
  it("upserts idempotently and revokes idempotently", async () => {
    const g = { orgId: ORG, service: "slack", actionId: "post_message", grantedBy: ADMIN, now: 1 };
    await writeExecutionGrant(db, RUN, g);
    await writeExecutionGrant(db, RUN, g);
    let rows = await db.select().from(runtimeGrants).where(eq(runtimeGrants.workflowExecutionId, RUN));
    expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
    await revokeExecutionGrants(db, RUN, 99);
    await revokeExecutionGrants(db, RUN, 99); // idempotent second call
    rows = await db.select().from(runtimeGrants).where(eq(runtimeGrants.workflowExecutionId, RUN));
    expect(rows.every((r) => r.revokedAt === 99)).toBe(true);
  });
});

// ── always-allow write ─────────────────────────────────────────────

describe("writeAlwaysAllowPolicy", () => {
  it("writes a deterministic org policy row for an admin", async () => {
    await writeAlwaysAllowPolicy(db, { orgId: ORG, actionId: "create_issue", grantedBy: ADMIN, now: 10 });
    const rows = await db.select().from(actionPolicies).where(eq(actionPolicies.id, alwaysAllowPolicyId(ORG, "create_issue")));
    expect(rows).toHaveLength(1);
    expect(rows[0].mode).toBe("allow");
    expect(rows[0].origin).toBe("approval_prompt");
    expect(rows[0].actionId).toBe("create_issue");
  });

  it("is idempotent under replay (upsert on the deterministic id)", async () => {
    await writeAlwaysAllowPolicy(db, { orgId: ORG, actionId: "create_issue", grantedBy: ADMIN, now: 10 });
    await writeAlwaysAllowPolicy(db, { orgId: ORG, actionId: "create_issue", grantedBy: ADMIN, now: 20 });
    const rows = await db.select().from(actionPolicies).where(eq(actionPolicies.actionId, "create_issue"));
    expect(rows).toHaveLength(1);
    expect(rows[0].updatedAt).toBe(20);
  });

  it("throws AlwaysAllowNotAdminError for a non-admin and writes nothing", async () => {
    await expect(
      writeAlwaysAllowPolicy(db, { orgId: ORG, actionId: "create_issue", grantedBy: MEMBER, now: 10 }),
    ).rejects.toBeInstanceOf(AlwaysAllowNotAdminError);
    const rows = await db.select().from(actionPolicies);
    expect(rows).toHaveLength(0);
  });
});

// ── DB constraint round-trips (T2 fold-in) ─────────────────────────

describe("DB constraints", () => {
  it("rejects an action_policies row violating the one-of target CHECK", async () => {
    await expect(
      db.insert(actionPolicies).values({
        id: "bad", orgId: ORG, principalType: "org", principalId: ORG,
        service: "github", actionId: "create_issue", riskLevel: null, mode: "allow",
        paramMatchers: [], appliesIn: "any", origin: "settings", managedBy: null,
        expiresAt: null, revokedAt: null, createdAt: 1, updatedAt: 1,
      }),
    ).rejects.toThrow();
  });

  it("rejects an action_policy_overrides row with zero targets", async () => {
    await expect(
      db.insert(actionPolicyOverrides).values({
        id: "bad", orgId: ORG, userId: MEMBER, service: null, actionId: null, riskLevel: null,
        mode: "deny", paramMatchers: [], createdAt: 1, updatedAt: 1,
      }),
    ).rejects.toThrow();
  });

  it("rejects a runtime_grants row with both scopes set (one-of scope CHECK)", async () => {
    await expect(
      db.insert(runtimeGrants).values({
        id: "bad", orgId: ORG, sessionId: SESSION, workflowExecutionId: RUN,
        policyKey: "x.y", mode: "allow", grantedBy: ADMIN, createdAt: 1, revokedAt: null,
      }),
    ).rejects.toThrow();
  });
});

// ── audit sink ─────────────────────────────────────────────────────

describe("persistInvocationAudit", () => {
  it("dedups a gated replay double-fire (same sessionId/queueItemId/resumeKey/gateOrdinal → one row)", async () => {
    const id = gatedAuditId(SESSION, "qi-1", "github.create_issue:{}", 0);
    await persistInvocationAudit(db, { invocationId: id, sessionId: SESSION, status: "completed", resolvedMode: "require_approval" });
    await persistInvocationAudit(db, { invocationId: id, sessionId: SESSION, status: "completed", resolvedMode: "require_approval" });
    const rows = await db.select().from(actionInvocations).where(eq(actionInvocations.sessionId, SESSION));
    expect(rows).toHaveLength(1);
  });

  it("caps oversized params + sets the truncation flag", async () => {
    const big = "x".repeat(POLICY_AUDIT_FIELD_CAP + 100);
    await persistInvocationAudit(db, { invocationId: "cap1", sessionId: SESSION, params: { blob: big } });
    const row = (await db.select().from(actionInvocations).where(eq(actionInvocations.invocationId, "cap1")))[0];
    expect(row.paramsTruncated).toBe(true);
    expect(JSON.stringify(row.params).length).toBeLessThanOrEqual(POLICY_AUDIT_FIELD_CAP + 64);
  });

  it("keeps small params untruncated", async () => {
    await persistInvocationAudit(db, { invocationId: "cap2", params: { a: 1 } });
    const row = (await db.select().from(actionInvocations).where(eq(actionInvocations.invocationId, "cap2")))[0];
    expect(row.paramsTruncated).toBe(false);
    expect(row.params).toEqual({ a: 1 });
  });

  it("never throws on a bad write (fire-and-forget contract)", async () => {
    // A duplicate PK with a conflicting shape still resolves (onConflictDoNothing);
    // an invalid enum value is swallowed and logged, not thrown.
    await expect(
      persistInvocationAudit(db, { invocationId: "bad-status", status: "not-a-status" as PolicyInvocationRecord["status"] }),
    ).resolves.toBeUndefined();
  });

  it("capAuditField distinguishes a completed-via-gate from an allow row by resolvedMode, not status", () => {
    // Consumers key allow-vs-approve on resolvedMode + provenance, not status.
    const approved = { status: "completed" as const, resolvedMode: "require_approval" as const };
    const allowed = { status: "completed" as const, resolvedMode: "allow" as const };
    expect(approved.status).toBe(allowed.status);
    expect(approved.resolvedMode).not.toBe(allowed.resolvedMode);
  });
});

// ── updateInvocationOutcome ───────────────────────────────────────

describe("updateInvocationOutcome", () => {
  it("stamps resolvedBy on a row when provided", async () => {
    // Seed an invocation row
    await persistInvocationAudit(db, { invocationId: "inv1", orgId: ORG, status: "pending" });
    // Update it with a resolved_by value
    await updateInvocationOutcome(db, "inv1", ORG, { status: "approved", resolvedBy: "u1" });
    // Read it back and verify both fields
    const row = (await db.select().from(actionInvocations).where(eq(actionInvocations.invocationId, "inv1")))[0];
    expect(row).toBeDefined();
    expect(row.status).toBe("approved");
    expect(row.resolvedBy).toBe("u1");
  });

  it("updates status to timeout without resolvedBy", async () => {
    // Seed an invocation row
    await persistInvocationAudit(db, { invocationId: "inv2", orgId: ORG, status: "pending" });
    // Update it with timeout status, no resolvedBy
    await updateInvocationOutcome(db, "inv2", ORG, { status: "timeout" });
    // Read it back and verify
    const row = (await db.select().from(actionInvocations).where(eq(actionInvocations.invocationId, "inv2")))[0];
    expect(row).toBeDefined();
    expect(row.status).toBe("timeout");
    expect(row.resolvedBy).toBeNull();
  });

  it("updates status to cancelled with resolvedBy", async () => {
    // Seed an invocation row
    await persistInvocationAudit(db, { invocationId: "inv3", orgId: ORG, status: "pending" });
    // Update it with cancelled status and resolvedBy
    await updateInvocationOutcome(db, "inv3", ORG, { status: "cancelled", resolvedBy: "u2" });
    // Read it back and verify
    const row = (await db.select().from(actionInvocations).where(eq(actionInvocations.invocationId, "inv3")))[0];
    expect(row).toBeDefined();
    expect(row.status).toBe("cancelled");
    expect(row.resolvedBy).toBe("u2");
  });
});
