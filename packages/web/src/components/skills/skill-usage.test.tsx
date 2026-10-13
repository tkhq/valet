// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ListPluginsResponse, SkillSummary, ToolPermissionWire } from "@valet/api/wire";
const open = vi.fn();
const query = vi.fn();
let teamId: string | undefined;
let data: ListPluginsResponse | undefined;
let error: Error | null;
vi.mock("~/components/layout/workspace-assistant", () => ({ useWorkspaceAssistant: () => ({ open }) }));
vi.mock("~/lib/workspace-scope", () => ({ useWorkspaceScope: () => ({ teamId }) }));
let tools: ToolPermissionWire[] = [];
vi.mock("~/api/policies", () => ({ useMyToolPermissions: () => ({ data: { tools } }) }));
vi.mock("~/api/integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/api/integrations")>()),
  usePlugins: (team: string | undefined) => { query(team); return { data, error, isLoading: false }; },
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, search }: { children: ReactNode; to: string; search?: Record<string, string> }) =>
    <a href={search ? `${to}?${new URLSearchParams(search)}` : to}>{children}</a>,
}));
import { SkillUsage } from "./skill-usage";
const skill: SkillSummary = { name: "drive", origin: "plugin", plugin: "google-workspace", takesArgs: false };
describe("SkillUsage", () => {
  beforeEach(() => { open.mockReset(); query.mockReset(); teamId = undefined; data = undefined; error = null; tools = []; });
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
  it("lists the integrations that ship the skill as Integrations rows that open their panel", () => {
    data = { plugins: [
      { name: "google-workspace", version: "1", actionCount: 0, services: [
        { service: "google-drive", type: "oauth2", connect: "oauth", configKeys: [], connected: true, health: { refreshFailed: true }, actions: [] },
      ] },
      { name: "gmail", version: "1", actionCount: 1, services: [], actionServices: [{ service: "gmail", actions: [] }], skills: [{ name: "drive" }] },
      { name: "linear", version: "1", actionCount: 0, services: [], skills: [{ name: "triage" }] },
    ] };
    tools = [{ service: "gmail", actionId: "gmail.send", name: "Send", description: "", riskLevel: "medium",
      mode: "require_approval", source: "default", overridden: false, settable: ["allow", "require_approval", "deny"] }];
    render(<SkillUsage skill={skill} />);
    const links = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(links).toEqual(["/integrations?service=google-workspace", "/integrations?service=gmail"]);
    // The same row grammar as Integrations: the pill, and your tool summary.
    expect(screen.getByText("Refresh failed")).toBeTruthy();
    expect(screen.getAllByText("1 tool · 1 ask").length).toBeGreaterThan(0);
  });
  it("leaves your own tool summary out of a team workspace", () => {
    teamId = "team-1";
    data = { plugins: [{ name: "gmail", version: "1", actionCount: 1, services: [], actionServices: [{ service: "gmail", actions: [] }], skills: [{ name: "drive" }] }] };
    tools = [{ service: "gmail", actionId: "gmail.send", name: "Send", description: "", riskLevel: "medium",
      mode: "require_approval", source: "default", overridden: false, settable: ["allow", "require_approval", "deny"] }];
    render(<SkillUsage skill={skill} />);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/integrations?service=gmail");
    expect(screen.queryByText(/1 tool/)).toBeNull();
  });
  it("does not fetch connections or try a shadowed stored skill", () => {
    render(<SkillUsage skill={{ name: "drive", origin: "local", id: "s1", ownerType: "team", ownerId: "team-1", shadowed: true, takesArgs: false, updatedAt: 0 }} />);
    fireEvent.click(screen.getByRole("button", { name: "Try in chat" }));
    expect(open).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
