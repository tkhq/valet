import { afterEach, describe, expect, it } from "vitest";
import { corsOriginResolver } from "./app.js";
import type { AuthConfig } from "./auth/config.js";
import { bootTestApi, type TestApi } from "./integration/_setup.js";

describe("corsOriginResolver", () => {
  it("allows only the auth URL, the public URL and the trusted origins", () => {
    const authConfig: Pick<AuthConfig, "baseUrl" | "trustedOrigins"> = {
      baseUrl: "https://valet.example.com/",
      trustedOrigins: ["http://localhost:5173", "https://sso.example.com"],
    };
    const allow = corsOriginResolver(authConfig, { VALET_PUBLIC_URL: "https://public.example.com/app" });
    for (const origin of ["https://valet.example.com", "https://public.example.com", "http://localhost:5173", "https://sso.example.com"]) {
      expect(allow(origin)).toBe(origin);
    }
    for (const origin of ["https://evil.example", "null", "", "https://valet.example.com.evil.example"]) {
      expect(allow(origin)).toBeNull();
    }
  });

  it("allows the dev web origin and the auth URL in stub mode", () => {
    const allow = corsOriginResolver(undefined, { BETTER_AUTH_URL: "http://localhost:8788" });
    expect(allow("http://localhost:5173")).toBe("http://localhost:5173");
    expect(allow("http://localhost:8788")).toBe("http://localhost:8788");
    expect(allow("https://evil.example")).toBeNull();
  });
});

describe("CORS on the api", () => {
  let api: TestApi | undefined;
  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("grants no credentialed read to a foreign origin", async () => {
    api = await bootTestApi();
    const foreign = await fetch(`${api.baseUrl}/api/health`, { headers: { origin: "https://evil.example" } });
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();

    const dev = await fetch(`${api.baseUrl}/api/health`, { headers: { origin: "http://localhost:5173" } });
    expect(dev.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(dev.headers.get("access-control-allow-credentials")).toBe("true");
  });
});
