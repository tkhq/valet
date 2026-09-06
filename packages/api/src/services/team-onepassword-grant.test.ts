import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "@valet/engine";
import { ONEPASSWORD_SERVICE } from "./onepassword.js";
import {
  grantRow,
  isTeamOpRefGranted,
  loadTeamOnePasswordRefs,
  parseTeamOnePasswordRefs,
  refsFromGrantRow,
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
    await credentials.save({ type: "team", id: "team_1" }, ONEPASSWORD_SERVICE, grantRow(["op://Shared/Acme/credential"]));
    await expect(loadTeamOnePasswordRefs(credentials, "team_1")).resolves.toEqual(["op://Shared/Acme/credential"]);
  });

  it("returns an empty list when the team has no grant", async () => {
    const credentials = new InMemoryCredentialStore();
    await expect(loadTeamOnePasswordRefs(credentials, "team_1")).resolves.toEqual([]);
  });
});

describe("isTeamOpRefGranted", () => {
  it("matches the exact granted string", () => {
    expect(isTeamOpRefGranted(["op://Shared/Acme/credential"], "op://Shared/Acme/credential")).toBe(true);
    expect(isTeamOpRefGranted(["op://Shared/Acme/credential"], "op://Shared/Other/password")).toBe(false);
  });
});

describe("refsFromGrantRow", () => {
  it("ignores a token-shaped row with no refs", () => {
    expect(refsFromGrantRow({ type: "service_account", apiKey: "tok" })).toEqual([]);
  });
});
