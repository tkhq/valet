// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
let teamCredentials: Array<{ service: string; type: string; connectedAt: string; delegatedFrom?: string }> = [];
vi.mock("~/api/integrations", () => ({
  usePlugins: () => ({ data: { plugins: [{ name: "linear", version: "1", actionCount: 0, services: [{ service: "linear", type: "oauth2", configKeys: ["accessToken"], connect: "oauth", connected: false, actions: [] }] }] } }),
  useCredentials: () => ({ data: { credentials: teamCredentials } }),
  useConnectCredential: () => ({ mutate: vi.fn(), isPending: false }),
}));
import { TeamConnectionSetup } from "./team-connection-setup";
it("offers a team connection like any other service, with no organization block", () => {
  render(<TeamConnectionSetup teamId="team" canManage />);
  expect(screen.queryByText("Organization access")).toBeNull();
  expect(screen.queryByText("Optional MCP tools")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Connect Linear" }));
  expect(screen.getByRole("dialog").textContent).toContain("Connect Linear to this team");
});

it("offers the team's own connection beside a member's shared account, and hides it once the team has one", () => {
  teamCredentials = [{ service: "linear", type: "oauth2", connectedAt: "2026-10-14", delegatedFrom: "member-1" }];
  const { unmount } = render(<TeamConnectionSetup teamId="team" canManage />);
  expect(screen.getByRole("button", { name: "Connect Linear" })).toBeTruthy();
  unmount();
  teamCredentials = [{ service: "linear", type: "oauth2", connectedAt: "2026-10-14" }];
  render(<TeamConnectionSetup teamId="team" canManage />);
  expect(screen.queryByRole("button", { name: "Connect Linear" })).toBeNull();
  teamCredentials = [];
});
