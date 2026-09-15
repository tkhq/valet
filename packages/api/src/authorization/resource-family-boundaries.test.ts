import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { ResourceAuthorizationError } from "./resource-authorization.js";
import { actionPolicies, artifacts, contentSources, credentials } from "../schema/index.js";

let api: TestApi | undefined;
afterEach(async () => { vi.restoreAllMocks(); await api?.cleanup(); api = undefined; });

function denyResources() {
  const authorize = vi.spyOn(api!.providers.resourceAuthorizationPort, "authorize").mockRejectedValue(new ResourceAuthorizationError("deny"));
  return authorize;
}

describe("direct resource family boundaries", () => {
  it("blocks credential values before storage and excludes the secret canary", async () => {
    api = await bootTestApi();
    const authorize = denyResources();
    const canary = "credential-body-canary";
    const response = await fetch(`${api.baseUrl}/api/credentials/github`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "api_key", apiKey: canary }),
    });
    expect(response.ok).toBe(false);
    expect(await api.providers.db.select().from(credentials)).toHaveLength(0);
    expect(JSON.stringify(authorize.mock.calls)).not.toContain(canary);
  });

  it("blocks repository import before source mutation and excludes the URL", async () => {
    api = await bootTestApi();
    const authorize = denyResources();
    const canary = "https://github.com/example/repository-canary";
    const sync = vi.spyOn(api.providers.contentSync, "syncOnce");
    const response = await fetch(`${api.baseUrl}/api/skills/sources`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: canary }),
    });
    expect(response.ok).toBe(false);
    expect(await api.providers.db.select().from(contentSources)).toHaveLength(0);
    expect(sync).not.toHaveBeenCalled();
    expect(JSON.stringify(authorize.mock.calls)).not.toContain(canary);
  });

  it("blocks artifact publication before writes and excludes content", async () => {
    api = await bootTestApi();
    const authorize = denyResources();
    const canary = "artifact-content-canary";
    const response = await fetch(`${api.baseUrl}/api/artifacts/share`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "blocked.md", content: canary, format: "markdown" }),
    });
    expect(response.ok).toBe(false);
    expect(await api.providers.db.select().from(artifacts)).toHaveLength(0);
    expect(JSON.stringify(authorize.mock.calls)).not.toContain(canary);
  });

  it("blocks structured policy activation before writes and excludes the body", async () => {
    api = await bootTestApi();
    const authorize = denyResources();
    const canary = "policy-body-canary";
    const response = await fetch(`${api.baseUrl}/api/org/policies`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: canary, mode: "deny" }),
    });
    expect(response.ok).toBe(false);
    expect(await api.providers.db.select().from(actionPolicies)).toHaveLength(0);
    expect(JSON.stringify(authorize.mock.calls)).not.toContain(canary);
  });
});
