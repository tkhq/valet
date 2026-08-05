/**
 * The unauthenticated GitHub reader behind skill sync. Drives the real
 * reader against the shared `startGithubFixture` server, so the request the
 * reader actually sends is what the assertions see — including the absence
 * of an `Authorization` header, which is the whole point of a public-only
 * importer.
 */
import { describe, expect, it, afterEach } from "vitest";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import {
  PublicSkillRepoReader,
  SkillRepoNotFoundError,
  SkillRepoReadError,
} from "./skill-repo-reader.js";

let fixture: GithubFixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function dirEntry(name: string, type: "file" | "dir") {
  return { name, path: name, type, size: 0, sha: `sha-${name}` };
}

describe("PublicSkillRepoReader", () => {
  it("resolves the default branch head in one unauthenticated call", async () => {
    fixture = startGithubFixture({ getCommit: () => ({ body: { sha: "commit-1" } }) });
    const reader = new PublicSkillRepoReader({ apiUrl: fixture.url });

    expect(await reader.headSha("tkhq/skills", "")).toBe("commit-1");

    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.path).toBe("/repos/tkhq/skills/commits/HEAD");
    expect(fixture.calls[0]?.authHeader).toBeUndefined();
  });

  it("resolves the head of a named ref", async () => {
    fixture = startGithubFixture({ getCommit: () => ({ body: { sha: "commit-2" } }) });
    const reader = new PublicSkillRepoReader({ apiUrl: fixture.url });

    expect(await reader.headSha("tkhq/skills", "release")).toBe("commit-2");
    expect(fixture.calls[0]?.path).toBe("/repos/tkhq/skills/commits/release");
  });

  it("names the public-only limit and the fix when the repository 404s", async () => {
    fixture = startGithubFixture({ getCommit: () => ({ status: 404, body: { message: "Not Found" } }) });
    const reader = new PublicSkillRepoReader({ apiUrl: fixture.url });

    const err = await reader.headSha("tkhq/private", "").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SkillRepoNotFoundError);
    expect((err as Error).message).toContain("tkhq/private");
    expect((err as Error).message).toContain("public");
    expect((err as Error).message).toMatch(/spelling|private/);
  });

  it("reports a server fault as a read failure, not as a missing repository", async () => {
    fixture = startGithubFixture({ getCommit: () => ({ status: 500, body: { message: "boom" } }) });
    const reader = new PublicSkillRepoReader({ apiUrl: fixture.url });

    const err = await reader.headSha("tkhq/skills", "").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SkillRepoReadError);
    expect(err).not.toBeInstanceOf(SkillRepoNotFoundError);
  });

  it("lists one level of the root at a pinned commit", async () => {
    fixture = startGithubFixture({
      getContents: () => ({ body: [dirEntry("deploy", "dir"), dirEntry("README.md", "file")] }),
    });
    const reader = new PublicSkillRepoReader({ apiUrl: fixture.url });

    const listing = await reader.listDirectory("tkhq/skills", "", "commit-1");

    expect(listing.entries.map((e) => e.name)).toEqual(["deploy", "README.md"]);
    expect(listing.complete).toBe(true);
    expect(fixture.calls[0]?.path).toBe("/repos/tkhq/skills/contents/");
    expect(fixture.calls[0]?.query.ref).toBe("commit-1");
  });

  it("lists a subdirectory", async () => {
    fixture = startGithubFixture({ getContents: () => ({ body: [dirEntry("deploy", "dir")] }) });
    const reader = new PublicSkillRepoReader({ apiUrl: fixture.url });

    await reader.listDirectory("tkhq/skills", "agent/skills", "commit-1");

    expect(fixture.calls[0]?.path).toBe("/repos/tkhq/skills/contents/agent/skills");
  });

  it("reads a file and decodes its base64 body", async () => {
    fixture = startGithubFixture({
      getContents: () => ({
        body: { type: "file", encoding: "base64", content: base64("# Deploy\n"), sha: "blob-1" },
      }),
    });
    const reader = new PublicSkillRepoReader({ apiUrl: fixture.url });

    expect(await reader.readFile("tkhq/skills", "deploy/SKILL.md", "commit-1")).toBe("# Deploy\n");
  });

  it("returns null for a file that is not there", async () => {
    fixture = startGithubFixture({
      getContents: () => ({ status: 404, body: { message: "Not Found" } }),
    });
    const reader = new PublicSkillRepoReader({ apiUrl: fixture.url });

    expect(await reader.readFile("tkhq/skills", "deploy/SKILL.md", "commit-1")).toBeNull();
  });

  it("returns null when the path is a directory, not a file", async () => {
    fixture = startGithubFixture({ getContents: () => ({ body: [dirEntry("a", "file")] }) });
    const reader = new PublicSkillRepoReader({ apiUrl: fixture.url });

    expect(await reader.readFile("tkhq/skills", "deploy/SKILL.md", "commit-1")).toBeNull();
  });
});
