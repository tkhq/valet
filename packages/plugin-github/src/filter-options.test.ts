/**
 * Filter-option resolver suite. Like the action suite, these tests point the
 * plugin's Octokit at a loopback fixture through `GITHUB_API_URL`, so they
 * assert on the real request the resolver sends and the `FilterOption[]` it
 * maps back.
 */
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import type { FilterOptionContext, StoredCredential } from "@valet/engine";
import { githubFilterOptionResolvers } from "./filter-options.js";
import { startGithubFixture, type GithubFixture, type GithubFixtureHandlers } from "./test-helpers/github-fixture.js";

const prevGithubApiUrl = process.env.GITHUB_API_URL;
let fixture: GithubFixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  if (prevGithubApiUrl === undefined) delete process.env.GITHUB_API_URL;
  else process.env.GITHUB_API_URL = prevGithubApiUrl;
});

function useFixture(handlers: GithubFixtureHandlers = {}): GithubFixture {
  fixture = startGithubFixture(handlers);
  process.env.GITHUB_API_URL = fixture.url;
  return fixture;
}

function credential(token: string): StoredCredential {
  return { type: "app_install", accessToken: token };
}

function ctx(over: Partial<FilterOptionContext>): FilterOptionContext {
  return {
    orgId: "org-1",
    deps: {},
    credential: credential("test-token"),
    ...over,
  };
}

const reposResolver = githubFilterOptionResolvers["github.repos"];
const branchesResolver = githubFilterOptionResolvers["github.branches"];

describe("github.repos resolver", () => {
  it("maps installation repositories to FilterOption[] on the full name", async () => {
    useFixture({
      listInstallationRepos: () => ({
        body: {
          total_count: 2,
          repositories: [{ full_name: "acme/widgets" }, { full_name: "acme/gadgets" }],
        },
      }),
    });

    const options = await reposResolver(ctx({}));

    expect(options).toEqual([
      { id: "acme/widgets", label: "acme/widgets" },
      { id: "acme/gadgets", label: "acme/gadgets" },
    ]);
  });

  it("filters by the typeahead query, case-insensitively", async () => {
    useFixture({
      listInstallationRepos: () => ({
        body: {
          total_count: 2,
          repositories: [{ full_name: "acme/widgets" }, { full_name: "acme/gadgets" }],
        },
      }),
    });

    const options = await reposResolver(ctx({ q: "WID" }));

    expect(options).toEqual([{ id: "acme/widgets", label: "acme/widgets" }]);
  });

  it("returns [] for a null credential and sends no request", async () => {
    const server = useFixture();

    const options = await reposResolver(ctx({ credential: null }));

    expect(options).toEqual([]);
    expect(server.calls).toHaveLength(0);
  });

  it("returns [] (never throws) when the API rejects the token", async () => {
    useFixture({
      listInstallationRepos: () => ({ status: 401, body: { message: "Bad credentials" } }),
    });

    const options = await reposResolver(ctx({}));

    expect(options).toEqual([]);
  });
});

describe("github.branches resolver", () => {
  it("lists branches for ctx.deps.repo and maps them to FilterOption[]", async () => {
    const server = useFixture({
      listBranches: () => ({ body: [{ name: "main" }, { name: "release/1.x" }] }),
    });

    const options = await branchesResolver(ctx({ deps: { repo: "acme/widgets" } }));

    expect(options).toEqual([
      { id: "main", label: "main" },
      { id: "release/1.x", label: "release/1.x" },
    ]);
    // The resolver splits `owner/name` into the path params.
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /repos/acme/widgets/branches",
    ]);
  });

  it("filters branches by the typeahead query", async () => {
    useFixture({
      listBranches: () => ({ body: [{ name: "main" }, { name: "feature/x" }] }),
    });

    const options = await branchesResolver(ctx({ deps: { repo: "acme/widgets" }, q: "feat" }));

    expect(options).toEqual([{ id: "feature/x", label: "feature/x" }]);
  });

  it("returns [] when ctx.deps.repo is absent and sends no request", async () => {
    const server = useFixture();

    const options = await branchesResolver(ctx({ deps: {} }));

    expect(options).toEqual([]);
    expect(server.calls).toHaveLength(0);
  });

  it("returns [] when ctx.deps.repo is malformed", async () => {
    const server = useFixture();

    const options = await branchesResolver(ctx({ deps: { repo: "no-slash" } }));

    expect(options).toEqual([]);
    expect(server.calls).toHaveLength(0);
  });

  it("returns [] for a null credential", async () => {
    const server = useFixture();

    const options = await branchesResolver(ctx({ deps: { repo: "acme/widgets" }, credential: null }));

    expect(options).toEqual([]);
    expect(server.calls).toHaveLength(0);
  });
});

describe("github filter-option resolver registration", () => {
  it("registers both sources by their catalog `options.source` names", () => {
    expect(Object.keys(githubFilterOptionResolvers).sort()).toEqual(["github.branches", "github.repos"]);
  });
});
