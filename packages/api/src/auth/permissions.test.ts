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
  permissionsForOrgRole,
  can,
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
