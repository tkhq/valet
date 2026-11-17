// @vitest-environment jsdom
/**
 * Team and personal settings scope (settings-redesign spec, decisions 1-2):
 * a team's settings live on `/settings/teams/$teamId` and pin that team's
 * scope; the personal pages pin personal scope; neither follows the
 * workspace switcher.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PinnedWorkspaceScope, useWorkspaceScope } from "~/lib/workspace-scope";

let pathname = "/settings/teams/t1";

function ScopeProbe({ label }: { label: string }) {
  const { teamId } = useWorkspaceScope();
  return <span>{`${label}: ${teamId ?? "personal"}`}</span>;
}

function TabWithDraft() {
  const [draft, setDraft] = useState("");
  return (
    <>
      <ScopeProbe label="tab" />
      <input aria-label="Draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
    </>
  );
}

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  useRouterState: () => pathname,
  useSearch: () => ({}),
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode; "aria-current"?: "page" }) => (
    <a href={to} aria-current={rest["aria-current"]}>{children}</a>
  ),
  Outlet: () => <TabWithDraft />,
}));
vi.mock("~/api/settings", () => ({
  useOrg: () => ({ data: { callerRole: "member", features: { organizations: true } }, isLoading: false, error: null }),
  useTeams: () => ({
    data: {
      teams: [
        { id: "t1", name: "team-tvc", callerRole: "member" },
        { id: "t2", name: "platform", callerRole: "admin" },
        { id: "t9", name: "other", callerRole: null },
      ],
    },
    isLoading: false,
    error: null,
  }),
}));
vi.mock("~/components/settings/api-keys-section", () => ({ ApiKeysSection: () => <ScopeProbe label="keys" /> }));
vi.mock("~/components/settings/proxy-section", () => ({
  SettingsProxyPage: ({ children }: { children?: ReactNode }) => <><ScopeProbe label="proxy" />{children}</>,
}));
vi.mock("~/components/settings/agent-access-section", () => ({
  AgentAccessSection: () => <ScopeProbe label="agents" />,
  AgentSetupCard: () => <ScopeProbe label="agent setup" />,
}));

import { TeamSettingsShell } from "./settings.teams.$teamId";
import { PersonalAccessPage } from "./settings.access";

beforeEach(() => {
  pathname = "/settings/teams/t1";
});

describe("team settings pages", () => {
  it("names the team, links its threads, and pins its scope for the tab", () => {
    render(<TeamSettingsShell teamId="t1" />);
    expect(screen.getByRole("heading", { name: "team-tvc" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open team threads" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "General" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("tab: t1")).toBeTruthy();
  });

  it("drops a draft when another of the caller's teams opens", () => {
    // Both teams are the caller's, so the same tab stays mounted across the
    // change. Only the Outlet's key stops t1's draft from showing under t2.
    const view = render(<TeamSettingsShell teamId="t1" />);
    fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "half-typed key" } });
    view.rerender(<TeamSettingsShell teamId="t2" />);
    expect(screen.getByRole("heading", { name: "platform" })).toBeTruthy();
    expect(screen.getByText("tab: t2")).toBeTruthy();
    expect(screen.getByLabelText("Draft")).toHaveProperty("value", "");
  });

  it("marks the tab that matches the path", () => {
    pathname = "/settings/teams/t1/access";
    render(<TeamSettingsShell teamId="t1" />);
    expect(screen.getByRole("link", { name: "Access" }).getAttribute("aria-current")).toBe("page");
  });

  it("holds the team's Integrations and Usage beside its other settings", () => {
    pathname = "/settings/teams/t1/integrations";
    render(<TeamSettingsShell teamId="t1" />);
    expect(screen.getAllByRole("link").map((link) => link.textContent).filter((label) => label !== "Open team threads"))
      .toEqual(["General", "Integrations", "Usage", "Access", "Policies"]);
    expect(screen.getByRole("link", { name: "Integrations" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "General" }).getAttribute("aria-current")).toBeNull();
  });

  it("refuses a team the caller is not on", () => {
    render(<TeamSettingsShell teamId="t9" />);
    expect(screen.getByText(/not a member of this team/)).toBeTruthy();
    expect(screen.queryByText(/^tab:/)).toBeNull();
  });
});

describe("personal pages", () => {
  it("keep personal scope while the switcher holds a team", () => {
    render(<PinnedWorkspaceScope teamId="t1"><PersonalAccessPage /></PinnedWorkspaceScope>);
    expect(screen.getByText("keys: personal")).toBeTruthy();
    expect(screen.getByText("proxy: personal")).toBeTruthy();
    expect(screen.getByText("agents: personal")).toBeTruthy();
  });
});
