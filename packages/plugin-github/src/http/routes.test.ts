import { afterEach, describe, expect, it, vi } from "vitest";
import { validatePluginHttpRoutes, type PluginHttpRequest } from "@valet/engine";
import type { GithubAppCapability, GithubConnectionCapability, GithubEndpoints } from "./capabilities.js";
import { appCredential, appManifest, appSetup, connectCallback, connectStart, githubHttpRoutes } from "./index.js";

const ENDPOINTS: GithubEndpoints = { githubUrl: "https://github.test", githubApiUrl: "https://api.github.test", publicUrl: null };

function request(url: string, body = ""): PluginHttpRequest {
  return {
    url, headers: {}, params: {}, rawBody: new TextEncoder().encode(body), signal: new AbortController().signal,
  };
}

function refuse(): never {
  throw new Error("This capability is outside the test.");
}

function app(overrides: Partial<GithubAppCapability> = {}): GithubAppCapability {
  return {
    status: refuse, orgName: refuse, signSetupState: refuse, checkCredential: refuse,
    saveApp: refuse, refreshInstallations: refuse, disconnect: refuse, setInstallationApproval: refuse, ...overrides,
  };
}

function connection(overrides: Partial<GithubConnectionCapability> = {}): GithubConnectionCapability {
  return {
    oauthClientId: refuse, signConnectState: refuse, orgStatus: refuse, openCallback: refuse, disconnect: refuse,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub route declarations", () => {
  it("declares valid routes that answer 501 without a host binding", async () => {
    expect(validatePluginHttpRoutes(githubHttpRoutes)).toEqual([]);
    for (const route of githubHttpRoutes) {
      if (route.auth === "signature") throw new Error("GitHub declares no signed ingress routes.");
      const req = request("https://valet.test/x");
      const response = await (route.auth === "public" ? route.handle(req) : route.handle(req, { userId: "u", orgId: "o" }));
      expect(response.status).toBe(501);
    }
  });
});

describe("GitHub App setup", () => {
  it("builds a manual-mode manifest with the legacy App URLs and a host-signed state", async () => {
    const response = await appManifest(
      request("http://127.0.0.1:9/api/plugins/github/http/app/manifest", '{"orgId":"other"}'),
      app({ orgName: async () => "Acme Corp!", signSetupState: () => "signed" }),
      ENDPOINTS,
      ["github.ping", "github.push"],
    );
    expect(await response.json()).toEqual({
      url: "https://github.test/settings/apps/new",
      state: "signed",
      manifest: {
        name: "valet-acme-corp",
        url: "http://127.0.0.1:9",
        redirect_url: "http://127.0.0.1:9/api/org/github-app/setup",
        callback_urls: ["http://127.0.0.1:9/api/me/github/callback"],
        public: true,
        default_events: [],
        default_permissions: {
          contents: "write", metadata: "read", pull_requests: "write", issues: "write",
          actions: "write", checks: "read", statuses: "read",
        },
      },
    });
  });

  it("subscribes a public-mode App to every trigger event except ping", async () => {
    const response = await appManifest(
      request("http://127.0.0.1:9/x", "{}"),
      app({ orgName: async () => "acme", signSetupState: () => "signed" }),
      { ...ENDPOINTS, publicUrl: "https://valet.example" },
      ["github.ping", "github.push", "github.push", "github.pull_request"],
    );
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      manifest: {
        url: "https://valet.example",
        hook_attributes: { url: "https://valet.example/webhooks/github-app" },
        default_events: ["push", "pull_request"],
      },
    });
  });

  it.each([
    ["invalid", 400, "invalid or expired state"],
    ["refused", 403, "Only the org admin who started this GitHub App setup can finish it. Ask an org admin to start the setup again."],
  ] as const)("refuses an %s setup state before calling GitHub", async (status, code, error) => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);
    const response = await appSetup(
      request("https://valet.test/api/org/github-app/setup?code=c&state=s"), { open: async () => ({ status }) }, ENDPOINTS,
    );
    expect(response.status).toBe(code);
    expect(await response.json()).toEqual({ error });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("saves a converted App through the setup grant and redirects to the return origin", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({
      id: 42, slug: "valet-acme", client_id: "Iv1.c", client_secret: "s", webhook_secret: null,
      pem: "-----BEGIN KEY-----", html_url: "https://github.test/apps/valet-acme",
    })));
    const saveApp = vi.fn<GithubAppCapability["saveApp"]>(async () => {});
    const response = await appSetup(
      request("https://valet.test/api/org/github-app/setup?code=c&state=s"),
      { open: async () => ({ status: "open", grant: { returnTo: "http://localhost:5173", saveApp } }) },
      ENDPOINTS,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:5173/settings/organization/github?setup=ok");
    expect(saveApp).toHaveBeenCalledWith({
      appId: "42", appSlug: "valet-acme", oauthClientId: "Iv1.c", htmlUrl: "https://github.test/apps/valet-acme",
      oauthClientSecret: "s", webhookSecret: "", privateKeyPem: "-----BEGIN KEY-----",
    });
  });

  it("refuses a pasted credential GitHub rejects without storing it", async () => {
    const saveApp = vi.fn<GithubAppCapability["saveApp"]>(async () => {});
    const response = await appCredential(
      request("https://valet.test/x", JSON.stringify({ appId: "1", privateKey: "-----BEGIN KEY-----" })),
      app({ checkCredential: async () => ({ ok: false, error: "GitHub rejected this App ID and private key." }), saveApp }),
    );
    expect(response.status).toBe(400);
    expect(saveApp).not.toHaveBeenCalled();
  });
});

describe("GitHub user connection", () => {
  it.each([
    ["invalid", "invalid or expired state"],
    ["other-user", "this authorization was not started by the signed-in user"],
  ] as const)("refuses a %s callback state before calling GitHub", async (status, error) => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);
    const response = await connectCallback(
      request("https://valet.test/api/me/github/callback?code=c&state=s"),
      connection({ openCallback: () => ({ status }) }),
      ENDPOINTS,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("signs only the allow-listed post-auth destination", async () => {
    const signConnectState = vi.fn<GithubConnectionCapability["signConnectState"]>(() => "signed");
    const bound = connection({ oauthClientId: async () => "Iv1.c", signConnectState });
    await connectStart(request("https://valet.test/x", JSON.stringify({ postAuthDestination: "https://evil.test" })), bound, ENDPOINTS);
    await connectStart(request("https://valet.test/x", JSON.stringify({ postAuthDestination: "integrations" })), bound, ENDPOINTS);
    expect(signConnectState.mock.calls).toEqual([[undefined], ["integrations"]]);
  });
});
