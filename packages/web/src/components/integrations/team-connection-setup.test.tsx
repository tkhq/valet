// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
vi.mock("~/api/integrations", () => ({
  usePlugins: () => ({ data: { plugins: [{ name: "linear", version: "1", actionCount: 0, services: [{ service: "linear", type: "oauth2", configKeys: ["accessToken"], connect: "oauth", connected: false, actions: [] }] }] } }),
  useCredentials: () => ({ data: { credentials: [] } }),
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
