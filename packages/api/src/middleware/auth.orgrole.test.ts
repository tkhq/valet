/**
 * AuthUser.orgRole/permissions stamping (RBAC design): the ladder resolves
 * org_members.role per request — the org role, not users.role, drives
 * permissions.
 *
 * Deviation from the task-2 brief: the brief's draft asserted through
 * `GET /api/org`'s response body (`callerRole` + `permissions`), but
 * `OrgResponse.callerRole` stays narrowed to the binary wire role
 * (`toWireOrgRole` in routes/org.ts) until Task 3 widens it, and
 * `permissions` isn't on the wire type at all yet — asserting through that
 * route today can only prove the OLD narrowing, not the new middleware
 * behavior. Instead:
 *   1. Unit-test `resolveOrgRole` (exported from middleware/auth.ts)
 *      directly against a `freshTestPgDb()` handle — admin/operator/member
 *      rows and the no-row-found default.
 *   2. One integration assertion that the stub identity (`VALET_LOCAL_AUTH`)
 *      carries full admin permissions end-to-end, via a route gated on
 *      `requireOrgAdmin` (still DB-backed org-admin check, unaffected by
 *      this task) — proving the ladder's stub rung reaches a real route.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { resolveOrgRole } from "./auth.js";
import { permissionsForOrgRole } from "../auth/permissions.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { orgMembers, orgs, users } from "../schema/index.js";

let api: TestApi | undefined;
let pg: TestPgDb | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  await pg?.cleanup();
  pg = undefined;
});

describe("resolveOrgRole", () => {
  it("resolves admin/operator/member rows and defaults to member when absent", async () => {
    pg = await freshTestPgDb();
    const { appDb: db } = pg;
    const now = Date.now();
    await db.insert(orgs).values({ id: "org-1", name: "Org 1", createdAt: now });
    await db.insert(users).values([
      { id: "u-admin", email: "admin@test", name: "Admin", role: "admin" },
      { id: "u-operator", email: "operator@test", name: "Operator", role: "member" },
      { id: "u-member", email: "member@test", name: "Member", role: "member" },
      { id: "u-none", email: "none@test", name: "None", role: "member" },
    ]);
    await db.insert(orgMembers).values([
      { orgId: "org-1", userId: "u-admin", role: "admin", createdAt: now },
      { orgId: "org-1", userId: "u-operator", role: "operator", createdAt: now },
      { orgId: "org-1", userId: "u-member", role: "member", createdAt: now },
    ]);

    expect(await resolveOrgRole(db, "org-1", "u-admin")).toBe("admin");
    expect(await resolveOrgRole(db, "org-1", "u-operator")).toBe("operator");
    expect(await resolveOrgRole(db, "org-1", "u-member")).toBe("member");
    // No org_members row for u-none — defensive default.
    expect(await resolveOrgRole(db, "org-1", "u-none")).toBe("member");
  });

  it("demoting an org_members row to member drops permissions on next resolve", async () => {
    pg = await freshTestPgDb();
    const { appDb: db } = pg;
    const now = Date.now();
    await db.insert(orgs).values({ id: "org-1", name: "Org 1", createdAt: now });
    await db.insert(users).values({ id: "u1", email: "u1@test", name: "U1", role: "member" });
    await db.insert(orgMembers).values({ orgId: "org-1", userId: "u1", role: "operator", createdAt: now });

    expect(await resolveOrgRole(db, "org-1", "u1")).toBe("operator");

    await db.update(orgMembers).set({ role: "member" }).where(eq(orgMembers.userId, "u1"));

    const role = await resolveOrgRole(db, "org-1", "u1");
    expect(role).toBe("member");
    expect(permissionsForOrgRole(role).size).toBe(0);
  });
});

describe("stub identity permissions", () => {
  it("VALET_LOCAL_AUTH stub identity gets full admin permissions (requireOrgAdmin-gated route 200s)", async () => {
    api = await bootTestApi();
    // llm-providers is gated with requireOrgAdmin; the stub identity
    // (local-user, orgRole "admin" per this task's change) must reach it.
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers`);
    expect(res.status).toBe(200);
  });
});
