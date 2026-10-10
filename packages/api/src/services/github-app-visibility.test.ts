/**
 * `githubAppVisibility`: GitHub's unauthenticated `GET /apps/{slug}` tells a
 * public App (200) from a private one (404). Anything else is unknown. The
 * answer is cached, because `/integrations` asks on every visit.
 */
import { afterEach, describe, expect, it } from "vitest";
import { githubAppVisibility, personalInstallFields, resetGithubAppVisibilityCache } from "./github-app-visibility.js";

afterEach(() => resetGithubAppVisibilityCache());

const ENV: NodeJS.ProcessEnv = { GITHUB_URL: "https://github.example" };
const API = "https://api.github.example";

function fakeGithub(statuses: number[]) {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    const status = statuses[Math.min(requests.length - 1, statuses.length - 1)];
    return new Response(JSON.stringify({}), { status });
  };
  return { requests, fetchImpl };
}

describe("githubAppVisibility", () => {
  it("reads 200 as public and 404 as private, without a credential", async () => {
    const pub = fakeGithub([200]);
    expect(await githubAppVisibility("open-app", ENV, { apiUrl: API, fetchImpl: pub.fetchImpl })).toBe("public");
    const priv = fakeGithub([404]);
    expect(await githubAppVisibility("closed-app", ENV, { apiUrl: API, fetchImpl: priv.fetchImpl })).toBe("private");
    expect(priv.requests[0].url).toBe(`${API}/apps/closed-app`);
    expect(priv.requests[0].headers.has("authorization")).toBe(false);
  });

  it("reads a rate limit, a 5xx, and a network error as unknown", async () => {
    for (const status of [403, 503]) {
      resetGithubAppVisibilityCache();
      const gh = fakeGithub([status]);
      expect(await githubAppVisibility("app", ENV, { apiUrl: API, fetchImpl: gh.fetchImpl })).toBe("unknown");
    }
    resetGithubAppVisibilityCache();
    const failing: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await githubAppVisibility("app", ENV, { apiUrl: API, fetchImpl: failing })).toBe("unknown");
  });

  it("asks GitHub again only after the cached answer expires", async () => {
    let now = 1_000_000;
    const gh = fakeGithub([404, 200]);
    const deps = { apiUrl: API, fetchImpl: gh.fetchImpl, now: () => now };
    expect(await githubAppVisibility("app", ENV, deps)).toBe("private");
    now += 9 * 60 * 1000;
    expect(await githubAppVisibility("app", ENV, deps)).toBe("private");
    expect(gh.requests).toHaveLength(1);
    // The owner made the App public. The next read after 10 minutes sees it.
    now += 2 * 60 * 1000;
    expect(await githubAppVisibility("app", ENV, deps)).toBe("public");
    expect(gh.requests).toHaveLength(2);
  });

  it("retries an unknown answer after one minute", async () => {
    let now = 1_000_000;
    const gh = fakeGithub([503, 200]);
    const deps = { apiUrl: API, fetchImpl: gh.fetchImpl, now: () => now };
    expect(await githubAppVisibility("app", ENV, deps)).toBe("unknown");
    now += 30 * 1000;
    expect(await githubAppVisibility("app", ENV, deps)).toBe("unknown");
    now += 31 * 1000;
    expect(await githubAppVisibility("app", ENV, deps)).toBe("public");
  });
});

describe("personalInstallFields", () => {
  it("gives the link for a public App and a reason otherwise", async () => {
    expect(await personalInstallFields("open-app", ENV, true, { apiUrl: API, fetchImpl: fakeGithub([200]).fetchImpl })).toEqual({
      personalInstallUrl: "https://github.example/apps/open-app/installations/new",
    });
    expect(await personalInstallFields("closed-app", ENV, true, { apiUrl: API, fetchImpl: fakeGithub([404]).fetchImpl })).toEqual({
      personalInstallBlocked: "app_private",
    });
    expect(await personalInstallFields("flaky-app", ENV, true, { apiUrl: API, fetchImpl: fakeGithub([502]).fetchImpl })).toEqual({
      personalInstallBlocked: "app_visibility_unknown",
    });
  });

  it("asks a member who has not connected GitHub to connect first", async () => {
    // Valet binds an installation to the member through that connection.
    expect(await personalInstallFields("open-app", ENV, false, { apiUrl: API, fetchImpl: fakeGithub([200]).fetchImpl })).toEqual({
      personalInstallBlocked: "github_not_connected",
    });
  });
});
