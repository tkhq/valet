/**
 * Action suites that exercise the real HTTP request each action sends.
 *
 * `startGithubFixture` serves a fake GitHub API on a loopback port and
 * `GITHUB_API_URL` points the plugin's Octokit at it, so these tests assert on
 * the method, path, query, and body the action actually produced — not on a
 * mocked Octokit method name.
 */
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginAction } from "@valet/engine";
import { githubPlugin } from "./actions.js";
import { fakeActionContext } from "../test-helpers/action-context.js";
import { startGithubFixture, type GithubFixture, type GithubFixtureHandlers } from "../test-helpers/github-fixture.js";

const prevGithubApiUrl = process.env.GITHUB_API_URL;
let fixture: GithubFixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  if (prevGithubApiUrl === undefined) delete process.env.GITHUB_API_URL;
  else process.env.GITHUB_API_URL = prevGithubApiUrl;
});

/** Starts the fixture and points the plugin's Octokit at it. */
function useFixture(handlers: GithubFixtureHandlers = {}): GithubFixture {
  fixture = startGithubFixture(handlers);
  process.env.GITHUB_API_URL = fixture.url;
  return fixture;
}

function findAction(id: string): PluginAction {
  const action = githubPlugin.actions.find((a) => a.id === id);
  if (!action) throw new Error(`no action with id ${id}`);
  return action;
}

describe("github action base URL", () => {
  it("sends requests to GITHUB_API_URL when it is set", async () => {
    const server = useFixture();

    const result = await findAction("github.get_repository").execute(
      { owner: "acme", repo: "widgets" },
      fakeActionContext("test-token"),
    );

    expect(result.success).toBe(true);
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /repos/acme/widgets"]);
    expect(server.calls[0].authHeader).toContain("test-token");
  });
});
