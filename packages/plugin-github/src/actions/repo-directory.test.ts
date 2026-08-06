/**
 * Directory listing over the GitHub contents endpoint. Drives a REAL
 * `Octokit` against a real HTTP fixture (`test-helpers/contents-fixture.ts`),
 * so the page loop is exercised over the wire — the fixture sends no `Link`
 * header, which is exactly why the loop must not use `octokit.paginate`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Octokit } from "octokit";
import {
  startContentsFixture,
  type ContentsFixture,
  type ContentsFixtureHandler,
} from "../test-helpers/contents-fixture.js";
import {
  collectDirectoryEntries,
  wrongPathKindError,
  MAX_DIRECTORY_ENTRIES,
  type ContentsRequest,
} from "./repo-directory.js";

let fixture: ContentsFixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

function dirEntry(name: string, type: "file" | "dir" = "file") {
  return {
    name,
    path: `skills/${name}`,
    type,
    size: type === "dir" ? 0 : name.length,
    sha: `sha-${name}`,
    // Fields the listing must drop — a directory listing is not a file read.
    url: "https://api.github.com/ignored",
    download_url: null,
  };
}

async function requestAgainst(handler: ContentsFixtureHandler): Promise<ContentsRequest> {
  fixture = await startContentsFixture(handler);
  const octokit = new Octokit({ auth: "fixture-token", baseUrl: fixture.url });
  return (params) => octokit.request("GET /repos/{owner}/{repo}/contents/{path}", params);
}

const PARAMS = { owner: "tkhq", repo: "skills", path: "skills" };

describe("collectDirectoryEntries", () => {
  it("returns one level of entries with name, path, type, size, and sha", async () => {
    const request = await requestAgainst(() => ({
      body: [dirEntry("github", "dir"), dirEntry("README.md")],
    }));

    const listing = await collectDirectoryEntries(request, PARAMS, MAX_DIRECTORY_ENTRIES);

    expect(listing.kind).toBe("directory");
    if (listing.kind !== "directory") return;
    expect(listing.complete).toBe(true);
    expect(listing.entries).toEqual([
      { name: "github", path: "skills/github", type: "dir", size: 0, sha: "sha-github" },
      { name: "README.md", path: "skills/README.md", type: "file", size: 9, sha: "sha-README.md" },
    ]);
  });

  it("returns an empty, complete listing for an empty directory", async () => {
    const request = await requestAgainst(() => ({ body: [] }));

    const listing = await collectDirectoryEntries(request, PARAMS, MAX_DIRECTORY_ENTRIES);

    expect(listing).toEqual({ kind: "directory", entries: [], complete: true });
  });

  it("follows pages until a short page, without a Link header", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => dirEntry(`skill-${i}`, "dir"));
    const page2 = [dirEntry("skill-100", "dir")];
    const request = await requestAgainst(({ query }) => ({
      body: query.page === "2" ? page2 : page1,
    }));

    const listing = await collectDirectoryEntries(request, PARAMS, MAX_DIRECTORY_ENTRIES);

    expect(listing.kind).toBe("directory");
    if (listing.kind !== "directory") return;
    expect(listing.entries).toHaveLength(101);
    expect(listing.complete).toBe(true);
    expect(fixture?.calls.map((c) => c.query.page)).toEqual(["1", "2"]);
    expect(fixture?.calls[0]?.query.per_page).toBe("100");
  });

  it("caps the listing and reports it as incomplete", async () => {
    const page = Array.from({ length: 100 }, (_, i) => dirEntry(`skill-${i}`, "dir"));
    const request = await requestAgainst(() => ({ body: page }));

    const listing = await collectDirectoryEntries(request, PARAMS, 3);

    expect(listing.kind).toBe("directory");
    if (listing.kind !== "directory") return;
    expect(listing.entries).toHaveLength(3);
    expect(listing.complete).toBe(false);
    // Stops as soon as the cap is reached — it does not drain the directory.
    expect(fixture?.calls).toHaveLength(1);
  });

  it("reports the path kind when the path is a file, not a directory", async () => {
    const request = await requestAgainst(() => ({
      body: { name: "SKILL.md", path: "skills/github/SKILL.md", type: "file", size: 12, sha: "s" },
    }));

    const listing = await collectDirectoryEntries(request, PARAMS, MAX_DIRECTORY_ENTRIES);

    expect(listing).toEqual({ kind: "not_directory", type: "file" });
  });

  // Only the FIRST page can say what the path is. A later page that comes
  // back as something other than a list is a broken response, and reading it
  // as "this path is a file" would throw away the entries already collected
  // and tell the importer the directory does not exist.
  it("fails loudly when a later page is not a list, instead of discarding the pages read", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => dirEntry(`skill-${i}`, "dir"));
    const request = await requestAgainst(({ query }) => ({
      body: query.page === "2" ? { name: "x", path: "x", type: "file", size: 0, sha: "s" } : page1,
    }));

    await expect(
      collectDirectoryEntries(request, PARAMS, MAX_DIRECTORY_ENTRIES),
    ).rejects.toThrow(/page 2/);
  });

  it("reports a submodule as its own kind, not as a file", async () => {
    const request = await requestAgainst(() => ({
      body: { name: "vendor", path: "vendor", type: "submodule", size: 0, sha: "s" },
    }));

    const listing = await collectDirectoryEntries(request, PARAMS, MAX_DIRECTORY_ENTRIES);

    expect(listing).toEqual({ kind: "not_directory", type: "submodule" });
  });
});

describe("wrongPathKindError", () => {
  it("points a caller who wanted a file at the directory action", () => {
    expect(wrongPathKindError("directory", "file")).toBe(
      "Path is a directory, not a file. Use github.list_repo_directory to list a directory.",
    );
  });

  it("points a caller who wanted a directory at the file action", () => {
    expect(wrongPathKindError("file", "directory")).toBe(
      "Path is a file, not a directory. Use github.read_repo_file to read a file.",
    );
  });

  it("names the kind without a hint when neither action handles it", () => {
    expect(wrongPathKindError("symlink", "file")).toBe("Path is a symlink, not a file.");
    expect(wrongPathKindError("submodule", "directory")).toBe(
      "Path is a submodule, not a directory.",
    );
  });
});
