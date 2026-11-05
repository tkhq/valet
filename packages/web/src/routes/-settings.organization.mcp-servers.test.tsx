// @vitest-environment jsdom
/**
 * Organization · MCP servers: the read-only list of config-declared MCP
 * servers. Mocks `~/api/settings` the same way the Plugins page test does.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { OrgMcpServerWire } from "@valet/api/wire";

let serversData: { servers: OrgMcpServerWire[] } = { servers: [] };

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
}));

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useOrgMcpServers: () => ({ data: serversData, isLoading: false, error: null }),
  };
});

import { OrganizationMcpServersPage } from "./settings.organization.mcp-servers";

const metabase: OrgMcpServerWire = {
  name: "metabase",
  displayName: "Acme Metabase",
  url: "https://metabase.example.com/api/metabase-mcp",
  auth: "oauth",
  scopes: ["agent:query", "agent:question:execute"],
  description: "BI dashboards",
  riskLevel: "low",
  enabled: true,
  connected: false,
};

const docs: OrgMcpServerWire = {
  name: "docs",
  displayName: "Docs",
  url: "https://docs.example.com/mcp",
  auth: "bearer",
  scopes: [],
  description: null,
  riskLevel: "medium",
  enabled: true,
  connected: null,
};

const parked: OrgMcpServerWire = {
  ...docs,
  name: "parked",
  displayName: "Parked",
  url: "https://parked.example.com/mcp",
  auth: "none",
  enabled: false,
};

beforeEach(() => {
  serversData = { servers: [metabase, docs, parked] };
});

describe("OrganizationMcpServersPage", () => {
  it("shows each server's name, URL, auth, risk and scopes", () => {
    render(<OrganizationMcpServersPage />);
    const row = screen.getByRole("listitem", { name: "Acme Metabase" });
    expect(within(row).getByText("BI dashboards")).toBeTruthy();
    expect(within(row).getByText("https://metabase.example.com/api/metabase-mcp")).toBeTruthy();
    expect(within(row).getByText("metabase.*")).toBeTruthy();
    expect(within(row).getByText("Per-user OAuth")).toBeTruthy();
    expect(within(row).getByText("Low risk")).toBeTruthy();
    expect(within(row).getByText("agent:query, agent:question:execute")).toBeTruthy();
    expect(within(row).getByText("Not connected")).toBeTruthy();
  });

  it("marks shared-credential and disabled entries", () => {
    render(<OrganizationMcpServersPage />);
    const docsRow = screen.getByRole("listitem", { name: "Docs" });
    expect(within(docsRow).getByText("Shared token")).toBeTruthy();
    expect(within(docsRow).queryByText(/connected/i)).toBeNull();
    const parkedRow = screen.getByRole("listitem", { name: "Parked" });
    expect(within(parkedRow).getByText("Disabled in config")).toBeTruthy();
  });

  it("explains where servers come from when none are declared", () => {
    serversData = { servers: [] };
    render(<OrganizationMcpServersPage />);
    expect(screen.getByText(/No MCP servers are declared/)).toBeTruthy();
  });
});
