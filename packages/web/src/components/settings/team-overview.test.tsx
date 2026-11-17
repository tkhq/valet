// @vitest-environment jsdom
/**
 * Team General overview: one link row per team tab, with the current value
 * from the query each tab already makes, and no Usage row for an org admin
 * who is not on the team.
 */
import { cleanup, render, screen } from "@testing-library/react";
import type { TeamSummary } from "@valet/api/wire";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, hash, children }: { to: string; params?: Record<string, string>; hash?: string; children: ReactNode }) => (
    <a href={`${to.replace("$teamId", params?.teamId ?? "")}${hash ? `#${hash}` : ""}`}>{children}</a>
  ),
}));

let secretsEnabled = true;
let loading = false;
vi.mock("~/api/integrations", () => ({
  useCredentials: () => ({ data: loading ? undefined : { credentials: [{ service: "github" }, { service: "github" }, { service: "linear" }] } }),
}));
vi.mock("~/api/onepassword", () => ({ useTeamOnePasswordStatus: () => ({ data: { tokenConnected: true } }) }));
vi.mock("~/api/secrets", () => ({
  useSecrets: () => ({ data: loading ? undefined : { enabled: secretsEnabled, secrets: [{ name: "A" }] } }),
}));
vi.mock("~/api/api-keys", () => ({ useTeamApiKeys: () => ({ data: loading ? undefined : [] }) }));
vi.mock("~/api/policies", () => ({ usePolicies: () => ({ data: loading ? undefined : { policies: [{}, {}] } }) }));

import { TeamOverview } from "./team-overview";

function team(callerRole: TeamSummary["callerRole"]): TeamSummary {
  return {
    id: "t1", orgId: "o1", name: "Platform", origin: "local", externalId: null, createdAt: 1,
    memberCount: 4, callerRole, defaultModel: null, defaultReasoning: null,
  };
}

function row(name: string) {
  return screen.getByRole("link", { name: new RegExp(`^${name}`) });
}

beforeEach(() => {
  secretsEnabled = true;
  loading = false;
});
afterEach(cleanup);

describe("TeamOverview", () => {
  it("links each tab and shows its current value", () => {
    render(<TeamOverview team={team("member")} />);
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "/settings/teams/t1#members",
      "/settings/teams/t1/integrations",
      "/settings/teams/t1/secrets",
      "/settings/teams/t1/access",
      "/settings/teams/t1/policies",
      "/settings/teams/t1/usage",
    ]);
    expect(row("Members").textContent).toContain("4 members");
    // Two GitHub rows are one service. 1Password counts as a row.
    expect(row("Integrations").textContent).toContain("3 connected");
    expect(row("Secrets").textContent).toContain("1 secret");
    expect(row("Access").textContent).toContain("None");
    expect(row("Policies").textContent).toContain("2 rules");
  });

  it("says Off when the deployment has no secret store", () => {
    secretsEnabled = false;
    render(<TeamOverview team={team("admin")} />);
    expect(row("Secrets").textContent).toContain("Off");
  });

  it("shows no value while a query loads", () => {
    loading = true;
    render(<TeamOverview team={team("member")} />);
    expect(row("Access").textContent).toBe("AccessAPI keys and the model proxy for this team.");
    expect(row("Integrations").textContent).toBe("IntegrationsAccounts that team actions use.");
  });

  it("hides Usage from an org admin who is not on the team", () => {
    render(<TeamOverview team={team(null)} />);
    expect(screen.queryByRole("link", { name: /^Usage/ })).toBeNull();
    expect(row("Policies")).toBeTruthy();
  });
});
