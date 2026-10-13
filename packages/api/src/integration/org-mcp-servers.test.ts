/**
 * `GET /api/org/mcp-servers` — the read-only list of MCP servers declared in
 * the instance config (`valet.yaml` `mcpServers`). Boots the real app with
 * config entries handed to the harness the way `main.ts` hands them to
 * `buildNodeProviders`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "./_setup.js";
import type { McpServerDecl } from "../config/instance-config.js";
import type { OrgMcpServersResponse } from "../wire/types.js";

const MEMBER = "test-member";

const SERVERS: McpServerDecl[] = [
  {
    name: "metabase",
    displayName: "Acme Metabase",
    url: "https://metabase.example.com/api/metabase-mcp",
    auth: "oauth",
    scopes: ["agent:query"],
    description: "BI dashboards",
    riskLevel: "low",
  },
  {
    name: "docs",
    url: "https://docs.example.com/mcp",
    auth: "bearer",
    tokenEnv: "DOCS_MCP_TOKEN",
    authQueryParam: "key",
  },
  { name: "parked", url: "https://parked.example.com/mcp", auth: "none", enabled: false },
];

async function getServers(api: TestApi, userId: string): Promise<Response> {
  return fetch(`${api.baseUrl}/api/org/mcp-servers`, {
    headers: { "x-valet-test-user-id": userId },
  });
}

describe("GET /api/org/mcp-servers", () => {
  let api: TestApi;
  afterEach(async () => {
    await api?.cleanup();
  });

  it("lists every config entry to a plain member, without secret-adjacent fields", async () => {
    api = await bootTestApi({ mcpServers: SERVERS });
    const res = await getServers(api, MEMBER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OrgMcpServersResponse;

    expect(body.servers).toEqual([
      {
        name: "metabase",
        displayName: "Acme Metabase",
        url: "https://metabase.example.com/api/metabase-mcp",
        auth: "oauth",
        scopes: ["agent:query"],
        description: "BI dashboards",
        riskLevel: "low",
        enabled: true,
        connected: false,
      },
      {
        name: "docs",
        displayName: "Docs",
        url: "https://docs.example.com/mcp",
        auth: "bearer",
        scopes: [],
        description: null,
        riskLevel: "medium",
        enabled: true,
        connected: null,
      },
      {
        name: "parked",
        displayName: "Parked",
        url: "https://parked.example.com/mcp",
        auth: "none",
        scopes: [],
        description: null,
        riskLevel: "medium",
        enabled: false,
        connected: null,
      },
    ]);
    // The env var name and the query-param name say where a token goes.
    // Neither is needed to read the list.
    expect(JSON.stringify(body)).not.toContain("DOCS_MCP_TOKEN");
    expect(JSON.stringify(body)).not.toContain("authQueryParam");
  });

  it("reports the caller's own connection for a per-user auth entry", async () => {
    api = await bootTestApi({ mcpServers: SERVERS });
    await api.providers.engineCredentials.save(
      { type: "user", id: MEMBER },
      "metabase",
      { type: "oauth2", accessToken: "tok" },
    );
    const body = (await (await getServers(api, MEMBER)).json()) as OrgMcpServersResponse;
    expect(body.servers.find((s) => s.name === "metabase")?.connected).toBe(true);
  });

  it("returns an empty list when the deployment declares no servers", async () => {
    api = await bootTestApi();
    const body = (await (await getServers(api, MEMBER)).json()) as OrgMcpServersResponse;
    expect(body.servers).toEqual([]);
  });
});
