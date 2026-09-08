import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey, encryptSecret } from "../lib/secret-crypto.js";
import { orgs, githubInstallations } from "../schema/index.js";
import type { GitHubTokenDeps } from "./github-tokens.js";
import { checkRepoExistence } from "./repo-existence.js";

describe("checkRepoExistence", () => {
  let deps: GitHubTokenDeps;
  const request = { orgId: "org", userId: "user", host: "github", fullName: "acme/widgets" };
  const metadata = { full_name: "Acme/Widgets", clone_url: "https://github.com/Acme/Widgets.git" };

  beforeEach(async () => {
    const { appDb, pgdb } = await freshTestPgDb();
    const key = deriveSecretKey("test-key");
    const credentials = new PgCredentialStore(pgdb, key);
    await appDb.insert(orgs).values({ id: "org", name: "Org", createdAt: Date.now() });
    await credentials.save({ type: "org", id: "org" }, "github", { type: "api_key", accessToken: "org-token" });
    await credentials.save({ type: "user", id: "user" }, "github", { type: "api_key", accessToken: "user-token" });
    deps = { db: appDb, credentials, key, apiUrl: "https://fixture.invalid" };
  });

  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("honors user auth and sends one metadata request with a deadline", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(metadata));
    expect(await checkRepoExistence({ ...deps, fetchImpl }, { ...request, auth: "user" })).toEqual({
      kind: "found", fullName: metadata.full_name, cloneUrl: metadata.clone_url,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://fixture.invalid/repos/acme/widgets");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer user-token");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("checks the clone credential when a personal token cannot read the repository", async () => {
    await deps.db.insert(githubInstallations).values({
      id: "installation", orgId: "org", installationId: 123, accountLogin: "acme",
      accountType: "Organization", repositorySelection: "all", suspended: false,
      cachedToken: encryptSecret("app-token", deps.key), cachedTokenExpiresAt: Date.now() + 3_600_000,
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) =>
      new Headers(init?.headers).get("authorization") === "Bearer app-token"
        ? Response.json(metadata) : new Response(null, { status: 404 }));
    expect(await checkRepoExistence({ ...deps, fetchImpl }, request)).toEqual({
      kind: "found", fullName: metadata.full_name, cloneUrl: metadata.clone_url,
    });
    expect(await checkRepoExistence({ ...deps, fetchImpl }, { ...request, auth: "user" })).toMatchObject({
      kind: "not-found",
    });
    await deps.credentials.delete({ type: "org", id: "org" }, "github");
    fetchImpl.mockClear();
    expect(await checkRepoExistence({ ...deps, fetchImpl }, {
      ...request, userId: undefined, fullName: "wrong-org/widgets", allowAnonymous: false,
    })).toEqual({ kind: "unverified" });
    expect(fetchImpl).not.toHaveBeenCalled();
    fetchImpl.mockResolvedValue(new Response(null, { status: 404 }));
    expect(await checkRepoExistence({ ...deps, fetchImpl }, {
      ...request, userId: undefined, fullName: "wrong-org/widgets",
    })).toMatchObject({ kind: "not-found" });
    expect(new Headers(fetchImpl.mock.lastCall?.[1]?.headers).get("authorization")).toBe("Bearer app-token");
  });

  it("allows a credential lookup that does not settle within five seconds", async () => {
    vi.spyOn(deps.credentials, "get").mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    const result = Promise.race([
      checkRepoExistence(deps, request),
      new Promise<string>((resolve) => setTimeout(() => resolve("still blocked"), 6_000)),
    ]);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await result).toEqual({ kind: "unverified" });
  });

  it("uses only org credentials when no requesting user is supplied", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(metadata));
    await checkRepoExistence({ ...deps, fetchImpl }, { ...request, userId: undefined });
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer org-token");
  });

  it.each([200, 404, 503])("checks public access without credentials: %s", async (status) => {
    await deps.credentials.delete({ type: "org", id: "org" }, "github");
    await deps.credentials.delete({ type: "user", id: "user" }, "github");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(metadata, { status }));
    expect(await checkRepoExistence({ ...deps, fetchImpl }, request)).toEqual(status === 200
      ? { kind: "found", fullName: metadata.full_name, cloneUrl: metadata.clone_url }
      : { kind: "unverified" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).has("authorization")).toBe(false);
  });

  it("allows a missing explicit app credential without switching to a user credential", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await checkRepoExistence({ ...deps, fetchImpl }, { ...request, auth: "app" })).toEqual({ kind: "unverified" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a credential lookup failure as unverified", async () => {
    vi.spyOn(deps.credentials, "get").mockRejectedValue(new Error("credential read failed"));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    expect(await checkRepoExistence({ ...deps, fetchImpl }, request)).toEqual({ kind: "unverified" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["TimeoutError", "AbortError", "TypeError"])("allows a request failure: %s", async (name) => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("private upstream detail", name));
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await checkRepoExistence({ ...deps, fetchImpl }, request)).toEqual({ kind: "unverified" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("GitHub request failed"));
    expect(JSON.stringify(log.mock.calls)).not.toContain("private upstream detail");
  });

  it("treats malformed success metadata as unverified", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
    expect(await checkRepoExistence({ ...deps, fetchImpl }, request)).toEqual({ kind: "unverified" });
  });
});
