// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
let admin = true;
let ready = false;
let failed = false;
const retry = vi.fn();
vi.mock("~/api/settings", () => ({ useOrg: () => ({ data: { features: { organizations: true }, callerRole: admin ? "admin" : "member" } }) }));
vi.mock("~/api/workflows", () => ({ useTriggerCatalog: () => ({ error: failed ? new Error("offline") : null, refetch: retry, data: { catalog: [{ service: "linear", readiness: { ready } }] } }) }));
import { LinearOrgConnection } from "./linear-org-connection";
beforeEach(() => { admin = true; ready = false; failed = false; retry.mockClear(); });
it("routes native setup to the existing organization page", () => {
  render(<LinearOrgConnection />);
  expect(screen.getByRole("link", { name: "Connect Linear" }).getAttribute("href")).toBe("/settings/organization/linear");
  expect(screen.getByText("Not connected")).toBeTruthy();
});
it("names the native connection separately from tools and provides management once ready", () => {
  ready = true; render(<LinearOrgConnection />);
  expect(screen.getByText("Connected by your organization")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Manage Linear" })).toBeTruthy();
  expect(screen.queryByText(/MCP/)).toBeNull();
});
it("explains the admin requirement to members without offering an inaccessible setup link", () => {
  admin = false; render(<LinearOrgConnection />);
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByText(/organization admin/)).toBeTruthy();
});
it("does not present cached readiness as current after an error", () => {
  ready = true; failed = true; render(<LinearOrgConnection />);
  expect(screen.queryByText("Connected by your organization")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledOnce();
});

it("shows members that their organization is connected without asking them to connect", () => {
  admin = false; ready = true; render(<LinearOrgConnection />);
  expect(screen.getByText("Connected by your organization")).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.queryByText(/Ask an organization admin/)).toBeNull();
});
