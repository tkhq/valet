/**
 * Permission vocabulary + role bundles (RBAC design,
 * docs/specs/2026-07-21-rbac-permissions-design.md). The bundle contents
 * are pinned exactly — a drive-by edit to a bundle is a security change
 * and must show up as a test diff.
 */
import { describe, it, expect } from "vitest";
import {
  PERMISSIONS,
  ORG_ROLES,
  ROLE_PERMISSIONS,
  isOrgRole,
  isPermission,
  permissionsForOrgRole,
  can,
  effectiveApiKeyPermissions,
} from "./permissions.js";

describe("role bundles", () => {
  it("pins the exact bundle contents per role", () => {
    expect([...ROLE_PERMISSIONS.admin]).toEqual([
      "org:manage",
      "members:manage",
      "providers:manage",
      "infra:manage",
      "credentials:org",
    ]);
    expect([...ROLE_PERMISSIONS.operator]).toEqual(["providers:manage", "infra:manage", "credentials:org"]);
    expect([...ROLE_PERMISSIONS.member]).toEqual([]);
  });

  it("admin holds every permission in the vocabulary", () => {
    expect([...ROLE_PERMISSIONS.admin]).toEqual([...PERMISSIONS]);
  });
});

describe("isOrgRole", () => {
  it("accepts exactly the three roles", () => {
    for (const role of ORG_ROLES) expect(isOrgRole(role)).toBe(true);
    expect(isOrgRole("owner")).toBe(false);
    expect(isOrgRole(undefined)).toBe(false);
  });
});

describe("can", () => {
  it("checks membership of the principal's permission set", () => {
    const operator = { permissions: permissionsForOrgRole("operator") };
    expect(can(operator, "providers:manage")).toBe(true);
    expect(can(operator, "members:manage")).toBe(false);
    expect(can({ permissions: permissionsForOrgRole("member") }, "credentials:org")).toBe(false);
  });
});

describe("isPermission", () => {
  it("accepts every permission in the vocabulary", () => {
    for (const p of PERMISSIONS) expect(isPermission(p)).toBe(true);
  });
  it("rejects unknown / non-string values", () => {
    expect(isPermission("nope:manage")).toBe(false);
    expect(isPermission(undefined)).toBe(false);
    expect(isPermission(42)).toBe(false);
  });
});

describe("effectiveApiKeyPermissions", () => {
  const admin = permissionsForOrgRole("admin");
  const operator = permissionsForOrgRole("operator");

  it("returns the full owner bundle for undefined / null / empty scopes (back-compat)", () => {
    expect(effectiveApiKeyPermissions(admin, undefined)).toBe(admin);
    expect(effectiveApiKeyPermissions(admin, null)).toBe(admin);
    expect(effectiveApiKeyPermissions(admin, [])).toBe(admin);
  });

  it("intersects a non-empty scope list with the owner bundle", () => {
    const scoped = effectiveApiKeyPermissions(admin, ["providers:manage", "credentials:org"]);
    expect([...scoped].sort()).toEqual(["credentials:org", "providers:manage"]);
  });

  it("drops scopes the owner does not hold (owner is the ceiling)", () => {
    // A key owned by an operator declares admin-level scopes; owner's bundle wins.
    const scoped = effectiveApiKeyPermissions(operator, ["members:manage", "providers:manage"]);
    expect([...scoped]).toEqual(["providers:manage"]);
  });

  it("ignores unknown scope strings (forward-compat with additive PERMISSIONS bumps)", () => {
    const scoped = effectiveApiKeyPermissions(admin, ["providers:manage", "future:permission"]);
    expect([...scoped]).toEqual(["providers:manage"]);
  });
});
