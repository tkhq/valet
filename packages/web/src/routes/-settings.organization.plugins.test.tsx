// @vitest-environment jsdom
/**
 * Organization · Plugins (plugin-entitlements design): the entitlement rail.
 * Mocks `~/api/settings` the same way `-settings.organization.test.tsx` does —
 * these tests care what the page renders and which mutation it fires, not that
 * TanStack Query resolves anything.
 *
 * Covered: a gateable plugin renders; switching to "specific teams" reveals
 * the team picker; picking teams + the mode call `patchOrgPlugin` with the
 * right `{ mode, teamIds }`; a non-admin gets disabled controls; an
 * `instanceEnabled:false` plugin renders disabled with the unavailable badge.
 */
import type { ReactElement } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OrgPluginWire, TeamSummary } from "@valet/api/wire";

const patchOrgPluginMutate = vi.fn();

let callerRole: "admin" | "member" = "admin";
let pluginsData: { plugins: OrgPluginWire[] } = { plugins: [] };
let teamsData: { teams: TeamSummary[] } = { teams: [] };

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
}));

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useOrg: () => ({ data: { callerRole }, isLoading: false, error: null }),
    useOrgPlugins: () => ({ data: pluginsData, isLoading: false, error: null }),
    useTeams: () => ({ data: teamsData, isLoading: false, error: null }),
    usePatchOrgPlugin: () => ({ mutate: patchOrgPluginMutate, isPending: false, error: null }),
  };
});

import { OrganizationPluginsPage } from "./settings.organization.plugins";

function renderPage(): ReactElement {
  return <OrganizationPluginsPage />;
}

const securityPlugin: OrgPluginWire = {
  name: "security",
  label: "Valet Security",
  description: "Automated code security reviews.",
  instanceEnabled: true,
  entitlement: { mode: "all", teamIds: [] },
  enabledForCaller: true,
};

const teams: TeamSummary[] = [
  { id: "team_1", orgId: "org_1", name: "Platform", origin: "local", externalId: null, createdAt: 0, memberCount: 2, callerRole: "admin", defaultModel: null },
  { id: "team_2", orgId: "org_1", name: "Growth", origin: "local", externalId: null, createdAt: 0, memberCount: 1, callerRole: null, defaultModel: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  callerRole = "admin";
  pluginsData = { plugins: [securityPlugin] };
  teamsData = { teams: [] };
});

describe("OrganizationPluginsPage", () => {
  it("renders a gateable plugin with its label, description, and mode radio", () => {
    render(renderPage());
    expect(screen.getByText("Valet Security")).toBeTruthy();
    expect(screen.getByText("Automated code security reviews.")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Off" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "All users" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Specific teams" })).toBeTruthy();
    // "all" mode is selected from the entitlement.
    expect(screen.getByRole("radio", { name: "All users" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("choosing a different mode fires patchOrgPlugin with that mode", async () => {
    const user = userEvent.setup();
    render(renderPage());
    await user.click(screen.getByRole("radio", { name: "Off" }));
    expect(patchOrgPluginMutate).toHaveBeenCalledWith(
      { name: "security", body: { mode: "off", teamIds: [] } },
      expect.objectContaining({ onSettled: expect.any(Function) }),
    );
  });

  it("switching to specific teams reveals the team picker", async () => {
    const user = userEvent.setup();
    teamsData = { teams };
    render(renderPage());
    // No picker yet in "all" mode.
    expect(screen.queryByRole("checkbox", { name: "Platform" })).toBeNull();

    await user.click(screen.getByRole("radio", { name: "Specific teams" }));
    expect(screen.getByRole("checkbox", { name: "Platform" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Growth" })).toBeTruthy();
  });

  it("selecting a team saves the mode + teamIds", async () => {
    const user = userEvent.setup();
    teamsData = { teams };
    render(renderPage());

    await user.click(screen.getByRole("radio", { name: "Specific teams" }));
    patchOrgPluginMutate.mockClear();
    await user.click(screen.getByRole("checkbox", { name: "Growth" }));

    expect(patchOrgPluginMutate).toHaveBeenCalledWith(
      { name: "security", body: { mode: "teams", teamIds: ["team_2"] } },
      expect.objectContaining({ onSettled: expect.any(Function) }),
    );
  });

  it("hints to create a team when specific teams is chosen with no teams", async () => {
    const user = userEvent.setup();
    teamsData = { teams: [] };
    render(renderPage());
    await user.click(screen.getByRole("radio", { name: "Specific teams" }));
    expect(screen.getByText("Create a team first in Settings → Teams.")).toBeTruthy();
  });

  it("disables the mode radio for a non-admin", () => {
    callerRole = "member";
    render(renderPage());
    expect((screen.getByRole("radio", { name: "Off" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("radio", { name: "All users" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("renders an instanceEnabled:false plugin disabled with the unavailable badge", () => {
    pluginsData = {
      plugins: [{ ...securityPlugin, instanceEnabled: false, enabledForCaller: false }],
    };
    render(renderPage());
    expect(screen.getByText("Unavailable on this deployment")).toBeTruthy();
    expect((screen.getByRole("radio", { name: "Off" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
