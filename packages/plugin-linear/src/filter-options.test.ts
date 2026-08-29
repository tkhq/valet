import { describe, expect, it } from "vitest";
import type { FilterOptionContext } from "@valet/engine";
import { makeLinearTeamsResolver } from "./filter-options.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

/** A stub fetch that records the request and returns a fixed response. */
function stubFetch(response: Response | (() => Promise<Response>)): { fetch: FetchLike; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return typeof response === "function" ? response() : response;
  };
  return { fetch, calls };
}

function ctx(overrides: Partial<FilterOptionContext>): FilterOptionContext {
  return {
    orgId: "org-1",
    deps: {},
    credential: { type: "oauth2", accessToken: "tok-1" },
    ...overrides,
  };
}

const TEAMS_BODY = {
  data: {
    teams: {
      nodes: [
        { key: "TKAI", name: "Turnkey AI", id: "uuid-tkai" },
        { key: "ENG", name: "Engineering", id: "uuid-eng" },
      ],
    },
  },
};

describe("linear.teams resolver", () => {
  it("maps teams to FilterOption[] with team KEY as id (not uuid)", async () => {
    const { fetch } = stubFetch(jsonResponse(TEAMS_BODY));
    const resolve = makeLinearTeamsResolver(fetch, {} as NodeJS.ProcessEnv);

    const options = await resolve(ctx({}));

    expect(options).toEqual([
      { id: "TKAI", label: "Turnkey AI", hint: "TKAI" },
      { id: "ENG", label: "Engineering", hint: "ENG" },
    ]);
    // The id must be the value the `data.team.key` filter compares against.
    expect(options.map((o) => o.id)).not.toContain("uuid-tkai");
  });

  it("sends a Bearer token to the GraphQL endpoint", async () => {
    const { fetch, calls } = stubFetch(jsonResponse(TEAMS_BODY));
    const resolve = makeLinearTeamsResolver(fetch, { LINEAR_API_URL: "https://fixture.test" } as NodeJS.ProcessEnv);

    await resolve(ctx({ credential: { type: "oauth2", accessToken: "secret" } }));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://fixture.test/graphql");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret");
  });

  it("filters by q against key and name (case-insensitive)", async () => {
    const { fetch } = stubFetch(jsonResponse(TEAMS_BODY));
    const resolve = makeLinearTeamsResolver(fetch, {} as NodeJS.ProcessEnv);

    const byKey = await resolve(ctx({ q: "tkai" }));
    expect(byKey.map((o) => o.id)).toEqual(["TKAI"]);

    const byName = await resolve(ctx({ q: "engineer" }));
    expect(byName.map((o) => o.id)).toEqual(["ENG"]);
  });

  it("returns [] when the credential is null", async () => {
    const { fetch, calls } = stubFetch(jsonResponse(TEAMS_BODY));
    const resolve = makeLinearTeamsResolver(fetch, {} as NodeJS.ProcessEnv);

    const options = await resolve(ctx({ credential: null }));

    expect(options).toEqual([]);
    // A null credential must not reach the network.
    expect(calls).toHaveLength(0);
  });

  it("returns [] when the credential has no accessToken", async () => {
    const { fetch } = stubFetch(jsonResponse(TEAMS_BODY));
    const resolve = makeLinearTeamsResolver(fetch, {} as NodeJS.ProcessEnv);

    const options = await resolve(ctx({ credential: { type: "oauth2" } }));

    expect(options).toEqual([]);
  });

  it("returns [] (never throws) on a non-ok response", async () => {
    const { fetch } = stubFetch(jsonResponse({}, false, 401));
    const resolve = makeLinearTeamsResolver(fetch, {} as NodeJS.ProcessEnv);

    await expect(resolve(ctx({}))).resolves.toEqual([]);
  });

  it("returns [] (never throws) on a network error", async () => {
    const resolve = makeLinearTeamsResolver(
      async () => {
        throw new Error("ECONNREFUSED");
      },
      {} as NodeJS.ProcessEnv,
    );

    await expect(resolve(ctx({}))).resolves.toEqual([]);
  });

  it("tolerates a malformed teams payload and returns []", async () => {
    const { fetch } = stubFetch(jsonResponse({ data: { teams: null } }));
    const resolve = makeLinearTeamsResolver(fetch, {} as NodeJS.ProcessEnv);

    await expect(resolve(ctx({}))).resolves.toEqual([]);
  });
});
