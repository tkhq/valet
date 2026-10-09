// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ListPluginsResponse, SkillSummary } from "@valet/api/wire";
const open = vi.fn();
const query = vi.fn();
let teamId: string | undefined;
let data: ListPluginsResponse | undefined;
let error: Error | null;
vi.mock("~/components/layout/workspace-assistant", () => ({ useWorkspaceAssistant: () => ({ open }) }));
vi.mock("~/lib/workspace-scope", () => ({ useWorkspaceScope: () => ({ teamId }) }));
vi.mock("~/api/integrations", () => ({ usePlugins: (team: string | undefined) => { query(team); return { data, error, isLoading: false }; } }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
import { SkillUsage } from "./skill-usage";
const skill: SkillSummary = { name: "drive", origin: "plugin", plugin: "google-workspace", takesArgs: false };
describe("SkillUsage", () => {
  beforeEach(() => { open.mockReset(); query.mockReset(); teamId = undefined; data = undefined; error = null; });
  it("hands an editable prompt to the existing workspace draft flow", () => {
    render(<SkillUsage skill={skill} />);
    fireEvent.click(screen.getByRole("button", { name: "Try in chat" }));
    expect(open).toHaveBeenCalledExactlyOnceWith('Use the "drive" skill to help me with [describe your task].');
    expect(screen.getByText(/Nothing is sent until you send it/)).toBeTruthy();
  });
  it("requests only the active team's connection metadata", () => {
    teamId = "team-1";
    render(<SkillUsage skill={skill} />);
    expect(query).toHaveBeenCalledWith("team-1");
    expect(screen.getByText(/current team workspace/)).toBeTruthy();
  });
  it("reports unavailable status without claiming disconnected", () => {
    error = new Error("offline");
    render(<SkillUsage skill={skill} />);
    expect(screen.getByText(/Connection status is unavailable/)).toBeTruthy();
    expect(screen.queryByText("Not connected")).toBeNull();
  });
  it("uses actual plugin health rather than installation to label connections", () => {
    data = { plugins: [{ name: "google-workspace", version: "1", actionCount: 0, services: [
      { service: "google-drive", type: "oauth2", connect: "oauth", configKeys: [], connected: true, health: { refreshFailed: true }, actions: [] },
      { service: "gmail", type: "oauth2", connect: "oauth", configKeys: [], connected: false, actions: [] },
    ] }] };
    render(<SkillUsage skill={skill} />);
    expect(screen.getByText(/Refresh failed/)).toBeTruthy();
    expect(screen.getByText(/Not connected/)).toBeTruthy();
  });
  it("distinguishes organization-provided connections from missing setup", () => {
    data = { plugins: [{ name: "google-workspace", version: "1", actionCount: 0, services: [
      { service: "google-drive", type: "oauth2", connect: "org", configKeys: [], connected: false, actions: [] },
      { service: "gmail", type: "oauth2", connect: "unconfigured", configKeys: [], connected: false, actions: [] },
    ] }] };
    render(<SkillUsage skill={skill} />);
    expect(screen.getByText(/Provided by your organization/)).toBeTruthy();
    expect(screen.getByText(/Setup required/)).toBeTruthy();
    expect(screen.queryByText(/Not connected/)).toBeNull();
  });
  it("does not fetch connections or try a shadowed stored skill", () => {
    render(<SkillUsage skill={{ name: "drive", origin: "local", id: "s1", ownerType: "team", ownerId: "team-1", shadowed: true, takesArgs: false, updatedAt: 0 }} />);
    fireEvent.click(screen.getByRole("button", { name: "Try in chat" }));
    expect(open).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
