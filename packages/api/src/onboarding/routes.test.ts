import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../env.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { mountOnboardingRoutes, renderOnboardingPage } from "./routes.js";

let api: TestApi | undefined;
afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  vi.unstubAllEnvs();
});

function app(): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  mountOnboardingRoutes(a);
  return a;
}

describe("agent onboarding pages", () => {
  it("fills the instance URL into the setup page and leaves no placeholder", async () => {
    vi.stubEnv("VALET_PUBLIC_URL", "https://valet.example.com/");
    const res = await app().fetch(new Request("http://internal:8787/agent-setup.md"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const text = await res.text();
    expect(text).toContain("valet login https://valet.example.com --name valet");
    expect(text).toContain("https://valet.example.com/agent-skill.md");
    expect(text).not.toContain("{{");
    expect(text).not.toContain("internal:8787");
  });

  it("serves the skill with valid frontmatter and the request origin when no public URL is set", async () => {
    vi.stubEnv("VALET_PUBLIC_URL", "");
    vi.stubEnv("BETTER_AUTH_URL", "");
    const res = await app().fetch(new Request("http://localhost:8799/agent-skill.md"));
    const text = await res.text();
    expect(text.startsWith("---\nname: valet\ndescription: ")).toBe(true);
    expect(text).toContain("Valet runs at http://localhost:8799.");
    expect(text).not.toContain("{{");
  });

  it("strips trailing slashes from the URL", () => {
    expect(renderOnboardingPage("{{VALET_URL}}/x", "https://v.test///")).toBe("https://v.test/x");
  });

  it("is public on an instance with real auth", async () => {
    api = await bootTestApi({ auth: true });
    for (const path of ["/agent-setup.md", "/agent-skill.md"]) {
      const res = await fetch(`${api.baseUrl}${path}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Valet");
    }
  });
});
