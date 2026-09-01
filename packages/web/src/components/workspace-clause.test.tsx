import { describe, expect, it } from "vitest";
import type { TeamSummary } from "@valet/api/wire";
import { resolveActiveWorkspace, workspaceName } from "./workspace-clause";

function team(id: string, overrides: Partial<TeamSummary> = {}): TeamSummary {
  return {
    id,
    orgId: "org_1",
    name: `Team ${id}`,
    origin: "local",
    externalId: null,
    createdAt: 0,
    memberCount: 3,
    callerRole: "member",
    defaultModel: null,
    ...overrides,
  };
}

describe("resolveActiveWorkspace", () => {
  it("resolves the personal scope without waiting for the team list", () => {
    expect(
      resolveActiveWorkspace({ teamId: undefined, teams: undefined, organizationsEnabled: undefined }),
    ).toEqual({ kind: "personal", hasTeams: false });
  });

  it("reports teams on the personal scope once membership is known", () => {
    expect(
      resolveActiveWorkspace({ teamId: undefined, teams: [team("t1")], organizationsEnabled: true }),
    ).toEqual({ kind: "personal", hasTeams: true });
  });

  it("is undefined while a team scope cannot be named yet", () => {
    expect(
      resolveActiveWorkspace({ teamId: "t1", teams: undefined, organizationsEnabled: true }),
    ).toBeUndefined();
    expect(
      resolveActiveWorkspace({ teamId: "t1", teams: [team("t1")], organizationsEnabled: undefined }),
    ).toBeUndefined();
  });

  it("names the scoped team", () => {
    const t = team("t1", { name: "Engineering" });
    expect(
      resolveActiveWorkspace({ teamId: "t1", teams: [t], organizationsEnabled: true }),
    ).toEqual({ kind: "team", team: t });
  });

  it("falls back to personal for a team the caller cannot open", () => {
    // A stale stored key, or a team the caller only administers
    // (callerRole null) — same rule as `eligibleTeams`.
    expect(
      resolveActiveWorkspace({
        teamId: "gone",
        teams: [team("t1")],
        organizationsEnabled: true,
      }),
    ).toEqual({ kind: "personal", hasTeams: true });
    expect(
      resolveActiveWorkspace({
        teamId: "t2",
        teams: [team("t2", { callerRole: null })],
        organizationsEnabled: true,
      }),
    ).toEqual({ kind: "personal", hasTeams: false });
  });

  it("ignores every team while the organizations gate is off", () => {
    expect(
      resolveActiveWorkspace({ teamId: "t1", teams: [team("t1")], organizationsEnabled: false }),
    ).toEqual({ kind: "personal", hasTeams: false });
  });
});

describe("workspaceName", () => {
  it("conjugates both kinds", () => {
    expect(workspaceName({ kind: "personal", hasTeams: true })).toBe("your personal workspace");
    expect(workspaceName({ kind: "team", team: team("t1", { name: "Engineering" }) })).toBe(
      "Engineering",
    );
  });
});
