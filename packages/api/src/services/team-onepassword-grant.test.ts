import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "@valet/engine";
import { ONEPASSWORD_SERVICE } from "./onepassword.js";
import {
  isTeamOpRefGranted,
  loadTeamOnePasswordRefs,
  parseTeamOnePasswordRefs,
  refsFromGrantRow,
  withGrantRefs,
  withoutGrantRefs,
} from "./team-onepassword-grant.js";

describe("parseTeamOnePasswordRefs", () => {
  it("accepts op:// refs and drops duplicates", () => {
    const parsed = parseTeamOnePasswordRefs([
      "op://Shared/Acme/credential",
      " op://Shared/Acme/credential ",
      "op://Shared/Other/password",
    ]);
    expect(parsed).toEqual({
      ok: true,
      refs: ["op://Shared/Acme/credential", "op://Shared/Other/password"],
    });
  });

  it("refuses a path that is not an op:// reference", () => {
    const parsed = parseTeamOnePasswordRefs(["/etc/passwd"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("op://vault/item/field");
  });
});

describe("loadTeamOnePasswordRefs", () => {
  it("reads metadata.refs from the team-owned onepassword row", async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.save({ type: "team", id: "team_1" }, ONEPASSWORD_SERVICE, withGrantRefs(null, ["op://Shared/Acme/credential"]));
    await expect(loadTeamOnePasswordRefs(credentials, "team_1")).resolves.toEqual(["op://Shared/Acme/credential"]);
  });

  it("returns null when the team has no grant, so nothing is restricted", async () => {
    const credentials = new InMemoryCredentialStore();
    await expect(loadTeamOnePasswordRefs(credentials, "team_1")).resolves.toBeNull();
  });
});

describe("isTeamOpRefGranted", () => {
  it("matches the exact granted string", () => {
    expect(isTeamOpRefGranted(["op://Shared/Acme/credential"], "op://Shared/Acme/credential")).toBe(true);
    expect(isTeamOpRefGranted(["op://Shared/Acme/credential"], "op://Shared/Other/password")).toBe(false);
  });

  it("grants every reference when the team has no lease", () => {
    expect(isTeamOpRefGranted(null, "op://Shared/Other/password")).toBe(true);
  });
});

describe("refsFromGrantRow", () => {
  it("ignores a token-shaped row with no refs", () => {
    expect(refsFromGrantRow({ type: "service_account", apiKey: "tok" })).toEqual([]);
  });
});

describe("withGrantRefs / withoutGrantRefs", () => {
  it("builds a secret-free row when the team has none", () => {
    expect(withGrantRefs(null, ["op://Shared/Acme/credential"])).toEqual({
      type: "service_account",
      metadata: { refs: ["op://Shared/Acme/credential"] },
    });
  });

  it("keeps a token and its other metadata when the row already holds one", () => {
    const token = { type: "service_account" as const, apiKey: "tok", metadata: { note: "keep" } };
    expect(withGrantRefs(token, ["op://Shared/Acme/credential"])).toEqual({
      type: "service_account",
      apiKey: "tok",
      metadata: { note: "keep", refs: ["op://Shared/Acme/credential"] },
    });
  });

  it("clears the refs but keeps a row that holds a token", () => {
    const token = { type: "service_account" as const, apiKey: "tok", metadata: { refs: ["op://a/b/c"] } };
    expect(withoutGrantRefs(token)).toEqual({ type: "service_account", apiKey: "tok", metadata: {} });
  });

  it("returns null for a row that held only the grant, so the caller deletes it", () => {
    expect(withoutGrantRefs({ type: "service_account", metadata: { refs: ["op://a/b/c"] } })).toBeNull();
    expect(withoutGrantRefs(null)).toBeNull();
  });
});
