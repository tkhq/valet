// @vitest-environment jsdom
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { OrgDirectoryUserWire } from "@valet/api/wire";

let teamId: string | undefined;
let pathname = "/settings/profile";
let directory: { data?: { users: OrgDirectoryUserWire[] }; isLoading: boolean; error: Error | null };
const personalSave = vi.fn();
const teamSave = vi.fn();
const directoryRead = vi.fn();

function PersonalForm() {
  const [draft, setDraft] = useState("");
  return <><input aria-label="Personal draft" value={draft} onChange={(e) => setDraft(e.target.value)} /><button onClick={() => personalSave(draft)}>Save personal</button></>;
}

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  useRouterState: () => pathname,
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  Navigate: ({ to }: { to: string }) => <div data-testid="redirect">{to}</div>,
  Outlet: () => pathname === "/settings/team" ? <TeamSettingsPage /> : pathname.startsWith("/settings/organization") ? <p>Organization content</p> : <PersonalForm />,
}));
vi.mock("~/lib/workspace-scope", () => ({
  useWorkspaceScope: () => ({ teamId, key: teamId ?? "user" }),
}));
vi.mock("~/api/settings", () => ({
  useOrg: () => ({ data: { callerRole: "member", features: { organizations: true } } }),
  useOrgDirectory: () => { directoryRead(); return directory; },
}));
// The real panel's permission and mutation targets have their own tests.
// This draft verifies that the route replaces its child on a scope change.
vi.mock("~/components/settings/teams-panel", () => ({
  TeamsPanel: ({ teamId: target }: { teamId: string }) => {
    const [draft, setDraft] = useState("");
    return <><span>{target}</span><input aria-label="Team draft" value={draft} onChange={(e) => setDraft(e.target.value)} /><button onClick={() => teamSave(target, draft)}>Save team</button></>;
  },
}));

import { SettingsLayout } from "./settings";
import { TeamSettingsPage } from "./settings.team";

beforeEach(() => {
  teamId = undefined;
  pathname = "/settings/profile";
  directory = { data: { users: [] }, isLoading: false, error: null };
  personalSave.mockClear();
  teamSave.mockClear();
  directoryRead.mockClear();
});

describe("settings workspace routing", () => {
  it("keeps personal navigation and forms unchanged", () => {
    render(<SettingsLayout />);
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Profile" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Appearance" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Personal draft"), { target: { value: "personal" } });
    fireEvent.click(screen.getByRole("button", { name: "Save personal" }));
    expect(personalSave).toHaveBeenCalledWith("personal");
    expect(directoryRead).not.toHaveBeenCalled();
  });

  it.each(["/settings", "/settings/profile", "/settings/appearance", "/settings/assistant", "/settings/api-keys", "/settings/policies"])("does not mount personal forms at %s in team scope", (path) => {
    teamId = "team_1";
    pathname = path;
    render(<SettingsLayout />);
    expect(screen.getByText("Team")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Profile" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Appearance" })).toBeNull();
    expect(screen.getByRole("link", { name: "General" }).getAttribute("href")).toBe("/settings/team");
    expect(screen.getByTestId("redirect").textContent).toBe("/settings/team");
    expect(screen.queryByRole("button", { name: "Save personal" })).toBeNull();
  });

  it("drops personal drafts when entering and leaving a team", () => {
    const view = render(<SettingsLayout />);
    fireEvent.change(screen.getByLabelText("Personal draft"), { target: { value: "old personal draft" } });
    teamId = "team_1";
    view.rerender(<SettingsLayout />);
    expect(screen.queryByLabelText("Personal draft")).toBeNull();
    pathname = "/settings/team";
    view.rerender(<SettingsLayout />);
    expect(screen.getByText("team_1")).toBeTruthy();
    teamId = undefined;
    view.rerender(<SettingsLayout />);
    expect(screen.getByTestId("redirect").textContent).toBe("/settings/profile");
    expect(screen.queryByLabelText("Team draft")).toBeNull();
    pathname = "/settings/profile";
    view.rerender(<SettingsLayout />);
    expect(screen.getByLabelText("Personal draft")).toHaveProperty("value", "");
    expect(personalSave).not.toHaveBeenCalled();
    expect(teamSave).not.toHaveBeenCalled();
  });

  it("drops team drafts before changing their mutation target", () => {
    teamId = "team_1";
    pathname = "/settings/team";
    const view = render(<SettingsLayout />);
    fireEvent.change(screen.getByLabelText("Team draft"), { target: { value: "team one draft" } });
    teamId = "team_2";
    view.rerender(<SettingsLayout />);
    expect(screen.getByLabelText("Team draft")).toHaveProperty("value", "");
    fireEvent.change(screen.getByLabelText("Team draft"), { target: { value: "team two draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save team" }));
    expect(teamSave).toHaveBeenCalledExactlyOnceWith("team_2", "team two draft");
  });

  it("keeps organization routes reachable in team scope", () => {
    teamId = "team_1";
    pathname = "/settings/organization/teams";
    render(<SettingsLayout />);
    expect(screen.queryByTestId("redirect")).toBeNull();
    expect(screen.getByRole("link", { name: "Teams" })).toBeTruthy();
    expect(screen.getByText("Organization content")).toBeTruthy();
  });
});

describe("team settings loading", () => {
  beforeEach(() => { teamId = "team_1"; });
  it("redirects personal callers without reading the directory", () => {
    teamId = undefined;
    render(<TeamSettingsPage />);
    expect(screen.getByTestId("redirect").textContent).toBe("/settings/profile");
    expect(directoryRead).not.toHaveBeenCalled();
  });
  it("shows loading without mounting mutation controls", () => {
    directory = { isLoading: true, error: null };
    render(<TeamSettingsPage />);
    expect(screen.getByText("Loading team settings…")).toBeTruthy();
    expect(screen.queryByLabelText("Team draft")).toBeNull();
  });
  it("blocks stale data after a directory error", () => {
    directory.error = new Error("forbidden");
    render(<TeamSettingsPage />);
    expect(screen.getByText(/Failed to load the member directory/)).toBeTruthy();
    expect(screen.queryByLabelText("Team draft")).toBeNull();
  });
  it("handles a missing directory result", () => {
    directory = { isLoading: false, error: null };
    render(<TeamSettingsPage />);
    expect(screen.getByText(/Team settings are unavailable/)).toBeTruthy();
  });
});
