import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions } from "../schema/index.js";

describe("browser routes", () => {
  let api: TestApi | undefined;
  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });
  async function setup(owner = "local-user") {
    api = await bootTestApi();
    await api.providers.db
      .insert(agentSessions)
      .values({
        id: "browser-session",
        userId: owner,
        ownerType: "user",
        ownerId: owner,
        orgId: "local-org",
        workspace: "/tmp/browser-session",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    return `${api.baseUrl}/api/sessions/browser-session/browser`;
  }
  it("reports unsupported providers without creating a browser", async () => {
    const url = await setup();
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      enabled: false,
      status: null,
      actorId: "local-user",
    });
    expect(api?.providers.engineHost.liveSession("browser-session")).toBeNull();
  });
  it("hides another owner’s browser", async () => {
    const url = await setup("test-member");
    expect((await fetch(url)).status).toBe(404);
  });
  it("rejects cross-origin browser control before touching the runtime", async () => {
    const url = await setup();
    const response = await fetch(`${url}/control`, {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "take" }),
    });
    expect(response.status).toBe(403);
    expect(api?.providers.engineHost.liveSession("browser-session")).toBeNull();
  });
  it("does not issue tickets without a running authorized browser", async () => {
    const url = await setup();
    const response = await fetch(`${url}/ticket`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "view" }),
    });
    expect(response.status).toBe(409);
  });
  it("rejects caller-supplied browser identity fields", async () => {
    const url = await setup();
    const response = await fetch(`${url}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "take",
        actorId: "other",
        audience: "lifecycle",
      }),
    });
    expect(response.status).toBe(400);
  });
});
