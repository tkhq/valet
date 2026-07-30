/**
 * Unit tests for `extractApiKeyScopes` — the metadata parser that feeds
 * `effectiveApiKeyPermissions` from the api-key's `metadata.scopes` field.
 * The intersection semantics themselves are covered in
 * `../auth/permissions.test.ts`; this file only pins the wire read.
 */
import { describe, expect, it } from "vitest";
import { extractApiKeyScopes } from "./auth.js";

describe("extractApiKeyScopes", () => {
  it("returns null for missing / null metadata (back-compat: existing keys)", () => {
    expect(extractApiKeyScopes(null)).toBeNull();
    expect(extractApiKeyScopes(undefined)).toBeNull();
    expect(extractApiKeyScopes({})).toBeNull();
  });

  it("returns null when scopes is present but not an array", () => {
    expect(extractApiKeyScopes({ scopes: "providers:manage" })).toBeNull();
    expect(extractApiKeyScopes({ scopes: { p: true } })).toBeNull();
  });

  it("returns null when scopes is an empty array", () => {
    expect(extractApiKeyScopes({ scopes: [] })).toBeNull();
  });

  it("filters non-string entries but keeps the strings", () => {
    expect(extractApiKeyScopes({ scopes: ["providers:manage", 42, null, "credentials:org"] })).toEqual([
      "providers:manage",
      "credentials:org",
    ]);
  });

  it("returns null if filtering leaves no strings", () => {
    expect(extractApiKeyScopes({ scopes: [42, null] })).toBeNull();
  });
});
