/**
 * `GET /api/org/slack` — the manifest an operator installs, plus the
 * connection state of the org credential. Admin-gated.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { GetSlackAppResponse } from "../wire/types.js";

let api: TestApi | undefined;
const savedPublicUrl = process.env.VALET_PUBLIC_URL;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  if (savedPublicUrl === undefined) delete process.env.VALET_PUBLIC_URL;
  else process.env.VALET_PUBLIC_URL = savedPublicUrl;
});

async function get(baseUrl: string, query = "", headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}/api/org/slack${query}`, { headers });
}

describe("GET /api/org/slack", () => {
  it("reports socket mode when the deployment has no public URL", async () => {
    delete process.env.VALET_PUBLIC_URL;
    api = await bootTestApi();

    const res = await get(api.baseUrl);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetSlackAppResponse;

    expect(body.ingress).toBe("socket_mode");
    expect(body.requestUrl).toBeNull();
    expect(body.manifest.settings.socket_mode_enabled).toBe(true);
    expect(body.connected).toBe(false);
  });

  it("points the manifest at this deployment's own webhook URL", async () => {
    process.env.VALET_PUBLIC_URL = "https://valet.example.com";
    api = await bootTestApi();

    const body = (await (await get(api.baseUrl)).json()) as GetSlackAppResponse;

    expect(body.ingress).toBe("webhook");
    expect(body.requestUrl).toBe("https://valet.example.com/api/channels/slack/webhook");
    expect(body.manifest.settings.event_subscriptions.request_url).toBe(body.requestUrl);
    expect(body.requiredScopes).toContain("assistant:write");
  });

  it("names the app from the query so two deployments are distinguishable", async () => {
    api = await bootTestApi();

    const body = (await (await get(api.baseUrl, "?name=Valet%20Dev")).json()) as GetSlackAppResponse;

    expect(body.manifest.display_information.name).toBe("Valet Dev");
    expect(body.manifest.features.bot_user.display_name).toBe("Valet Dev");
  });

  it("reports the connected workspace and the scopes the install withheld", async () => {
    api = await bootTestApi();
    await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", {
      type: "bot_token",
      accessToken: "xoxb-test-token",
      scopes: ["assistant:write", "chat:write", "im:history"],
      metadata: { webhookSecret: "s", teamId: "T0001", teamName: "Acme" },
    });

    const body = (await (await get(api.baseUrl)).json()) as GetSlackAppResponse;

    expect(body.connected).toBe(true);
    expect(body.teamName).toBe("Acme");
    expect(body.teamId).toBe("T0001");
    // The optional scopes are absent from the stored list.
    expect(body.missingScopes).toEqual(["users:read", "im:write", "files:read", "files:write"]);
  });

  it("reports nothing missing for a credential saved before scopes were recorded", async () => {
    api = await bootTestApi();
    await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", {
      type: "bot_token",
      accessToken: "xoxb-test-token",
      metadata: { webhookSecret: "s", teamId: "T0001" },
    });

    const body = (await (await get(api.baseUrl)).json()) as GetSlackAppResponse;

    expect(body.connected).toBe(true);
    expect(body.missingScopes).toEqual([]);
  });

  it("403s a non-admin", async () => {
    api = await bootTestApi();

    const res = await get(api.baseUrl, "", { "x-valet-test-user-id": "test-member" });

    expect(res.status).toBe(403);
  });
});
